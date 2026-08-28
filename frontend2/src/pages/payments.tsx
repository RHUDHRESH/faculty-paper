import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Receipt,
  RefreshCw,
  Undo2,
} from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
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
import { Checkbox, Field, Input, Textarea } from "@/ui/field"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, Sub } from "@/ui/text"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { toast } from "@/ui/toast"

/**
 * Where money actually leaves the college — the queue of tickets the
 * Principal has approved, waiting on a voucher and a click.
 *
 * `Payments` pays; `PaymentsDone` shows what has already gone out and is the
 * only place a payment can be undone. Both guard the same thing: the figure
 * a reader confirms has to be the figure the server just recomputed from its
 * own stored, verified columns. `mark-paid` never calls Scopus — a payment
 * is never blocked by an outage — but that also means the amount on screen
 * can still drift from another admin's edit, a formula change, or a second
 * approval landing between page-load and click. A 409 means it moved: this
 * screen shows both figures and refuses to resend the stale one on its own,
 * on a single payment or on any row a bulk batch skips.
 */

/* ------------------------------------------------------------------------ */
/* Types — read out of claim_to_dict() in backend/core/api.py               */
/* ------------------------------------------------------------------------ */

type PayoutClaim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name: string
  owner_department: string | null
  remuneration: number | null
  calc_error: string | null
  voucher_number: string | null
  cleared_by_name: string | null
  second_approved_by_name: string | null
  principal_approved_by_name: string | null
  principal_approved_at: string | null
  paid_at: string | null
  needs_second_approval: boolean
  duplicate_warning: boolean
  override_duplicate: boolean | null
  override_by_name: string | null
  waiting_days: number | null
}

type PayoutsPage = {
  total: number
  limit: number
  offset: number
  results: PayoutClaim[]
}

type BulkPayResult = {
  paid: number
  paid_ids: string[]
  skipped: { id: string; reason: string }[]
}

const PAGE_SIZE = 50
const VOUCHER_STORAGE_KEY = "payments:vouchers"

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */
/* ------------------------------------------------------------------------ */

