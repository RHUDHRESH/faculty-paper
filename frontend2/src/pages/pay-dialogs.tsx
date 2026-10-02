import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, Check, FileText } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { useApi, useApiMutation } from "@/lib/query"
import { MONEY_KEYS } from "@/pages/authorise-dialogs"
import { BankFileButton } from "@/pages/bank-file"
import { BudgetStrip, budgetLine } from "@/pages/budget-strip"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { ClaimThresholdNote } from "@/ui/research-threshold"
import { Details } from "@/ui/section"
import { Callout } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import {
  AmountCell,
  monthKey,
  monthLabel,
  shortDate,
  useBudgetNow,
  type PayoutClaim,
} from "@/pages/pay-parts"

/**
 * The payment dialogs, in one place so the Payments page and Finance's Home
 * open the very same ones: pay one claim, pay a batch. The rules they keep are
 * the server's (docs/ops/safeguards.md): a claim is paid once, the amount is
 * worked out again at the moment of paying, a retry carries its own key, and a
 * row whose amount moved is skipped and named, never paid at the wrong figure.
 */

export type BulkPayResult = {
  paid: number
  paid_ids: string[]
  skipped: { id: string; reason: string }[]
}

const VOUCHER_STORAGE_KEY = "payments:vouchers"

// A 409's message names the recomputed figure in words ("The recomputed
// amount is ₹1,234.56.") because that is all `mark-paid` returns on refusal.
// Reading it back out is the only way to offer a fresh number to confirm
// without resending the stale one or inventing an endpoint that gives one.
function parseRecomputedAmount(message: string | undefined | null): number | null {
  if (!message) return null
  const m = message.match(/₹\s?([\d,]+(?:\.\d+)?)/)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

/** A key made once per dialog and sent on every attempt, so a retry after a timeout finds its own payment. */
export function newRequestKey(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && "randomUUID" in c) return c.randomUUID()
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** What the server asked before the click: the same questions the Pay button will be put to. */
export type PayProblem = { code: string; message: string; paid_month?: string | null; amount?: number | null }
export type PayCheck = { claim_id: string; blocked: boolean; problems: PayProblem[] }

/** The refusals the server sends with a `code`, as the dialog shows them. */
const REFUSALS = ["already_paid", "paid_before", "own_authorisation", "owner_inactive", "own_claim"]

function readVouchers(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(VOUCHER_STORAGE_KEY)
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

function writeVouchers(v: Record<string, string>) {
  try {
    sessionStorage.setItem(VOUCHER_STORAGE_KEY, JSON.stringify(v))
  } catch {
    // A full or disabled sessionStorage only loses the "survive a mis-click"
    // net; it must not stop the reader typing.
  }
}


/* ------------------------------------------------------------------------ */
/* Voucher: is this number already someone else's?                          */
/* ------------------------------------------------------------------------ */

type LedgerHit = { voucher_number: string | null; faculty_name: string | null; staff_id: string | null; claim_id: string | null }

/**
 * Looks the typed voucher up on the ledger, a moment after typing stops. One
 * voucher may cover several claims of one person, so a repeat for the same
 * person is fine; the same number on a different person is the slip worth
 * catching before it is written down twice.
 */
function useVoucherClash(voucher: string, staffId: string | null | undefined, skip = false) {
  const [clash, setClash] = useState<LedgerHit | null>(null)
  useEffect(() => {
    const v = voucher.trim()
    setClash(null)
    if (skip || v.length < 3) return
    let live = true
    const t = window.setTimeout(() => {
      api<{ results: LedgerHit[] }>(`/api/admin/ledger?q=${encodeURIComponent(v)}&limit=20`)
        .then((r) => {
          if (!live) return
          const other = r.results.find(
            (h) => (h.voucher_number ?? "").toLowerCase() === v.toLowerCase() && (h.staff_id ?? "") !== (staffId ?? "")
          )
          setClash(other ?? null)
        })
        .catch(() => {
          // A lookup that fails must never stop a payment; the server is the guard.
        })
    }, 400)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [voucher, staffId, skip])
  return clash
}

function VoucherClash({ clash }: { clash: LedgerHit | null }) {
  if (!clash) return null
  return (
    <p className="flex items-start gap-1.5 text-sm text-caution" role="status">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        This voucher number is already on the ledger for {clash.faculty_name || "someone else"}. Check it is the right
        number before you pay.
      </span>
    </p>
  )
}


/* ------------------------------------------------------------------------ */
/* The checks, in words                                                      */
/* ------------------------------------------------------------------------ */

type Check = { ok: boolean; text: React.ReactNode }

function ChecksList({ checks }: { checks: Check[] }) {
  return (
    <ul className="space-y-1.5 text-sm" aria-label="Checks before paying">
      {checks.map((c, i) => (
        <li key={i} className="flex items-start gap-2">
          {c.ok ? (
            <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
          )}
          <span className={c.ok ? "text-fg-muted" : "text-critical"}>
            <span className="sr-only">{c.ok ? "Passed: " : "Failed: "}</span>
            {c.text}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The three facts a payer must be sure of, read off the row. */
function checksFor(c: PayoutClaim): { checks: Check[]; blocked: boolean } {
  const onLedger = (c.ledger_paid ?? 0) > 0.005
  const checks: Check[] = []
  if (c.ledger_paid != null) {
    checks.push(
      onLedger
        ? {
            ok: false,
            text: `Already paid: ${money(c.ledger_paid)} is on the ledger for this claim. A claim is paid once.`,
          }
        : { ok: true, text: "Not paid before. There is no payment for this claim on the ledger." }
    )
  }
  const who = [
    c.principal_approved_by_name ? `approved by ${c.principal_approved_by_name}` : "approved",
    c.principal_approved_at ? `on ${shortDate(c.principal_approved_at)}` : "",
  ]
    .filter(Boolean)
    .join(" ")
  const auth = [
    c.director_approved_by_name ? `authorised by ${c.director_approved_by_name}` : "authorised by the Director",
    c.director_approved_at ? `on ${shortDate(c.director_approved_at)}` : "",
  ]
    .filter(Boolean)
    .join(" ")
  checks.push({ ok: true, text: `The chain is complete: ${who}, ${auth}.` })
  if (c.second_approved_by_name) {
    checks.push({ ok: true, text: `Second approver: ${c.second_approved_by_name}.` })
  }
  return { checks, blocked: onLedger }
}

/* ------------------------------------------------------------------------ */
/* Single pay                                                                */
/* ------------------------------------------------------------------------ */

/**
 * One payment. The amount shown is whatever the queue displayed; `mark-paid`
 * recomputes it from stored values before it moves anything, so if the two
 * disagree the server answers 409 and nothing is paid. That response carries
 * the new figure only as a sentence, so this reads it back out to offer a
 * fresh, explicit confirm rather than resending the old number.
 */
export function SinglePayDialog({
  claim,
  open,
  onOpenChange,
  onPaid,
}: {
  claim: PayoutClaim
  open: boolean
  onOpenChange: (open: boolean) => void
  onPaid: (id: string) => void
}) {
  const [voucher, setVoucher] = useState("")
  const [phase, setPhase] = useState<"ready" | "changed" | "already" | "sent_back" | "reason">("ready")
  const [refusal, setRefusal] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [requestKey, setRequestKey] = useState(newRequestKey)
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null)
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [changedAmount, setChangedAmount] = useState<number | null>(null)

  const pay = useApiMutation<
    { voucher_number?: string; expected_amount: number; note?: string; idempotency_key: string },
    unknown
  >(`/api/claims/${claim.id}/mark-paid`, { invalidates: MONEY_KEYS })
  const budget = useBudgetNow(open)
  const clash = useVoucherClash(voucher, claim.staff_id, !open)
  // Asked the moment the dialog opens: "already paid in October" is read
  // before the click, not learned from a refusal after it.
  const asked = useApi<PayCheck>(["pay-check", claim.id], `/api/claims/${claim.id}/pay-check`, {
    enabled: open,
    staleTime: 0,
  })
  const problems = asked.data?.problems ?? []
  const own = checksFor(claim)
  const checks: Check[] = [...own.checks, ...problems.map((p) => ({ ok: false, text: p.message }))]
  const blocked = own.blocked || Boolean(asked.data?.blocked)

  useEffect(() => {
    if (open) {
      setVoucher("")
      setPhase("ready")
      setRefusal(null)
      setNote("")
      setRequestKey(newRequestKey())
      setChangedMessage(null)
      setChangedAmount(null)
    }
  }, [open])

  async function submit(expectedAmount: number) {
    setConfirmedAmount(expectedAmount)
    try {
      await pay.mutateAsync({
        voucher_number: voucher.trim() || undefined,
        expected_amount: expectedAmount,
        note: note.trim() || undefined,
        idempotency_key: requestKey,
      })
      toast.stamp("Paid", `${money(expectedAmount)} to ${claim.owner_name}${claim.ticket_number ? `, ${claim.ticket_number}` : ""}.`)
      onOpenChange(false)
      onPaid(claim.id)
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: string } | null)?.code : undefined
      if (err instanceof ApiError && code === "amount_changed") {
        // Committed on the server: the claim is already back with the Principal.
        setRefusal(err.message)
        setPhase("sent_back")
      } else if (err instanceof ApiError && code === "reason_needed") {
        setRefusal(err.message)
        setPhase("reason")
      } else if (err instanceof ApiError && code && REFUSALS.includes(code)) {
        setRefusal(err.message)
        setPhase("already")
      } else if (err instanceof ApiError && err.status === 409) {
        setChangedMessage(err.message)
        setChangedAmount(parseRecomputedAmount(err.message))
        setPhase("changed")
      } else if (err instanceof ApiError && err.status === 400 && /invalid status|already processed/i.test(err.message)) {
        // The server refuses anything no longer Director-authorised or already
        // on the ledger; from this screen that means somebody has paid it.
        setPhase("already")
      } else {
        toast.fail(err)
      }
    }
  }

  const amount = claim.remuneration
  const zero = amount != null && amount <= 0.005

  return (
    <Dialog open={open} onOpenChange={(o) => (!pay.isPending || o) && onOpenChange(o)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Pay this claim?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {paperTitle(claim.paper_title)}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {(phase === "ready" || phase === "reason") && (
            <>
              <div>
                <p className="figure text-figure tabular">{money(amount)}</p>
                <Meta className="mt-1 block">
                  {[claim.staff_id ? `Staff id ${claim.staff_id}` : null, claim.ticket_number, `Paid in ${monthLabel(monthKey(claim))}`]
                    .filter(Boolean)
                    .join(" · ")}
                </Meta>
              </div>
              <ClaimThresholdNote c={claim} />
              {!zero && amount != null && (
                <div className="space-y-2">
                  <p className="text-base">{budgetLine(budget.data, "paying", false) ?? " "}</p>
                  <BudgetStrip budget={budget.data?.college} batch={amount} batchLabel="This claim" compact />
                </div>
              )}
              {zero && (
                <p className="text-sm text-fg-muted">
                  Nothing goes to the bank. The claim is marked paid so it is closed, and it stays out of the bank file.
                </p>
              )}
              <ChecksList checks={checks} />
              <Field label="Voucher number" hint="Optional. It appears on the payment statement and in the ledger.">
                <Input value={voucher} onChange={(e) => setVoucher(e.target.value)} />
              </Field>
              <VoucherClash clash={clash} />
              {phase === "reason" && (
                <Field label="Why you are paying this" hint={refusal ?? "It goes to the audit trail with your name."}>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              )}
            </>
          )}

          {phase === "already" && (
            <Callout tone="critical" title={refusal ? "Not paid" : "Already paid"}>
              <p>{refusal ?? "This claim has already been paid, and a claim is paid once."}</p>
              <p className="mt-1">Nothing was paid again.</p>
            </Callout>
          )}

          {phase === "sent_back" && (
            <Callout tone="caution" title="Sent back to the Principal">
              <p>{refusal}</p>
            </Callout>
          )}

          {phase === "changed" && (
            <Callout tone="caution" title="The amount changed since this screen was drawn">
              <p>You confirmed {money(confirmedAmount)}.</p>
              <p className="mt-1">{changedMessage}</p>
              {changedAmount != null ? (
                <p className="mt-2">Nothing has been paid. Confirm the new figure, {money(changedAmount)}, to try again.</p>
              ) : (
                <p className="mt-2">
                  Nothing has been paid. Close this and reopen it from the list to see the fresh figure before trying
                  again.
                </p>
              )}
            </Callout>
          )}
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={pay.isPending}>
            Cancel
          </Button>
          {phase === "changed" ? (
            <Button
              kind="primary"
              disabled={changedAmount == null || pay.isPending}
              onClick={() => changedAmount != null && void submit(changedAmount)}
            >
              {pay.isPending ? "Paying…" : `Pay ${changedAmount != null ? money(changedAmount) : ""}`.trim()}
            </Button>
          ) : phase === "already" || phase === "sent_back" ? null : (
            <Button
              kind="primary"
              disabled={
                amount == null || blocked || pay.isPending || (phase === "reason" && note.trim().length < 10)
              }
              onClick={() => amount != null && void submit(amount)}
            >
              {pay.isPending ? "Paying…" : `Pay ${amount != null ? money(amount) : ""}`.trim()}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Bulk pay                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * A batch paid in one action instead of two hundred dialogs. Every row still
 * goes through the full single-payment guards on the server; a row whose
 * amount drifted is skipped, never paid at the wrong figure, and each skip is
 * named with its reason rather than folded into a bare count.
 *
 * After it, the screen says what to do next: the month's bank file and the
 * statement to sign, one tap away. Finance used to be left at a closed dialog
 * and had to remember where the file lived.
 *
 * Vouchers persist to `sessionStorage` while this is open, keyed by claim id,
 * so a mis-click on the overlay or the Escape key does not erase twenty
 * minutes of typing. Entries for rows this batch paid are cleared on success;
 * a skipped row keeps its typed voucher so retrying does not mean retyping.
 */
export function BulkPayDialog({
  open,
  onOpenChange,
  rows: selectedRows,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: PayoutClaim[]
  onDone: (paidIds: string[]) => void
}) {
  // The batch as it was when confirmed: paying clears the page selection, and
  // the result must still say "of 12" and list the rows it paid or skipped.
  const [frozen, setFrozen] = useState<PayoutClaim[] | null>(null)
  // The voucher numbers sent, kept for the result: a paid row forgets its
  // remembered number, but the reader still wants to see which one it got.
  const [sent, setSent] = useState<Record<string, string>>({})
  const rows = frozen ?? selectedRows
  const [vouchers, setVouchers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<BulkPayResult | null>(null)
  const [paidRows, setPaidRows] = useState<PayoutClaim[]>([])
  const [prefix, setPrefix] = useState(() => `PV-${new Date().getFullYear()}-`)
  const [start, setStart] = useState("1")
  const [batchKey, setBatchKey] = useState(newRequestKey)
  const budget = useBudgetNow(open)

  useEffect(() => {
    if (open) {
      setBatchKey(newRequestKey())
      setVouchers(readVouchers())
      setResult(null)
      setPaidRows([])
      setFrozen(null)
    }
  }, [open])

  function setVoucher(id: string, value: string) {
    setVouchers((prev) => {
      const next = { ...prev, [id]: value }
      writeVouchers(next)
      return next
    })
  }

  const bulkPay = useApiMutation<
    { items: { claim_id: string; voucher_number?: string; expected_amount: number }[]; idempotency_key: string },
    BulkPayResult
  >("/api/admin/bulk-mark-paid", { invalidates: MONEY_KEYS })

  async function confirm() {
    const items = rows.map((c) => ({
      claim_id: c.id,
      voucher_number: vouchers[c.id]?.trim() || undefined,
      expected_amount: c.remuneration ?? 0,
    }))
    try {
      setFrozen(rows)
      setSent({ ...vouchers })
      const r = await bulkPay.mutateAsync({ items, idempotency_key: batchKey })
      setResult(r)
      setPaidRows(rows.filter((c) => r.paid_ids.includes(c.id)))
      // Only the rows actually paid lose their remembered voucher.
      const next = { ...vouchers }
      for (const id of r.paid_ids) delete next[id]
      setVouchers(next)
      writeVouchers(next)
      onDone(r.paid_ids)
      toast.stamp(
        "Paid",
        `${formatCount(r.paid)} ${r.paid === 1 ? "claim" : "claims"}, ${money(
          rows.filter((c) => r.paid_ids.includes(c.id)).reduce((s, c) => s + (c.remuneration || 0), 0)
        )}.`
      )
    } catch (err) {
      setFrozen(null)
      toast.fail(err)
    }
  }

  const total = rows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const months = [...new Set(rows.map((c) => monthKey(c)))].sort()
  const absorbing = rows.filter((c) => (c.threshold_absorbed ?? 0) > 0.005)
  const heldBack = absorbing.reduce((s, c) => s + (c.threshold_absorbed || 0), 0)
  const zeros = rows.filter((c) => (c.remuneration || 0) <= 0.005)
  const alreadyOnLedger = rows.filter((c) => (c.ledger_paid ?? 0) > 0.005)

  // The same voucher against two different people inside this batch.
  const clashes = useMemo(() => {
    const byNo = new Map<string, Set<string>>()
    for (const c of rows) {
      const v = (vouchers[c.id] ?? "").trim().toLowerCase()
      if (!v) continue
      byNo.set(v, (byNo.get(v) ?? new Set()).add(c.staff_id || c.owner_name))
    }
    return new Set([...byNo.entries()].filter(([, who]) => who.size > 1).map(([v]) => v))
  }, [rows, vouchers])

  /** Fill every empty voucher, in the order shown, from prefix + a running number. */
  function numberBlanks() {
    let n = Number.parseInt(start, 10)
    if (!Number.isFinite(n)) n = 1
    const next = { ...vouchers }
    for (const c of rows) {
      if (!next[c.id]?.trim()) next[c.id] = `${prefix}${n++}`
    }
    setVouchers(next)
    writeVouchers(next)
    setStart(String(n))
  }

  const columns: Column<PayoutClaim>[] = [
    {
      key: "claim",
      header: "Claim",
      cell: (c) => {
        const skip = result?.skipped.find((s) => s.id === c.id)
        const paid = result?.paid_ids.includes(c.id)
        return (
          <div className="min-w-0">
            <span className="block break-words">{paperTitle(c.paper_title)}</span>
            <Meta className="block">
              {c.owner_name}
              {c.ticket_number ? ` · ${c.ticket_number}` : ""}
            </Meta>
            {skip && <p className="mt-1 text-xs text-critical">Not paid: {skip.reason}</p>}
            {paid && <p className="mt-1 text-xs text-positive">Paid</p>}
          </div>
        )
      },
    },
    {
      key: "voucher",
      header: "Voucher number",
      className: "w-44",
      empty: "None",
      cell: (c) => {
        const paid = result?.paid_ids.includes(c.id)
        const v = (vouchers[c.id] ?? "").trim()
        return paid ? (
          (sent[c.id] ?? "").trim() || null
        ) : (
          <Input
            value={vouchers[c.id] ?? ""}
            onChange={(e) => setVoucher(c.id, e.target.value)}
            placeholder="Optional"
            aria-label={`Voucher number for ${c.owner_name}`}
            aria-invalid={clashes.has(v.toLowerCase()) || undefined}
          />
        )
      },
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      className: "w-52",
      cell: (c) => <AmountCell c={c} />,
    },
  ]

  const paidTotal = paidRows.reduce((s, c) => s + (c.remuneration || 0), 0)
  const paidMonths = [...new Set(paidRows.filter((c) => (c.remuneration || 0) > 0.005).map((c) => monthKey(c)))].sort()

  return (
    <Dialog open={open} onOpenChange={(o) => (!bulkPay.isPending || o) && onOpenChange(o)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {result
              ? `Paid ${formatCount(result.paid)} of ${formatCount(rows.length)}`
              : `Pay ${formatCount(rows.length)} ${rows.length === 1 ? "claim" : "claims"}?`}
          </DialogTitle>
          <DialogDescription>
            {result
              ? result.skipped.length === 0
                ? `Every claim in this batch was paid. ${money(paidTotal)} in all.`
                : "The rest were skipped, each for its own reason, below. Nothing was paid at a wrong figure."
              : `Paid in ${months.map((m) => monthLabel(m)).join(", ")}. A claim whose amount has moved is skipped, not paid at the wrong number.`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {!result && (
            <>
              <div>
                <p className="figure text-figure tabular">{money(total)}</p>
                <p className="mt-1 text-sm text-fg-muted">
                  across {formatCount(rows.length)} {rows.length === 1 ? "claim" : "claims"}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-base">{budgetLine(budget.data, "paying", rows.length !== 1) ?? " "}</p>
                <BudgetStrip budget={budget.data?.college} batch={total} batchLabel="This run" compact />
              </div>
              <ChecksList
                checks={[
                  alreadyOnLedger.length > 0
                    ? {
                        ok: false,
                        text: `${formatCount(alreadyOnLedger.length)} of these already ${
                          alreadyOnLedger.length === 1 ? "has" : "have"
                        } a payment on the ledger. The server will skip ${alreadyOnLedger.length === 1 ? "it" : "them"}.`,
                      }
                    : { ok: true, text: "None of these has a payment on the ledger yet, so none is paid twice." },
                  clashes.size > 0
                    ? {
                        ok: false,
                        text: `${formatCount(clashes.size)} voucher ${
                          clashes.size === 1 ? "number is" : "numbers are"
                        } used for different people in this batch. Check ${clashes.size === 1 ? "it" : "them"} before paying.`,
                      }
                    : { ok: true, text: "No voucher number is used for two different people." },
                ]}
              />
              {absorbing.length > 0 && (
                <p className="text-sm text-fg-muted">
                  {formatCount(absorbing.length)} research-faculty {absorbing.length === 1 ? "claim is" : "claims are"}{" "}
                  reduced by the research threshold; {money(heldBack)} is held back and not paid.
                </p>
              )}
              {zeros.length > 0 && (
                <p className="text-sm text-fg-muted">
                  {formatCount(zeros.length)} {zeros.length === 1 ? "claim comes" : "claims come"} to ₹0. They are
                  closed as paid and left out of the bank file.
                </p>
              )}
              <Details label="voucher numbering" className="text-sm">
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Voucher prefix" className="w-40">
                    <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
                  </Field>
                  <Field label="Next number" className="w-28">
                    <Input
                      value={start}
                      inputMode="numeric"
                      onChange={(e) => setStart(e.target.value.replace(/[^0-9]/g, ""))}
                    />
                  </Field>
                  <Button kind="default" onClick={numberBlanks}>
                    Number the empty ones
                  </Button>
                </div>
                <Meta className="mt-1 block">Numbers you have already typed are left as they are.</Meta>
              </Details>
            </>
          )}

          {result && paidMonths.length > 0 && (
            <div className="space-y-3">
              <p className="text-base font-medium">Now the month's paper</p>
              <ul className="divide-y divide-line">
                {paidMonths.map((m) => (
                  <li key={m} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <span className="font-medium">{monthLabel(m)}</span>
                    <span className="flex flex-wrap gap-2">
                      <BankFileButton month={m} />
                      <Button kind="primary" asChild>
                        <a href={`/api/payouts/statement.pdf?month=${m}`} download>
                          <FileText />
                          Statement to sign (PDF)
                        </a>
                      </Button>
                      <Button kind="default" asChild>
                        <Link to={`/statements?month=${m}`} onClick={() => onOpenChange(false)}>
                          Open the statement
                        </Link>
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
              <Details label="what is in the bank file" className="text-sm">
                <p className="max-w-prose text-fg-muted">
                  One row for each payment, the amount and a narration. It has no account numbers or IFSC codes: the app
                  holds none, so Accounts adds them from the payroll master. A claim that comes to ₹0 is left out.
                </p>
              </Details>
            </div>
          )}

          {result && result.skipped.length === 0 ? (
            <Details label="the claims paid" count={rows.length} className="text-sm">
              <Table rows={rows} columns={columns} getKey={(c) => c.id} caption="Claims in this batch" maxHeight="20rem" />
            </Details>
          ) : (
            <Table rows={rows} columns={columns} getKey={(c) => c.id} caption="Claims in this batch" maxHeight="24rem" />
          )}
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={bulkPay.isPending}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button kind="primary" disabled={bulkPay.isPending || rows.length === 0} onClick={() => void confirm()}>
              {bulkPay.isPending
                ? "Paying…"
                : `Pay ${formatCount(rows.length)} ${rows.length === 1 ? "claim" : "claims"}, ${money(total)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
