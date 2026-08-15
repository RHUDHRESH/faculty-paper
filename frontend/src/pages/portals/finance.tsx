import { type ReactNode, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  BadgeCheck,
  BookOpenText,
  Download,
  Filter,
  Inbox,
  ReceiptText,
  Search,
  X,
} from "lucide-react"
import { toast } from "sonner"

import {
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
} from "@/components/layout/page"
import { Money, StatusChip } from "@/components/ticket-ui"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { API_BASE, api, type Claim, type Paginated } from "@/lib/api"
import { Pager } from "@/components/ui/pagination"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

type RecalcResult = {
  remuneration: number | null
  previous: number | null
  changed: boolean
  calc_error?: string | null
  remuneration_note?: string | null
}


// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function TableShell({
  headers,
  children,
  empty,
}: {
  headers: string[]
  children: ReactNode
  empty?: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              {headers.map((h) => (
                <th key={h} className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {empty}
    </div>
  )
}

/** Formula snapshot badge row — only renders if there's something to show. */
function FormulaSnap({ claim }: { claim: Claim }) {
  const parts: string[] = []
  if (claim.snip != null) parts.push(`SNIP ${claim.snip.toFixed(3)}`)
  if (claim.quartile) parts.push(`Q${claim.quartile.replace(/^Q/i, "")}`)
  if (!parts.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {parts.map((p) => (
        <Badge key={p} variant="secondary" className="text-[10px] font-medium">
          {p}
        </Badge>
      ))}
    </div>
  )
}

/** Remuneration pill used in cards. */
function AmountPill({ value }: { value?: number | null }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-xs font-medium text-muted-foreground">₹</span>
      <span className="text-2xl font-semibold tabular-nums text-foreground">
        <Money value={value} />
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Payment-order card (mobile)
// ---------------------------------------------------------------------------

function PaymentOrderCard({
  claim,
  voucher,
  onVoucherChange,
  busy,
  onMarkPaid,
  onReject,
}: {
  claim: Claim
  voucher: string
  onVoucherChange: (v: string) => void
  busy: boolean
  onMarkPaid: () => void
  onReject: () => void
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-muted-foreground">
            {claim.ticket_number}
          </p>
          <p className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug text-foreground">
            {claim.paper_title}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {claim.owner_name}
            {claim.owner_department ? (
              <span className="ml-1.5 opacity-70">· {claim.owner_department}</span>
            ) : null}
          </p>
          <FormulaSnap claim={claim} />
          {claim.needs_second_approval ? (
            <Badge variant="secondary" className="mt-1 text-[10px]">
              Awaiting 2nd approval
            </Badge>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <AmountPill value={claim.remuneration} />
        </div>
      </div>

      {/* Voucher input */}
      <div className="mb-3">
        <Label htmlFor={`voucher-${claim.id}`} className="mb-1.5 block text-xs">
          Voucher # (optional)
        </Label>
        <Input
          id={`voucher-${claim.id}`}
          value={voucher}
          onChange={(e) => onVoucherChange(e.target.value)}
          placeholder="e.g. FIN-2026-00123"
          className="h-9 text-sm"
        />
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1 gap-1.5"
          disabled={busy || claim.needs_second_approval}
          onClick={onMarkPaid}
        >
          <BadgeCheck className="size-4" />
          Mark Paid
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1.5 text-destructive hover:bg-destructive/10"
          disabled={busy}
          onClick={onReject}
        >
          <X className="size-4" />
          Return
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FinancePayoutsPage
// ---------------------------------------------------------------------------

/** Selection + typed vouchers survive navigation: they used to live in plain
 * component state, so typing thirty voucher numbers and switching pages lost
 * all thirty. Cleared when the batch is actually paid. */
const BULK_PAY_STORE = "finance-bulk-pay"

function readBulkStore(): { picked: string[]; voucher: Record<string, string> } {
  try {
    const raw = sessionStorage.getItem(BULK_PAY_STORE)
    if (raw) return JSON.parse(raw)
  } catch {
    /* fresh start */
  }
  return { picked: [], voucher: {} }
}

export function FinancePayoutsPage() {
  const [voucher, setVoucherState] = useState<Record<string, string>>(
    () => readBulkStore().voucher
  )
  const [picked, setPickedState] = useState<Set<string>>(
    () => new Set(readBulkStore().picked)
  )
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkNote, setBulkNote] = useState("")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [q, setQ] = useState("")

  function persistBulk(nextPicked: Set<string>, nextVoucher: Record<string, string>) {
    try {
      sessionStorage.setItem(
        BULK_PAY_STORE,
        JSON.stringify({ picked: [...nextPicked], voucher: nextVoucher })
      )
    } catch {
      /* storage full or blocked — selection just becomes per-visit */
    }
  }

  function setVoucher(next: Record<string, string>) {
    setVoucherState(next)
    persistBulk(picked, next)
  }

  function setPicked(next: Set<string>) {
    setPickedState(next)
    persistBulk(next, voucher)
  }

  function togglePick(id: string) {
    const next = new Set(picked)
    next.has(id) ? next.delete(id) : next.add(id)
    setPicked(next)
  }
  // Notification deep links arrive as /finance?claim=… — fetch that ticket,
  // even when it is not on the current page of the queue.
  const [params] = useSearchParams()
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [deepClaim, setDeepClaim] = useState<Claim | null>(null)

  // Confirm-paid dialog — amount comes from a fresh /recalculate, not the
  // (possibly stale) figure sitting on the row.
  const [confirmPayId, setConfirmPayId] = useState<string | null>(null)
  const [payRecalc, setPayRecalc] = useState<RecalcResult | null>(null)
  const [sort, setSort] = useState("recent")

  // Reject dialog
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState("")

  // Cleared tickets, including any still carrying an old-chain status.
  const [offset, setOffset] = useState(0)
  const PAGE = 50
  const {
    data: page,
    isLoading: loading,
    isError,
    refetch,
  } = useApiQuery<Paginated<Claim>>(
    ["claims", "payouts", "CLEARED", offset, sort],
    `/api/admin/payouts?status=CLEARED&sort=${sort}&limit=${PAGE}&offset=${offset}`
  )
  const rows = page?.results ?? []
  const load = () => refetch()

  useEffect(() => {
    const id = params.get("claim")
    if (!id) return
    api<Claim>(`/api/claims/${id}`)
      .then((c) => {
        setHighlightId(id)
        setDeepClaim(c)
      })
      .catch(() => {
        toast.info("That ticket is not available")
      })
  }, [params])

  useEffect(() => {
    if (!highlightId || loading) return
    const el = [
      document.getElementById(`payout-${highlightId}`),
      document.getElementById(`payout-m-${highlightId}`),
    ].find((e) => e && e.offsetParent !== null)
    el?.scrollIntoView({ block: "center" })
  }, [highlightId, loading, rows])

  async function startPay(id: string) {
    setBusyId(id)
    try {
      const r = await api<RecalcResult>(`/api/claims/${id}/recalculate`, {
        method: "POST",
        json: {},
      })
      setPayRecalc(r)
      setConfirmPayId(id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not recalculate the amount")
    } finally {
      setBusyId(null)
    }
  }

  async function processYes(id: string) {
    setBusyId(id)
    setConfirmPayId(null)
    try {
      const claim = rows.find((r) => r.id === id) || (deepClaim?.id === id ? deepClaim : null)
      await api(`/api/claims/${id}/mark-paid`, {
        method: "POST",
        json: {
          voucher_number: voucher[id] || "",
          note: "processed",
          expected_amount: payRecalc?.remuneration ?? claim?.remuneration ?? null,
        },
      })
      toast.success("Payment marked — faculty has been notified", {
        description: voucher[id] ? `Voucher: ${voucher[id]}` : undefined,
      })
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not process")
    } finally {
      setBusyId(null)
    }
  }

  async function processNo() {
    if (!rejectId) return
    setBusyId(rejectId)
    try {
      await api(`/api/claims/${rejectId}/reject`, {
        method: "POST",
        // No canned fallback: a returned ticket must carry a real reason.
        json: { note: rejectNote.trim() },
      })
      toast.success("Returned to faculty for correction")
      setRejectId(null)
      setRejectNote("")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not return ticket")
    } finally {
      setBusyId(null)
    }
  }

  async function payBulk() {
    const selectedRows = rows.filter((r) => picked.has(r.id))
    if (!selectedRows.length) return
    setBulkBusy(true)
    try {
      const res = await api<{
        paid: number
        paid_ids: string[]
        skipped: { id: string; reason: string }[]
      }>("/api/admin/bulk-mark-paid", {
        method: "POST",
        json: {
          items: selectedRows.map((r) => ({
            claim_id: r.id,
            voucher_number: voucher[r.id] || null,
            // The amount on screen is the amount that gets paid — the server
            // recomputes per row and skips anything that drifted.
            expected_amount: r.remuneration ?? null,
          })),
          note: bulkNote.trim() || "processed (batch)",
        },
      })
      toast.success(`${res.paid} payment${res.paid === 1 ? "" : "s"} processed`)
      for (const s of res.skipped.slice(0, 3)) toast.error(`Skipped: ${s.reason}`)
      if (res.skipped.length > 3) toast.error(`${res.skipped.length - 3} more were skipped`)
      // Keep only what was skipped selected, so it is easy to fix and retry.
      const remaining = new Set(res.skipped.map((s) => s.id))
      const nextVoucher: Record<string, string> = {}
      for (const id of remaining) if (voucher[id]) nextVoucher[id] = voucher[id]
      setPickedState(remaining)
      setVoucherState(nextVoucher)
      if (remaining.size) persistBulk(remaining, nextVoucher)
      else sessionStorage.removeItem(BULK_PAY_STORE)
      setBulkOpen(false)
      setBulkNote("")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk payment failed")
    } finally {
      setBulkBusy(false)
    }
  }

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return rows
    return rows.filter(
      (r) =>
        (r.ticket_number || "").toLowerCase().includes(s) ||
        (r.paper_title || "").toLowerCase().includes(s) ||
        (r.owner_name || "").toLowerCase().includes(s)
    )
  }, [rows, q])

  // Only rows that are actually payable can join a batch.
  const selectable = useMemo(
    () => filtered.filter((r) => !r.needs_second_approval),
    [filtered]
  )
  const selectedRows = rows.filter((r) => picked.has(r.id))
  const selectedTotal = selectedRows.reduce((s, r) => s + (r.remuneration || 0), 0)

  const confirmClaim =
    confirmPayId
      ? rows.find((r) => r.id === confirmPayId) ||
        (deepClaim?.id === confirmPayId ? deepClaim : null)
      : null
  const pinned =
    deepClaim && !rows.some((r) => r.id === deepClaim.id) ? deepClaim : null

  return (
    <div>
      <PageHeader
        title="Payment orders"
        subtitle="Cleared tickets — process the payment or send one back"
        actions={
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value)
                setOffset(0)
              }}
              aria-label="Sort payment orders"
            >
              <option value="recent">Most recent</option>
              <option value="amount">Highest amount</option>
              <option value="title">Title</option>
            </select>
            <div className="relative w-44 sm:w-56">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        }
      />

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-[var(--radius)] md:h-14" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          title="Could not load payment orders"
          description="The server did not respond — no payments were affected."
          onRetry={() => refetch()}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Inbox className="size-6" />}
          title="No payment orders"
          description={
            q
              ? "No results match your search."
              : "Every cleared ticket has been paid."
          }
        />
      ) : (
        <>
          {/* Bulk selection bar */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-border/80 bg-muted/40 px-4 py-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={picked.size > 0 && selectable.every((r) => picked.has(r.id))}
                onCheckedChange={(v) =>
                  setPicked(v === true ? new Set(selectable.map((r) => r.id)) : new Set())
                }
                aria-label="Select every payable order shown"
              />
              {picked.size
                ? `${picked.size} selected · ` : `Select all ${selectable.length} payable`}
              {picked.size ? <Money value={selectedTotal} /> : null}
            </label>
            {picked.size ? (
              <Button type="button" size="sm" disabled={bulkBusy} onClick={() => setBulkOpen(true)}>
                Pay selected ({picked.size})
              </Button>
            ) : null}
          </div>

          {pinned ? (
            <div className="mb-3 rounded-[var(--radius)] border border-primary/40 bg-primary/5 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Opened from a notification — this ticket is not on the current page.
              </p>
              <PaymentOrderCard
                claim={pinned}
                voucher={voucher[pinned.id] || ""}
                onVoucherChange={(v) => setVoucher({ ...voucher, [pinned.id]: v })}
                busy={busyId === pinned.id}
                onMarkPaid={() => startPay(pinned.id)}
                onReject={() => setRejectId(pinned.id)}
              />
            </div>
          ) : null}

          {/* Mobile card stack */}
          <div className="block space-y-3 md:hidden">
            {filtered.map((r) => (
              <div
                key={r.id}
                id={`payout-m-${r.id}`}
                className={cn(highlightId === r.id && "rounded-lg ring-2 ring-primary")}
              >
              <PaymentOrderCard
                claim={r}
                voucher={voucher[r.id] || ""}
                onVoucherChange={(v) => setVoucher({ ...voucher, [r.id]: v })}
                busy={busyId === r.id}
                onMarkPaid={() => startPay(r.id)}
                onReject={() => setRejectId(r.id)}
              />
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block">
            <TableShell headers={["", "Order", "Paper / Formula", "Faculty", "Amount", "Voucher", "Process"]}>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  id={`payout-${r.id}`}
                  className={cn(
                    "border-b border-border last:border-0 hover:bg-muted/40",
                    highlightId === r.id && "bg-primary/10"
                  )}
                >
                    <td className="px-4 py-3">
                      <Checkbox
                        checked={picked.has(r.id)}
                        disabled={r.needs_second_approval}
                        onCheckedChange={() => togglePick(r.id)}
                        aria-label={`Select ${r.ticket_number || "order"}`}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {r.ticket_number}
                    </td>
                    <td className="max-w-[16rem] px-4 py-3">
                      <p className="line-clamp-2 font-medium leading-snug">{r.paper_title}</p>
                      <FormulaSnap claim={r} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.owner_name}</div>
                      <div className="text-xs text-muted-foreground">{r.owner_department}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-base font-semibold">
                        <Money value={r.remuneration} />
                      </span>
                      {r.needs_second_approval ? (
                        <Badge variant="secondary" className="mt-1 block w-fit text-[10px]">
                          Awaiting 2nd approval
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        className="h-9 min-w-[9rem] text-sm"
                        value={voucher[r.id] || ""}
                        onChange={(e) =>
                          setVoucher({ ...voucher, [r.id]: e.target.value })
                        }
                        placeholder="Voucher # (opt.)"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          size="sm"
                          disabled={busyId === r.id || r.needs_second_approval}
                          title={
                            r.needs_second_approval
                              ? "High-value claim — needs a second approver before payment"
                              : undefined
                          }
                          onClick={() => startPay(r.id)}
                        >
                          <BadgeCheck className="mr-1.5 size-4" />
                          Yes
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:bg-destructive/10"
                          disabled={busyId === r.id}
                          onClick={() => setRejectId(r.id)}
                        >
                          No
                        </Button>
                      </div>
                    </td>
                </tr>
              ))}
            </TableShell>
          </div>

          {page ? (
            <Pager
              total={page.total}
              limit={page.limit}
              offset={page.offset}
              onOffsetChange={setOffset}
            />
          ) : null}
        </>
      )}

      {/* ── Bulk pay review dialog ── */}
      <AlertDialog open={bulkOpen} onOpenChange={(o) => !o && setBulkOpen(false)}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Pay {selectedRows.length} order{selectedRows.length === 1 ? "" : "s"} —{" "}
              <Money value={selectedTotal} />
            </AlertDialogTitle>
            <AlertDialogDescription>
              Review each row before confirming. Every payment still passes the full checks
              individually — anything whose amount changed or that needs a second approval is
              skipped and listed, never silently paid.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-72 overflow-y-auto rounded-md border border-border/70">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Order</th>
                  <th className="px-3 py-2 font-medium">Faculty</th>
                  <th className="px-3 py-2 font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Voucher</th>
                </tr>
              </thead>
              <tbody>
                {selectedRows.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{r.ticket_number}</td>
                    <td className="px-3 py-2">{r.owner_name}</td>
                    <td className="px-3 py-2 font-semibold tabular-nums">
                      <Money value={r.remuneration} />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        className="h-8 min-w-[8rem] text-xs"
                        value={voucher[r.id] || ""}
                        onChange={(e) => setVoucher({ ...voucher, [r.id]: e.target.value })}
                        placeholder="Voucher # (opt.)"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-note">Batch note (optional)</Label>
            <Input
              id="bulk-note"
              value={bulkNote}
              onChange={(e) => setBulkNote(e.target.value)}
              placeholder="e.g. August 2026 payout run"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkBusy || !selectedRows.length}
              onClick={(e) => {
                e.preventDefault()
                payBulk()
              }}
            >
              <BadgeCheck className="mr-1.5 size-4" />
              Confirm {selectedRows.length} payment{selectedRows.length === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirm Mark-Paid dialog ── */}
      <AlertDialog
        open={!!confirmPayId}
        onOpenChange={(o) => !o && setConfirmPayId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm payment</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                {confirmClaim && (
                  <div className="rounded-md border border-border/70 bg-muted/40 p-3 text-foreground">
                    <p className="line-clamp-2 font-medium leading-snug">
                      {confirmClaim.paper_title}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {confirmClaim.owner_name}
                      {confirmClaim.owner_department
                        ? ` · ${confirmClaim.owner_department}`
                        : ""}
                    </p>
                    <div className="mt-2 flex items-baseline gap-1.5">
                      <span className="text-xs text-muted-foreground">Amount:</span>
                      <span className="text-lg font-semibold tabular-nums text-foreground">
                        <Money value={payRecalc?.remuneration ?? confirmClaim.remuneration} />
                      </span>
                    </div>
                    {payRecalc?.changed ? (
                      <p className="mt-1 text-xs">
                        Changed from <Money value={payRecalc.previous} /> on re-verification.
                      </p>
                    ) : null}
                    {voucher[confirmClaim.id] && (
                      <p className="mt-1 text-xs">
                        Voucher:{" "}
                        <span className="font-mono font-medium">
                          {voucher[confirmClaim.id]}
                        </span>
                      </p>
                    )}
                  </div>
                )}
                <p>
                  This will mark the ticket as <strong>Paid</strong>. The faculty
                  member will be notified. This action cannot be undone here.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busyId}
              onClick={(e) => {
                e.preventDefault()
                if (confirmPayId) processYes(confirmPayId)
              }}
            >
              <BadgeCheck className="mr-1.5 size-4" />
              Confirm payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Reject dialog ── */}
      <AlertDialog open={!!rejectId} onOpenChange={(o) => !o && setRejectId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Return this ticket?</AlertDialogTitle>
            <AlertDialogDescription>
              Faculty will be notified that their payment order could not be
              processed. Provide a short reason so they know what to fix.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-note">Reason</Label>
            <Textarea
              id="reject-note"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={3}
              className="resize-none"
              placeholder="e.g. Missing bank details, amount mismatch…"
              aria-describedby="reject-note-hint"
            />
            <p id="reject-note-hint" className="text-xs text-muted-foreground">
              At least 10 characters. This is what the faculty member sees.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busyId || rejectNote.trim().length < 10}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                processNo()
              }}
            >
              Return to faculty
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FinancePaidPage
// ---------------------------------------------------------------------------