function waitingLabel(days: number | null | undefined): string {
  if (days == null) return "—"
  if (days <= 0) return "Today"
  if (days === 1) return "1 day"
  return `${days} days`
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

// A 409's message names the recomputed figure in words — "The recomputed
// amount is ₹1,234.56." — because that is all `mark-paid` returns on refusal.
// Reading it back out is the only way to offer a fresh number to confirm
// without resending the stale one or inventing an endpoint that gives one.
function parseRecomputedAmount(message: string | undefined | null): number | null {
  if (!message) return null
  const m = message.match(/₹\s?([\d,]+(?:\.\d+)?)/)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

// Why a claim needing a second approver cannot be paid yet, in the same
// words `_needs_second_approval` in backend/core/api.py decides it by — a
// reader who cannot act on a row still deserves to know why, not just that
// the button is missing.
function secondApprovalReason(c: PayoutClaim): string {
  if (c.duplicate_warning && c.override_duplicate) {
    const who = c.override_by_name || "somebody"
    return `The payment-history warning on this ticket was set aside by ${who}. A second approver, different from the person who cleared it, must confirm before it can be paid.`
  }
  const clearedBy = c.cleared_by_name || "the person who cleared it"
  return `High-value claim — a second approver, different from ${clearedBy}, must approve before this can be paid.`
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
    // A full or disabled sessionStorage should not stop the reader typing —
    // it only loses the "survive a mis-click" safety net.
  }
}

/* ------------------------------------------------------------------------ */
/* Pagination — total/limit/offset off the envelope, never a client slice   */
/* ------------------------------------------------------------------------ */


/* ------------------------------------------------------------------------ */
/* Payments — the payable queue                                            */
/* ------------------------------------------------------------------------ */

export function Payments() {
  const { me } = useAuth()
  const allowed = can(me?.role).pay

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

  const {
    data,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useApi<PayoutsPage>(
    ["payouts", "DIRECTOR_APPROVED", page],
    `/api/admin/payouts?status=DIRECTOR_APPROVED&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const rows = data?.results ?? []
  const total = data?.total ?? 0

  // Full rows, not just ids — a review table two pages later still needs the
  // title, journal and amount of a row selected on page one, and this list
  // is paginated, so the row itself has to travel with the selection.
  const [selected, setSelected] = useState<Map<string, PayoutClaim>>(new Map())
  const [payId, setPayId] = useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)

  function isPayable(c: PayoutClaim): boolean {
    return !c.needs_second_approval && !c.calc_error
  }

  function toggleSelected(c: PayoutClaim) {
    if (!isPayable(c)) return
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }

  const payableRows = rows.filter(isPayable)
  const allVisibleSelected = payableRows.length > 0 && payableRows.every((c) => selected.has(c.id))
  // Anything selected at all, not just on the page being looked at.
  //
  // The selection deliberately survives paging -- it carries whole rows for
  // exactly that reason -- but the bar that shows it was gated on the current
  // page containing a selected row. Select fifteen claims on page one, turn to
  // page two to add more, and the bar vanished: fifteen claims still selected,
  // no count, no total, and no way to pay them without noticing the selection
  // was still live and paging back.
  const anySelected = selected.size > 0
  // Still needed, but only for the select-all checkbox in the header, whose
  // indeterminate mark is genuinely about the rows on screen.
  const someVisibleSelected = payableRows.some((c) => selected.has(c.id))
  const selectedOffPage = selected.size - payableRows.filter((c) => selected.has(c.id)).length

  const selectedRows = [...selected.values()]
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)

  const payClaim = payId ? rows.find((c) => c.id === payId) ?? selected.get(payId) ?? null : null

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

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Payments</PageTitle>
          <Sub className="mt-1">
            Approved by the Principal, waiting on Finance. Every figure here is
            recomputed from stored, verified values at the moment of payment —
            never from Scopus, so an outage never blocks a payout.
          </Sub>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button kind="quiet" size="sm" asChild>
            <Link to="/payments/done">Already paid</Link>
          </Button>
          <Button kind="quiet" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </header>

      {anySelected && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-accent-wash px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">{selected.size}</span> selected ·{" "}
            <span className="font-semibold tabular">{money(selectedTotal)}</span>
            {selectedOffPage > 0 ? (
              <span className="text-fg-muted">
                {" "}
                · {selectedOffPage} on {selectedOffPage === 1 ? "another page" : "other pages"}
              </span>
            ) : null}
          </p>
          <div className="flex items-center gap-2">
            <Button kind="quiet" size="sm" onClick={() => setSelected(new Map())}>
              Clear selection
            </Button>
            <Button kind="primary" size="sm" onClick={() => setBulkOpen(true)}>
              Pay {selected.size} {selected.size === 1 ? "claim" : "claims"}
            </Button>
          </div>
        </div>
      )}

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
          art="nothing-paid"
          icon={Banknote}
          title="Nothing waiting on Finance"
          message="Every ticket the Principal has approved has already been paid."
        />
      ) : (
        <>
          <TableScroller minWidth="66rem">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th scope="col" className={cn(stickyHeadCell, "w-10")}>
                    <Checkbox
                      checked={
                        allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false
                      }
                      disabled={payableRows.length === 0}
                      onCheckedChange={() => {
                        setSelected((prev) => {
                          const next = new Map(prev)
                          if (allVisibleSelected) {
                            for (const c of payableRows) next.delete(c.id)
                          } else {
                            for (const c of payableRows) next.set(c.id, c)
                          }
                          return next
                        })
                      }}
                      aria-label={allVisibleSelected ? "Deselect all" : "Select all payable rows"}
                    />
                  </th>
                  <th scope="col" className={stickyHeadCell}>
                    <ColumnLabel>Paper</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-44")}>
                    <ColumnLabel>Claimant</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-52")}>
                    <ColumnLabel>Journal</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-24 text-right")}>
                    <ColumnLabel>Waiting</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-32 text-right")}>
                    <ColumnLabel>Amount</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-24")} />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const payable = isPayable(c)
                  return (
                    <tr key={c.id} aria-selected={selected.has(c.id)} className={cn("row border-b border-line last:border-b-0", selected.has(c.id) && "bg-selected")}>
                      <td className="px-3 py-3 align-top">
                        <Checkbox
                          checked={selected.has(c.id)}
                          disabled={!payable}
                          onCheckedChange={() => toggleSelected(c)}
                          aria-label={`Select ${c.paper_title || "this ticket"}`}
                        />
                      </td>
                      <td className="px-3 py-3 align-top">
                        <span className="block break-words text-base">{c.paper_title || "Untitled"}</span>
                        <Meta className="mt-0.5 block">{c.ticket_number || "Not yet ticketed"}</Meta>
                        {c.needs_second_approval && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <RowFlag>
                              <AlertTriangle className="size-3" /> Needs a second approver
                            </RowFlag>
                          </div>
                        )}
                        {c.needs_second_approval && (
                          <p className="mt-1 max-w-sm text-xs text-fg-muted">{secondApprovalReason(c)}</p>
                        )}
                        {c.calc_error && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <RowFlag>
                              <AlertTriangle className="size-3" /> Could not calculate
                            </RowFlag>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <span className="block">{c.owner_name}</span>
                        {c.owner_department && <Meta className="block">{c.owner_department}</Meta>}
                      </td>
                      <td className="px-3 py-3 align-top text-sm text-fg-muted">{c.journal_title || "—"}</td>
                      <td className="px-3 py-3 align-top text-right">
                        <span className={cn("tabular", (c.waiting_days ?? 0) > 7 && "font-medium text-caution")}>
                          {waitingLabel(c.waiting_days)}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top text-right">
                        {c.calc_error ? (
                          <span className="text-xs text-critical">No amount</span>
                        ) : (
                          <span className="tabular">{money(c.remuneration)}</span>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top text-right">
                        <Button
                          kind="default"
                          size="sm"
                          disabled={!payable}
                          onClick={() => setPayId(c.id)}
                        >
                          Pay
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableScroller>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
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

function RowFlag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-critical-wash px-1.5 py-0.5 text-xs font-medium text-critical">
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* Single pay                                                               */
/* ------------------------------------------------------------------------ */

/**
 * One payment. The amount shown is whatever the queue displayed — `mark-paid`
 * recomputes it again from stored values before it moves anything, so if the
 * two disagree the server answers 409 and nothing is paid. That response
 * carries the new figure only as a sentence, not a field, so this reads it
 * back out to offer a fresh, explicit confirm rather than resending the old
 * number or leaving the reader stuck.
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
  const [phase, setPhase] = useState<"ready" | "changed">("ready")
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null)
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [changedAmount, setChangedAmount] = useState<number | null>(null)

  const pay = useApiMutation<{ voucher_number?: string; expected_amount: number }, unknown>(
    `/api/claims/${claim.id}/mark-paid`,
    { invalidates: [["payouts"]] }
  )

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
      toast.ok(`Paid — ${money(expectedAmount)}${claim.ticket_number ? ` for ${claim.ticket_number}` : ""}`)
      onOpenChange(false)
      onPaid(claim.id)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setChangedMessage(err.message)
        setChangedAmount(parseRecomputedAmount(err.message))
        setPhase("changed")
      } else {
        toast.fail(err)
      }
    }
  }

  const amount = claim.remuneration

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Pay this claim?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {claim.paper_title}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {phase === "ready" && (
            <>
              <p className="text-2xl font-semibold tabular">{money(amount)}</p>
              <Field label="Voucher number (optional)">
                <Input value={voucher} onChange={(e) => setVoucher(e.target.value)} />
              </Field>
            </>
          )}

          {phase === "changed" && (
            <Callout tone="caution" title="The amount changed since this screen was drawn">
              <p>You confirmed {money(confirmedAmount)}.</p>
              <p className="mt-1">{changedMessage}</p>
              {changedAmount != null ? (
                <p className="mt-2">
                  Nothing has been paid. Confirm the new figure, {money(changedAmount)}, to try
                  again.
                </p>
              ) : (
                <p className="mt-2">
                  Nothing has been paid. Close this and reopen it from the list to see the fresh
                  figure before trying again.
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
              {pay.isPending ? "Paying…" : `Confirm — ${changedAmount != null ? money(changedAmount) : "…"}`}
            </Button>
          ) : (
            <Button
              kind="primary"
              disabled={amount == null || pay.isPending}
              onClick={() => amount != null && void submit(amount)}
            >
              {pay.isPending ? "Paying…" : `Pay — ${amount != null ? money(amount) : "…"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Bulk pay — the review table                                             */
/* ------------------------------------------------------------------------ */

/**
 * A batch paid in one action instead of two hundred separate dialogs — the
 * thing the old app made Finance do. Every row still goes through the full
 * single-payment guards on the server; a row whose amount drifted is skipped,
 * never paid at the wrong figure, and every skip is named with its reason
 * rather than folded into a bare count.
 *
 * Vouchers persist to `sessionStorage` while this is open, keyed by claim id,
 * so a mis-click on the overlay or the Escape key does not erase twenty
 * minutes of typing. Entries for rows this batch actually paid are cleared on
 * success; a skipped row keeps its typed voucher so retrying it does not mean
 * retyping it.
 */
function BulkPayDialog({
  open,
  onOpenChange,
  rows,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: PayoutClaim[]
  onDone: (paidIds: string[]) => void
}) {
  const [vouchers, setVouchers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<BulkPayResult | null>(null)

  useEffect(() => {
    if (open) {
      setVouchers(readVouchers())
      setResult(null)
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
  >("/api/admin/bulk-mark-paid", { invalidates: [["payouts"]] })

  async function confirm() {
    const items = rows.map((c) => ({
      claim_id: c.id,
      voucher_number: vouchers[c.id]?.trim() || undefined,
      expected_amount: c.remuneration ?? 0,
    }))
    try {
      const r = await bulkPay.mutateAsync({ items })
      setResult(r)
      // Only the rows actually paid lose their remembered voucher — a
      // skipped row's typed value is exactly what the reader needs kept.
      const next = { ...vouchers }
      for (const id of r.paid_ids) delete next[id]
      setVouchers(next)
      writeVouchers(next)
      onDone(r.paid_ids)
      if (r.skipped.length === 0) {
        toast.ok(`Paid — ${r.paid} ${r.paid === 1 ? "claim" : "claims"}`)
        onOpenChange(false)
      }
    } catch (err) {
      toast.fail(err)
    }
  }

  const total = rows.reduce((sum, c) => sum + (c.remuneration || 0), 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {result ? `Paid ${result.paid} of ${rows.length}` : `Pay ${rows.length} ${rows.length === 1 ? "claim" : "claims"}?`}
          </DialogTitle>
          <DialogDescription>
            {result
              ? result.skipped.length === 0
                ? "Every claim in this batch was paid."
                : "The rest were skipped — each for its own reason, below. Nothing was paid at a wrong figure."
              : `${money(total)} total. Each row is re-checked against its stored figures as it pays — a row whose amount has moved is skipped, not paid at the wrong number.`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="overflow-hidden rounded-lg ring-1 ring-inset ring-edge">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th scope="col" className={stickyHeadCell}>
                    <ColumnLabel>Paper</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-40")}>
                    <ColumnLabel>Voucher</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-28 text-right")}>
                    <ColumnLabel>Amount</ColumnLabel>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const skip = result?.skipped.find((s) => s.id === c.id)
                  const paid = result?.paid_ids.includes(c.id)
                  return (
                    <tr key={c.id} className="border-b border-line last:border-b-0">
                      <td className="px-3 py-2.5 align-top">
                        <span className="block break-words">{c.paper_title || "Untitled"}</span>
                        <Meta className="mt-0.5 block">
                          {c.owner_name}
                          {c.ticket_number ? ` · ${c.ticket_number}` : ""}
                        </Meta>
                        {skip && (
                          <p className="mt-1 text-xs text-critical">{skip.reason}</p>
                        )}
                        {paid && <p className="mt-1 text-xs text-positive">Paid</p>}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <Input
                          value={vouchers[c.id] ?? ""}
                          onChange={(e) => setVoucher(c.id, e.target.value)}
                          placeholder="Voucher #"
                          disabled={!!paid}
                        />
                      </td>
                      <td className="px-3 py-2.5 align-top text-right tabular">{money(c.remuneration)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button kind="primary" disabled={bulkPay.isPending || rows.length === 0} onClick={() => void confirm()}>
              {bulkPay.isPending ? "Paying…" : `Pay ${rows.length} — ${money(total)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* PaymentsDone — what has already gone out, and the one way to undo it     */
/* ------------------------------------------------------------------------ */

export function PaymentsDone() {
  const { me } = useAuth()
  const allowed = can(me?.role).pay

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

  const { data, isLoading, isError, isFetching, refetch } = useApi<PayoutsPage>(
    ["payouts", "PAID", page],
    `/api/admin/payouts?status=PAID&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const [voidId, setVoidId] = useState<string | null>(null)
  const voidClaim = voidId ? rows.find((c) => c.id === voidId) ?? null : null

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

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button kind="quiet" size="sm" asChild className="-ml-2 mb-1">
            <Link to="/payments">
              <ArrowLeft />
              Payment orders
            </Link>
          </Button>
          <PageTitle>Paid</PageTitle>
          <Sub className="mt-1">
            Every payment on record, most recent first. Voiding one reverses it
            on the ledger and sends the ticket back to Checked — nothing here
            is ever deleted.
          </Sub>
        </div>
        <Button kind="quiet" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </header>

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={52} />
      ) : isError ? (
        <ErrorState
          title="Could not load payment history"
          message="The server did not answer. Nothing has been changed."
          onRetry={() => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState icon={Receipt} title="Nothing paid yet" message="Once Finance pays a claim, it appears here with its voucher and date." />
      ) : (
        <>
          <TableScroller minWidth="58rem">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th scope="col" className={stickyHeadCell}>
                    <ColumnLabel>Paper</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-44")}>
                    <ColumnLabel>Claimant</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-32")}>
                    <ColumnLabel>Voucher</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-40")}>
                    <ColumnLabel>Paid</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-28 text-right")}>
                    <ColumnLabel>Amount</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-20")} />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="row border-b border-line last:border-b-0">
                    <td className="px-3 py-3 align-top">
                      <span className="block break-words text-base">{c.paper_title || "Untitled"}</span>
                      <Meta className="mt-0.5 block">{c.ticket_number || "Not yet ticketed"}</Meta>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="block">{c.owner_name}</span>
                      {c.owner_department && <Meta className="block">{c.owner_department}</Meta>}
                    </td>
                    <td className="px-3 py-3 align-top text-sm">{c.voucher_number || "—"}</td>
                    <td className="px-3 py-3 align-top text-sm text-fg-muted">{formatDateTime(c.paid_at)}</td>
                    <td className="px-3 py-3 align-top text-right tabular">{money(c.remuneration)}</td>
                    <td className="px-3 py-3 align-top text-right">
                      <Button kind="quiet" size="sm" onClick={() => setVoidId(c.id)}>
                        <Undo2 className="size-3.5" />
                        Void
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}

      {voidClaim && (
        <VoidDialog
          claim={voidClaim}
          open={!!voidId}
          onOpenChange={(o) => !o && setVoidId(null)}
        />
      )}
    </div>
  )
}

/**
 * Reverses a payment made in error. "Void" reads like "delete" and it is
 * not one: the server writes a negative ledger row alongside the original
 * rather than removing anything, and the claim goes back to Checked, waiting
 * on the Principal again. Said here, plainly, because a Finance user typing
 * "void" is trusting that word to mean what it says.
 */
function VoidDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: PayoutClaim
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [note, setNote] = useState("")

  const voidPayment = useApiMutation<{ note: string }, unknown>(
    `/api/claims/${claim.id}/void-payment`,
    { invalidates: [["payouts"]] }
  )

  useEffect(() => {
    if (open) setNote("")
  }, [open])

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10
  const canSubmit = trimmed.length >= 10

  async function submit() {
    try {
      await voidPayment.mutateAsync({ note: trimmed })
      toast.ok(`Voided — ${claim.ticket_number || "the payment"} is back with the Principal's queue`)
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Void this payment?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {claim.paper_title}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="caution" title="This does not delete anything">
            A reversing entry is written to the ledger alongside the original
            payment, and the ticket returns to Checked, waiting on the
            Principal to approve it again.
          </Callout>
          <p className="text-lg font-semibold tabular">{money(claim.remuneration)}</p>
          <Field
            label="Reason"
            hint="At least 10 characters — it goes to the audit trail and the ledger."
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Why this payment is being reversed"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={voidPayment.isPending}>
            Cancel
          </Button>
          <Button kind="danger" disabled={!canSubmit || voidPayment.isPending} onClick={() => void submit()}>
            {voidPayment.isPending ? "Voiding…" : "Void payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
