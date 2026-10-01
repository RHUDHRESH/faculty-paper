import { useEffect, useMemo, useState } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { AlertTriangle, Banknote, Check, Download, FileText } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { api, ApiError } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ComingUp } from "@/ui/coming-up"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, Field, Input } from "@/ui/field"
import { OwnPapersNote } from "@/ui/own-papers"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { ClaimThresholdNote } from "@/ui/research-threshold"
import { Details, Rows, Section } from "@/ui/section"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column, type SortDir } from "@/ui/table"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import {
  AmountCell,
  Claimant,
  ErpLegend,
  isPayable,
  isPayableTotals,
  monthKey,
  monthLabel,
  PAYABLE_LIMIT,
  payableKey,
  payablePath,
  payableTotalsOf,
  PaperCell,
  shortDate,
  useBudgetNow,
  waitingLabel,
  type PayableTotals,
  type PayoutClaim,
  type PayoutsPage,
} from "@/pages/pay-parts"

export { PaymentsDone } from "@/pages/payments-done"

/**
 * Where money leaves the college: the claims the Director has authorised,
 * waiting on a voucher and a decision.
 *
 * The figure a reader confirms has to be the figure the server has just
 * recomputed from its own stored, checked columns. `mark-paid` never calls
 * Scopus, so a payment is never blocked by an outage, and that is also why the
 * amount on screen can drift from a formula change or a second approval that
 * landed between page-load and click. A 409 means it moved: this screen shows
 * both figures and refuses to resend the stale one, on a single payment and on
 * any row a batch skips.
 *
 * "Pay the right amount once" is a property the server enforces (a claim with
 * a positive net on the ledger cannot be paid again). The screen makes it
 * visible: each payment dialog lists the checks in words before the button
 * can be pressed, and says so when one fails.
 */