export function FinancePaidPage() {
  const [q, setQ] = useState("")
  const [dept, setDept] = useState("")
  const [voidId, setVoidId] = useState<string | null>(null)
  const [voidNote, setVoidNote] = useState("")
  const [voiding, setVoiding] = useState(false)

  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState("recent")
  const PAGE = 50
  const {
    data: page,
    isLoading: loading,
    isError,
    refetch,
  } = useApiQuery<Paginated<Claim>>(
    ["claims", "payouts", "PAID", offset, sort],
    `/api/admin/payouts?status=PAID&sort=${sort}&limit=${PAGE}&offset=${offset}`
  )
  const rows = page?.results ?? []
  const load = () => refetch()

  async function voidPayment() {
    if (!voidId) return
    setVoiding(true)
    try {
      await api(`/api/claims/${voidId}/void-payment`, {
        method: "POST",
        json: { note: voidNote.trim() },
      })
      toast.success("Payment voided — the ticket is back with payment orders")
      setVoidId(null)
      setVoidNote("")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not void the payment")
    } finally {
      setVoiding(false)
    }
  }

  const filtered = useMemo(() => {
    const sq = q.trim().toLowerCase()
    const sd = dept.trim().toLowerCase()
    return rows.filter((r) => {
      const matchQ =
        !sq ||
        (r.ticket_number || "").toLowerCase().includes(sq) ||
        (r.paper_title || "").toLowerCase().includes(sq) ||
        (r.owner_name || "").toLowerCase().includes(sq)
      const matchD =
        !sd || (r.owner_department || "").toLowerCase().includes(sd)
      return matchQ && matchD
    })
  }, [rows, q, dept])

  const totalFiltered = filtered.reduce((s, r) => s + (r.remuneration || 0), 0)

  return (
    <div>
      <PageHeader
        title="Processed payments"
        subtitle="Tickets marked paid — void a payment here if it was made in error"
        actions={
          <div className="flex items-baseline gap-1.5 text-sm">
            <span className="text-muted-foreground">Total:</span>
            <span className="font-semibold">
              <Money value={totalFiltered} />
            </span>
          </div>
        }
      />

      <FilterBar className="mb-4">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Ticket / paper / faculty…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="relative w-40">
          <Filter className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Department…"
            value={dept}
            onChange={(e) => setDept(e.target.value)}
          />
        </div>
        <select
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value)
            setOffset(0)
          }}
          aria-label="Sort paid tickets"
        >
          <option value="recent">Most recent</option>
          <option value="amount">Highest amount</option>
          <option value="title">Title</option>
        </select>
        {(q || dept) && (
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5 text-muted-foreground"
            onClick={() => { setQ(""); setDept("") }}
          >
            <X className="size-4" />
            Clear
          </Button>
        )}
      </FilterBar>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          title="Could not load paid history"
          description="The server did not respond — the ledger is unaffected."
          onRetry={() => refetch()}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ReceiptText className="size-6" />}
          title="No processed payments"
          description={
            q || dept
              ? "Try adjusting your filters."
              : "Once payments are marked cleared they'll appear here."
          }
          action={
            (q || dept) ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setQ(""); setDept("") }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Mobile cards */}
          <div className="block space-y-3 md:hidden">
            {filtered.map((r) => (
              <div
                key={r.id}
                className="rounded-[var(--radius)] border border-border/80 bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {r.ticket_number}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug">
                      {r.paper_title}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {r.owner_name}
                      {r.owner_department ? ` · ${r.owner_department}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="text-base font-semibold">
                      <Money value={r.remuneration} />
                    </span>
                    <div className="mt-1">
                      <StatusChip status={r.status} />
                    </div>
                  </div>
                </div>
                {r.voucher_number && (
                  <p className="mt-2 font-mono text-xs text-muted-foreground">
                    Voucher: {r.voucher_number}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block">
            <TableShell headers={["Ticket", "Paper", "Faculty", "Amount", "Voucher", "Status"]}>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border/50 last:border-0 hover:bg-accent/30"
                >
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {r.ticket_number}
                  </td>
                  <td className="max-w-[14rem] truncate px-4 py-3 font-medium">
                    {r.paper_title}
                  </td>
                  <td className="px-4 py-3">
                    <div>{r.owner_name}</div>
                    <div className="text-xs text-muted-foreground">{r.owner_department}</div>
                  </td>
                  <td className="px-4 py-3 text-base font-semibold">
                    <Money value={r.remuneration} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{r.voucher_number || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusChip status={r.status} />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => setVoidId(r.id)}
                      >
                        Void
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </TableShell>
          </div>

          {page ? (
            <Pager
              total={page.total}
              limit={page.limit}
              offset={page.offset}
              onOffsetChange={setOffset}
            />
          ) : null}
        </>
      )}

      {/* ── Void payment dialog ── */}
      <AlertDialog open={!!voidId} onOpenChange={(o) => !o && setVoidId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void this payment?</AlertDialogTitle>
            <AlertDialogDescription>
              A reversing entry is written to the ledger — nothing is deleted — and the
              ticket returns to the payment queue so it can be corrected and paid again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="void-note">Reason</Label>
            <Textarea
              id="void-note"
              value={voidNote}
              onChange={(e) => setVoidNote(e.target.value)}
              rows={3}
              className="resize-none"
              placeholder="e.g. Wrong voucher number, duplicate disbursement…"
            />
            <p className="text-xs text-muted-foreground">
              At least 10 characters. Recorded on the ledger row and in the audit trail.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={voiding || voidNote.trim().length < 10}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                voidPayment()
              }}
            >
              Void payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FinanceLedgerPage
// ---------------------------------------------------------------------------

type LedgerRow = {
  id: string
  payout_month?: string | null
  department?: string | null
  faculty_name?: string | null
  staff_id?: string | null
  paper_title?: string | null
  amount?: number
  voucher_number?: string | null
}

export function FinanceLedgerPage() {
  const [month, setMonth] = useState("")
  const [department, setDepartment] = useState("")
  const [offset, setOffset] = useState(0)
  const [exporting, setExporting] = useState(false)
  const PAGE = 50
  // The same list that already backs the dropdowns on Reports and Query —
  // this page asked users to type "YYYY-MM" and a department string by hand.
  const { data: departments = [] } = useApiQuery<string[]>(
    ["meta", "departments"],
    "/api/meta/departments"
  )

  const qs = new URLSearchParams()
  if (month) qs.set("month", month)
  if (department) qs.set("department", department)
  qs.set("limit", String(PAGE))
  qs.set("offset", String(offset))

  const {
    data: page,
    isLoading: loading,
    isError,
    refetch,
  } = useApiQuery<Paginated<LedgerRow>>(
    ["ledger", month, department, offset],
    `/api/admin/ledger?${qs}`
  )
  const rows = page?.results ?? []

  async function exportCsv() {
    setExporting(true)
    try {
      const qs = new URLSearchParams()
      if (month) qs.set("month", month)
      if (department) qs.set("department", department)
      const csrf = await (
        await fetch(`${API_BASE}/api/auth/csrf`, { credentials: "include" })
      ).json()
      const res = await fetch(`${API_BASE}/api/admin/ledger/export?${qs}`, {
        credentials: "include",
        headers: { "X-CSRFToken": csrf.csrfToken || "" },
      })
      if (!res.ok) throw new Error("Export failed")
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `ledger-${month || "all"}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Ledger exported", {
        description: `ledger-${month || "all"}.csv`,
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0)

  return (
    <div>
      <PageHeader
        title="Accounts ledger"
        subtitle="Monthly payout records"
        actions={
          <div className="flex items-center gap-3">
            <div className="flex items-baseline gap-1.5 text-sm">
              <span className="text-muted-foreground">Total:</span>
              <span className="font-semibold">
                <Money value={total} />
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={exportCsv}
              disabled={exporting || loading}
            >
              <Download className="size-4" />
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
          </div>
        }
      />

      {/* Filter bar */}
      <FilterBar className="mb-4 rounded-[var(--radius)] border border-border/80 bg-card p-4">
        <div className="space-y-1.5">
          <Label htmlFor="ledger-month" className="text-xs">
            Month
          </Label>
          <Input
            id="ledger-month"
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value)
              setOffset(0)
            }}
            className="w-40"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ledger-dept" className="text-xs">
            Department
          </Label>
          <select
            id="ledger-dept"
            className="h-9 w-44 rounded-md border border-input bg-transparent px-2 text-sm"
            value={department}
            onChange={(e) => {
              setDepartment(e.target.value)
              setOffset(0)
            }}
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          {(month || department) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              onClick={() => {
                setMonth("")
                setDepartment("")
                setOffset(0)
              }}
            >
              <X className="size-4" />
              Clear
            </Button>
          )}
        </div>
      </FilterBar>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          title="Could not load the ledger"
          description="The server did not respond."
          onRetry={() => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<BookOpenText className="size-6" />}
          title="No ledger entries"
          description={
            month || department
              ? "No entries match these filters — try broadening the criteria."
              : "Ledger entries will appear here once payments are processed."
          }
          action={
            (month || department) ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setMonth(""); setDepartment("") }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <TableShell headers={["Month", "Dept", "Faculty", "Paper", "Amount", "Voucher"]}>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-border/50 last:border-0 hover:bg-accent/30"
            >
              <td className="px-4 py-3 tabular-nums text-sm">{r.payout_month || "—"}</td>
              <td className="px-4 py-3 text-sm">{r.department || "—"}</td>
              <td className="px-4 py-3">
                <div className="text-sm">{r.faculty_name}</div>
                <div className="text-xs text-muted-foreground">{r.staff_id}</div>
              </td>
              <td className="max-w-[14rem] truncate px-4 py-3 text-sm">{r.paper_title}</td>
              <td className="px-4 py-3 text-base font-semibold">
                <Money value={r.amount} />
              </td>
              <td className="px-4 py-3 font-mono text-xs">{r.voucher_number || "—"}</td>
            </tr>
          ))}
        </TableShell>
      )}
      {page ? (
        <Pager
          total={page.total}
          limit={page.limit}
          offset={page.offset}
          onOffsetChange={setOffset}
        />
      ) : null}
    </div>
  )
}
