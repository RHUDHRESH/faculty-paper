import { type ReactNode, useEffect, useMemo, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Search } from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/layout/page"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { api, type Claim } from "@/lib/api"
import { cn } from "@/lib/utils"

const API_BASE = import.meta.env.VITE_API_BASE || ""

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

export function FinancePayoutsPage() {
  const [rows, setRows] = useState<Claim[]>([])
  const [voucher, setVoucher] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [q, setQ] = useState("")
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
    try {
      await api(`/api/claims/${id}/mark-paid`, {
        method: "POST",
        json: { voucher_number: voucher[id] || "", note: "processed" },
      })
      toast.success("Marked processed — faculty notified")
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
        json: { note: rejectNote.trim() || "Finance could not process payment" },
      })
      toast.success("Returned — faculty notified")
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

  return (
    <div>
      <PageHeader
        title="Payment orders"
        subtitle="Principal-approved tickets — process yes or return"
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
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      ) : (
        <TableShell
          headers={["Order", "Paper", "Faculty", "Amount", "Voucher", "Process"]}
          empty={
            !filtered.length ? (
              <div className="px-4 py-16 text-center text-sm text-muted-foreground">
                No payment orders waiting
              </div>
            ) : null
          }
        >
          <AnimatePresence initial={false}>
            {filtered.map((r, i) => (
              <motion.tr
                key={r.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.12) }}
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
                <td className="px-4 py-3 font-semibold">
                  <Money value={r.remuneration} />
                </td>
                <td className="px-4 py-3">
                  <Input
                    className="h-10 min-w-[8rem]"
                    value={voucher[r.id] || ""}
                    onChange={(e) =>
                      setVoucher({ ...voucher, [r.id]: e.target.value })
                    }
                    placeholder="Voucher # (optional)"
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      disabled={busyId === r.id}
                      onClick={() => processYes(r.id)}
                    >
                      Yes
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === r.id}
                      onClick={() => setRejectId(r.id)}
                    >
                      No
                    </Button>
                  </div>
                </td>
              </motion.tr>
            ))}
          </AnimatePresence>
        </TableShell>
      )}

      <AlertDialog open={!!rejectId} onOpenChange={(o) => !o && setRejectId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cannot process this payment?</AlertDialogTitle>
            <AlertDialogDescription>
              Faculty will be told the ticket needs changes — keep the note short.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-note">Note (optional)</Label>
            <Textarea
              id="reject-note"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={3}
              className="resize-none"
              placeholder="Why it cannot be processed"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busyId}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                processNo()
              }}
            >
              Confirm no
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function FinancePaidPage() {
  const [rows, setRows] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<Claim[]>("/api/admin/payouts?status=PAID")
      .then(setRows)
      .catch(() => toast.error("Could not load paid history"))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <PageHeader title="Processed" subtitle="Payments marked cleared" />
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      ) : (
        <TableShell
          headers={["Ticket", "Paper", "Faculty", "Amount", "Voucher", "Status"]}
          empty={
            !rows.length ? (
              <div className="px-4 py-16 text-center text-sm text-muted-foreground">
                No processed payments yet
              </div>
            ) : null
          }
        >
          {rows.map((r) => (
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
              <td className="px-4 py-3">{r.owner_name}</td>
              <td className="px-4 py-3 font-semibold">
                <Money value={r.remuneration} />
              </td>
              <td className="px-4 py-3">{r.voucher_number || "—"}</td>
              <td className="px-4 py-3">
                <StatusChip status={r.status} />
              </td>
            </tr>
          ))}
        </TableShell>
      )}
    </div>
  )
}

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
  }, [])

  async function exportCsv() {
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
      toast.success("CSV downloaded")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed")
    }
  }

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0)

  return (
    <div>
      <PageHeader
        title="Accounts ledger"
        subtitle="Monthly payouts"
        actions={
          <div className={cn("text-sm font-medium")}>
            Total: <Money value={total} />
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[var(--radius)] border border-border/80 bg-card p-4">
        <div className="space-y-1.5">
          <Label htmlFor="ledger-month">Month</Label>
          <Input
            id="ledger-month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            placeholder="YYYY-MM"
            className="w-36"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ledger-dept">Department</Label>
          <Input
            id="ledger-dept"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="CSE"
            className="w-36"
          />
        </div>
        <Button type="button" onClick={() => load()}>
          Filter
        </Button>
        <Button type="button" variant="outline" onClick={exportCsv}>
          Export CSV
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      ) : (
        <TableShell
          headers={["Month", "Dept", "Faculty", "Paper", "Amount", "Voucher"]}
          empty={
            !rows.length ? (
              <div className="px-4 py-16 text-center text-sm text-muted-foreground">
                No ledger rows yet
              </div>
            ) : null
          }
        >
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-border/50 last:border-0 hover:bg-accent/30"
            >
              <td className="px-4 py-3">{r.payout_month}</td>
              <td className="px-4 py-3">{r.department}</td>
              <td className="px-4 py-3">
                <div>{r.faculty_name}</div>
                <div className="text-xs text-muted-foreground">{r.staff_id}</div>
              </td>
              <td className="max-w-[14rem] truncate px-4 py-3">{r.paper_title}</td>
              <td className="px-4 py-3 font-semibold">
                <Money value={r.amount} />
              </td>
              <td className="px-4 py-3">{r.voucher_number || "—"}</td>
            </tr>
          ))}
        </TableShell>
      )}
    </div>
  )
}