type BulkPayResult = {
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
/* Why a claim cannot be paid yet                                            */
/* ------------------------------------------------------------------------ */

// Never names the cause beyond "high value": the other cause of a second
// signature is a review flag, and Finance never sees flags.
function heldReason(c: PayoutClaim): string {
  if (c.calc_error) return "No amount could be worked out for this claim. The research cell can correct it."
  const clearedBy = c.cleared_by_name || "the person who cleared it"
  return `Needs a second approver, someone other than ${clearedBy}. The research cell or a super admin can give it.`
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
/* Payments — the payable queue                                              */
/* ------------------------------------------------------------------------ */

type SortKey = "waiting" | "amount"

export function Payments() {
  const { me } = useAuth()
  const allowed = can(me?.role).pay
  const location = useLocation()

  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  function goToPage(next: number) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next > 0) params.set("page", String(next))
      else params.delete("page")
      return params
    })
  }

  const { data, isLoading, isError, refetch } = useApi<PayoutsPage>(payableKey(page), payablePath(page), {
    enabled: allowed,
    placeholderData: (prev) => prev,
    refetchOnWindowFocus: true,
  })
  const budget = useBudgetNow(allowed)

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const totals: PayableTotals = isPayableTotals(data?.totals) ? data.totals : payableTotalsOf(rows)

  const ready = useMemo(() => rows.filter(isPayable), [rows])
  const held = useMemo(() => rows.filter((c) => !isPayable(c)), [rows])

  // Full rows, not ids: a review two pages on still needs the title and amount
  // of a row selected on page one.
  const [selected, setSelected] = useState<Map<string, PayoutClaim>>(new Map())
  const [payId, setPayId] = useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "waiting", dir: "desc" })

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1
    const val = (c: PayoutClaim) => (sort.key === "amount" ? c.remuneration || 0 : c.waiting_days ?? 0)
    return ready.slice().sort((a, b) => (val(a) - val(b)) * dir)
  }, [ready, sort])

  // A link on the answer strip to a part of this page has to scroll there.
  useEffect(() => {
    if (!location.hash) return
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" })
  }, [location.hash, data])

  function toggleSelected(c: PayoutClaim) {
    if (!isPayable(c)) return
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }

  const allVisibleSelected = ready.length > 0 && ready.every((c) => selected.has(c.id))
  const someVisibleSelected = ready.some((c) => selected.has(c.id))
  // Anything selected at all, not just on the page in view: the selection
  // survives paging, so the bar that shows it must too.
  const anySelected = selected.size > 0
  const selectedOffPage = selected.size - ready.filter((c) => selected.has(c.id)).length
  const selectedRows = [...selected.values()]
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const payClaim = payId ? (rows.find((c) => c.id === payId) ?? selected.get(payId) ?? null) : null

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="Only Finance can see or process payments."
        />
      </div>
    )
  }

  const columns: Column<PayoutClaim>[] = [
    {
      key: "select",
      header: (
        <Checkbox
          checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
          disabled={ready.length === 0}
          onCheckedChange={() =>
            setSelected((prev) => {
              const next = new Map(prev)
              if (allVisibleSelected) for (const c of ready) next.delete(c.id)
              else for (const c of ready) next.set(c.id, c)
              return next
            })
          }
          aria-label={allVisibleSelected ? "Deselect all" : `Select all ${ready.length} ready claims`}
        />
      ),
      label: "Select",
      className: "w-10",
      cell: (c) => (
        <Checkbox
          checked={selected.has(c.id)}
          onCheckedChange={() => toggleSelected(c)}
          aria-label={`Select ${c.paper_title || "this claim"}`}
        />
      ),
    },
    { key: "claimant", header: "Paid to", className: "w-52", cell: (c) => <Claimant c={c} /> },
    { key: "paper", header: "Paper", cell: (c) => <PaperCell c={c} /> },
    {
      key: "month",
      header: "Month paid",
      className: "w-28 whitespace-nowrap",
      cell: (c) => monthLabel(monthKey(c), true),
    },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      sortable: true,
      className: "w-24",
      cell: (c) => (
        <span className={(c.waiting_days ?? 0) > 7 ? "text-caution" : undefined}>{waitingLabel(c.waiting_days)}</span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      sortable: true,
      className: "w-52",
      cell: (c) => <AmountCell c={c} />,
    },
    {
      key: "pay",
      header: "Action",
      label: "Pay",
      className: "w-20",
      cell: (c) => (
        <Button kind="default" size="sm" onClick={() => setPayId(c.id)}>
          Pay
        </Button>
      ),
    },
  ]

  const remaining = budget.data?.college.remaining ?? null
  const over = remaining != null && remaining < 0

  return (
    <div className="page space-y-8">
      <PageHeader
        title="Payments"
        sub={
          <>
            Claims the Director has authorised. Each is paid once, at the amount worked out again when you pay it.
            <OwnPapersNote className="mt-1" />
          </>
        }
        action={
          <Button kind="default" size="sm" asChild>
            <Link to="/payments/done">See what has been paid</Link>
          </Button>
        }
        spot="spot-payouts"
      />

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={56} />
      ) : isError ? (
        <ErrorState
          title="Could not load payments"
          message="The server did not answer. Nothing has been paid or lost."
          onRetry={() => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          guide="pay-claims"
          art="nothing-paid"
          icon={Banknote}
          title="Nothing waiting on Finance"
          message="Every claim the Director has authorised has been paid. The next one appears here the moment it is authorised."
          action={<ComingUp desk="finance" />}
        />
      ) : (
        <>
          <div className="space-y-3">
            <Answer
              items={[
                {
                  label: "Ready to pay",
                  value: totals.ready_count,
                  zero: "Nothing is ready to pay",
                  to: "/payments#ready",
                },
                { label: "Comes to", value: money(totals.ready_amount) },
                {
                  label: "Held up",
                  value: totals.held_count,
                  zero: "Nothing is held up",
                  tone: "caution",
                  to: totals.held_count ? "/payments#held" : undefined,
                },
                ...(budget.isError
                  ? []
                  : [
                      budget.data
                        ? {
                            label: over ? "Over the budget once these are paid" : "Left in the budget once these are paid",
                            value: remaining == null ? "Not set" : money(Math.abs(remaining)),
                            tone: over ? ("critical" as const) : undefined,
                            to: "/budget",
                          }
                        : { label: "Left in the budget", value: null },
                    ]),
              ]}
            />
            {totals.held_back_count > 0 && (
              <p className="max-w-prose text-sm text-fg-muted">
                {totals.held_back_count > 0 && (
                  <>
                    The research threshold holds back {money(totals.held_back)} on {formatCount(totals.held_back_count)}{" "}
                    {totals.held_back_count === 1 ? "claim" : "claims"}; those are marked in the list.
                  </>
                )}
              </p>
            )}
          </div>

          {anySelected && (
            <div
              role="region"
              aria-label="Selected claims"
              className="sticky top-14 z-20 flex flex-wrap items-center justify-between gap-3 rounded-panel bg-accent-wash px-4 py-3 shadow-under md:top-2"
            >
              <p className="text-sm">
                <span className="font-semibold">{formatCount(selected.size)}</span> selected ·{" "}
                <span className="font-semibold tabular">{money(selectedTotal)}</span>
                {selectedOffPage > 0 ? (
                  <span className="text-fg-muted">
                    {" "}
                    · {formatCount(selectedOffPage)} on {selectedOffPage === 1 ? "another page" : "other pages"}
                  </span>
                ) : null}
              </p>
              <div className="flex items-center gap-2">
                <Button kind="quiet" size="sm" onClick={() => setSelected(new Map())}>
                  Clear selection
                </Button>
                <Button kind="primary" size="sm" onClick={() => setBulkOpen(true)}>
                  Pay {formatCount(selected.size)} {selected.size === 1 ? "claim" : "claims"}
                </Button>
              </div>
            </div>
          )}

          <Section
            id="ready"
            title={`Ready to pay (${formatCount(ready.length)})`}
            sub={
              ready.length > 0
                ? "Tick the claims for one batch, or pay one at a time. Payments are recorded in the month shown."
                : undefined
            }
            action={
              ready.length > 1 && !allVisibleSelected ? (
                <Button
                  kind="quiet"
                  size="sm"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Map(prev)
                      for (const c of ready) next.set(c.id, c)
                      return next
                    })
                  }
                >
                  Select all {formatCount(ready.length)}
                </Button>
              ) : undefined
            }
            className="scroll-mt-4"
          >
            <Table
              rows={sorted}
              columns={columns}
              getKey={(c) => c.id}
              minWidth="60rem"
              caption="Claims ready to pay"
              sortKey={sort.key}
              sortDir={sort.dir}
              onSort={(k) =>
                setSort((s) => ({ key: k as SortKey, dir: s.key === k && s.dir === "desc" ? "asc" : "desc" }))
              }
              empty={{
                icon: Banknote,
                title: "Nothing is ready to pay",
                message: "Every authorised claim is waiting on something, listed below.",
              }}
            />
            <div className="mt-2">
              <ErpLegend rows={rows} />
            </div>
          </Section>

          {held.length > 0 && (
            <Section
              id="held"
              title={`Held up (${formatCount(held.length)})`}
              sub="Authorised, but the server will not let these be paid yet. Nothing here can be selected."
              className="scroll-mt-4"
            >
              <Rows>
                {held.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-start gap-x-6 gap-y-2 py-3">
                    <div className="min-w-0 flex-1 basis-72">
                      <PaperCell c={c} />
                      <p className="mt-1 text-sm text-caution">{heldReason(c)}</p>
                    </div>
                    <div className="w-56 shrink-0">
                      <Claimant c={c} />
                    </div>
                    <div className="w-32 shrink-0">
                      <AmountCell c={c} />
                    </div>
                  </li>
                ))}
              </Rows>
            </Section>
          )}

          <Pagination page={page} pageSize={PAYABLE_LIMIT} total={total} onChange={goToPage} />

          <Details label="how a payment is checked" className="text-sm">
            <ul className="max-w-prose list-disc space-y-1 pl-5 text-fg-muted">
              <li>A claim is paid once. If it already has a payment on the ledger, the server refuses a second.</li>
              <li>
                The amount is worked out again from the checked figures at the moment you pay. If it moved, nothing is
                paid and you see both figures.
              </li>
              <li>Nobody pays their own paper.</li>
              <li>
                If a payment goes out in error, a super admin undoes it. That writes a balancing row on the ledger and
                nothing is deleted.
              </li>
            </ul>
          </Details>
        </>
      )}

      {payClaim && (
        <SinglePayDialog
          claim={payClaim}
          open={!!payId}
          onOpenChange={(o) => !o && setPayId(null)}
          onPaid={(id) => {
            setSelected((prev) => {
              if (!prev.has(id)) return prev
              const next = new Map(prev)
              next.delete(id)
              return next
            })
          }}
        />
      )}

      <BulkPayDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        rows={selectedRows}
        onDone={(paidIds) => {
          setSelected((prev) => {
            const next = new Map(prev)
            for (const id of paidIds) next.delete(id)
            return next
          })
        }}
      />
    </div>
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
function SinglePayDialog({
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
  const [phase, setPhase] = useState<"ready" | "changed" | "already">("ready")
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null)
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [changedAmount, setChangedAmount] = useState<number | null>(null)

  const pay = useApiMutation<{ voucher_number?: string; expected_amount: number }, unknown>(
    `/api/claims/${claim.id}/mark-paid`,
    { invalidates: [...CHAIN] }
  )
  const clash = useVoucherClash(voucher, claim.staff_id, !open)
  const { checks, blocked } = checksFor(claim)

  useEffect(() => {
    if (open) {
      setVoucher("")
      setPhase("ready")
      setChangedMessage(null)
      setChangedAmount(null)
    }
  }, [open])

  async function submit(expectedAmount: number) {
    setConfirmedAmount(expectedAmount)
    try {
      await pay.mutateAsync({ voucher_number: voucher.trim() || undefined, expected_amount: expectedAmount })
      toast.ok(`Paid ${money(expectedAmount)} to ${claim.owner_name}${claim.ticket_number ? `, ${claim.ticket_number}` : ""}`)
      onOpenChange(false)
      onPaid(claim.id)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
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
          {phase === "ready" && (
            <>
              <div>
                <p className="figure text-3xl">{money(amount)}</p>
                <Meta className="mt-1 block">
                  {[claim.staff_id ? `Staff id ${claim.staff_id}` : null, claim.ticket_number, `Paid in ${monthLabel(monthKey(claim))}`]
                    .filter(Boolean)
                    .join(" · ")}
                </Meta>
              </div>
              <ClaimThresholdNote c={claim} />
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
            </>
          )}

          {phase === "already" && (
            <Callout tone="caution" title="Already paid">
              This claim has already been paid, and a claim is paid once. Nothing was paid again. It is listed under
              what has been paid.
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
          ) : phase === "already" ? null : (
            <Button
              kind="primary"
              disabled={amount == null || blocked || pay.isPending}
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
function BulkPayDialog({
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

  useEffect(() => {
    if (open) {
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
    { items: { claim_id: string; voucher_number?: string; expected_amount: number }[] },
    BulkPayResult
  >("/api/admin/bulk-mark-paid", { invalidates: [...CHAIN] })

  async function confirm() {
    const items = rows.map((c) => ({
      claim_id: c.id,
      voucher_number: vouchers[c.id]?.trim() || undefined,
      expected_amount: c.remuneration ?? 0,
    }))
    try {
      setFrozen(rows)
      setSent({ ...vouchers })
      const r = await bulkPay.mutateAsync({ items })
      setResult(r)
      setPaidRows(rows.filter((c) => r.paid_ids.includes(c.id)))
      // Only the rows actually paid lose their remembered voucher.
      const next = { ...vouchers }
      for (const id of r.paid_ids) delete next[id]
      setVouchers(next)
      writeVouchers(next)
      onDone(r.paid_ids)
      toast.ok(
        `Paid ${formatCount(r.paid)} ${r.paid === 1 ? "claim" : "claims"}, ${money(
          rows.filter((c) => r.paid_ids.includes(c.id)).reduce((s, c) => s + (c.remuneration || 0), 0)
        )}`
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
              : "Each claim is checked again as it is paid. One whose amount has moved is skipped, not paid at the wrong number."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {!result && (
            <>
              <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-3 sm:grid-cols-3">
                <div>
                  <dt className="text-sm text-fg-muted">Claims</dt>
                  <dd className="figure text-2xl">{formatCount(rows.length)}</dd>
                </div>
                <div>
                  <dt className="text-sm text-fg-muted">Total</dt>
                  <dd className="figure text-2xl">{money(total)}</dd>
                </div>
                <div>
                  <dt className="text-sm text-fg-muted">Month paid</dt>
                  <dd className="text-lg font-medium">{months.map((m) => monthLabel(m)).join(", ")}</dd>
                </div>
              </dl>
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
            <div className="space-y-2">
              <p className="text-base font-medium">Next: send the money and file the paper</p>
              <ul className="divide-y divide-line">
                {paidMonths.map((m) => (
                  <li key={m} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{monthLabel(m)}</span>
                    <span className="flex flex-wrap gap-2">
                      <Button kind="default" size="sm" asChild>
                        <a href={`/api/payouts/statement.csv?month=${m}`} download>
                          <Download />
                          Bank file (CSV)
                        </a>
                      </Button>
                      <Button kind="default" size="sm" asChild>
                        <a href={`/api/payouts/statement.pdf?month=${m}`} download>
                          <FileText />
                          Statement to sign (PDF)
                        </a>
                      </Button>
                      <Button kind="quiet" size="sm" asChild>
                        <Link to={`/statements?month=${m}`} onClick={() => onOpenChange(false)}>
                          Open the statement
                        </Link>
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
              <Meta className="block">
                The bank file has no account numbers or IFSC codes; Accounts adds those from the payroll master.
              </Meta>
            </div>
          )}

          <Table
            rows={rows}
            columns={columns}
            getKey={(c) => c.id}
            caption="Claims in this batch"
            maxHeight="24rem"
          />
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
