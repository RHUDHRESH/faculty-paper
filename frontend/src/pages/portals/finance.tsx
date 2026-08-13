import { type ReactNode, useEffect, useMemo, useState } from "react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { API_BASE, api, type Claim } from "@/lib/api"
import { cn } from "@/lib/utils"


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
          disabled={busy}
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

export function FinancePayoutsPage() {
  const [rows, setRows] = useState<Claim[]>([])
  const [voucher, setVoucher] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [q, setQ] = useState("")

  // Confirm-paid dialog
  const [confirmPayId, setConfirmPayId] = useState<string | null>(null)

  // Reject dialog
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState("")

  async function load() {
    setLoading(true)
    try {
      setRows(await api<Claim[]>("/api/admin/payouts?status=PRINCIPAL_APPROVED"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().catch(() => toast.error("Could not load payment orders"))
  }, [])

  async function processYes(id: string) {
    setBusyId(id)
    setConfirmPayId(null)
    try {
      await api(`/api/claims/${id}/mark-paid`, {
        method: "POST",
        json: { voucher_number: voucher[id] || "", note: "processed" },
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

  const confirmClaim = confirmPayId ? rows.find((r) => r.id === confirmPayId) : null

  return (
    <div>
      <PageHeader
        title="Payment orders"
        subtitle="Principal-approved tickets — process or return"
        actions={
          <div className="relative w-44 sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        }
      />

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-[var(--radius)] md:h-14" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Inbox className="size-6" />}
          title="No payment orders"
          description={
            q
              ? "No results match your search."
              : "All principal-approved tickets have been processed."
          }
        />
      ) : (
        <>
          {/* Mobile card stack */}
          <div className="block space-y-3 md:hidden">
            {filtered.map((r) => (
              <PaymentOrderCard
                key={r.id}
                claim={r}
                voucher={voucher[r.id] || ""}
                onVoucherChange={(v) => setVoucher({ ...voucher, [r.id]: v })}
                busy={busyId === r.id}
                onMarkPaid={() => setConfirmPayId(r.id)}
                onReject={() => setRejectId(r.id)}
              />
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block">
            <TableShell headers={["Order", "Paper / Formula", "Faculty", "Amount", "Voucher", "Process"]}>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border last:border-0 hover:bg-muted/40"
                >
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
                          disabled={busyId === r.id}
                          onClick={() => setConfirmPayId(r.id)}
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
        </>
      )}

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
                        <Money value={confirmClaim.remuneration} />
                      </span>
                    </div>
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
  const [rows, setRows] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState("")
  const [dept, setDept] = useState("")

  useEffect(() => {
    api<Claim[]>("/api/admin/payouts?status=PAID")
      .then(setRows)
      .catch(() => toast.error("Could not load paid history"))
      .finally(() => setLoading(false))
  }, [])

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
        subtitle="Tickets marked cleared"
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
                    <StatusChip status={r.status} />
                  </td>
                </tr>
              ))}
            </TableShell>
          </div>
        </>
      )}
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
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (month) qs.set("month", month)
      if (department) qs.set("department", department)
      setRows(await api(`/api/admin/ledger?${qs}`))
    } catch {
      toast.error("Could not load ledger")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            placeholder="YYYY-MM"
            className="w-36"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ledger-dept" className="text-xs">
            Department
          </Label>
          <Input
            id="ledger-dept"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="e.g. CSE"
            className="w-36"
          />
        </div>
        <div className="flex items-end gap-2">
          <Button type="button" size="sm" onClick={() => load()} disabled={loading}>
            <Filter className="mr-1.5 size-4" />
            Apply
          </Button>
          {(month || department) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              onClick={() => {
                setMonth("")
                setDepartment("")
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
    </div>
  )
}
