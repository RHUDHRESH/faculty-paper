"use client"

import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { AnimatePresence, motion } from "framer-motion"
import { Search } from "lucide-react"
import { toast } from "sonner"

import { PageHeader, StatStrip } from "@/components/layout/page"
import {
  Money,
  StatusChip,
  StatusTimeline,
} from "@/components/ticket-ui"
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
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { api, parseVerifySnapshot, type Claim } from "@/lib/api"
import { cn } from "@/lib/utils"

type QueueProps = {
  title: string
  subtitle: string
  statusFilter: string
  approvePath: "hod-approve" | "principal-approve"
  approveLabel: string
  showDept?: boolean
}

function TicketDetailBody({ claim }: { claim: Claim }) {
  const snap = parseVerifySnapshot(claim.verification_snapshot_json)
  return (
    <div className="space-y-5">
      <StatusTimeline status={claim.status} />
      <div>
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold leading-snug">
          {claim.paper_title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {claim.owner_name} · {claim.owner_department}
        </p>
        <p className="text-sm text-muted-foreground">{claim.journal_title}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-[var(--radius)] bg-muted/50 p-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">SNIP</div>
          <div className="mt-0.5 font-medium">{claim.snip ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Quartile</div>
          <div className="mt-0.5 font-medium">{claim.quartile || "—"}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Indexing</div>
          <div className="mt-0.5 font-medium">{claim.indexing_status || "—"}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Amount</div>
          <div className="mt-0.5 text-lg font-semibold text-primary">
            <Money value={claim.remuneration} />
          </div>
        </div>
      </div>
      {claim.contest_note ? (
        <div className="rounded-[var(--radius)] border border-amber-200/80 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-800/80">
            Contest note
          </div>
          <p className="mt-1">{claim.contest_note}</p>
        </div>
      ) : null}
      {snap?.issues?.length ? (
        <ul className="list-disc space-y-1 pl-4 text-sm text-amber-900">
          {snap.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-emerald-800">Verification snapshot looks clean.</p>
      )}
      {claim.scopus_url ? (
        <a
          className="text-sm text-primary underline-offset-4 hover:underline"
          href={claim.scopus_url}
          target="_blank"
          rel="noreferrer"
        >
          Open Scopus record
        </a>
      ) : null}
      <Separator />
      <ul className="space-y-2 text-sm text-muted-foreground">
        {(claim.actions || []).map((a) => (
          <li key={a.id}>
            <span className="font-medium text-foreground">{a.action}</span>
            {" · "}
            {a.actor_name}
            {" · "}
            {new Date(a.created_at).toLocaleString()}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ApprovalQueue({
  title,
  subtitle,
  statusFilter,
  approvePath,
  approveLabel,
  showDept,
}: QueueProps) {
  const [claims, setClaims] = useState<Claim[]>([])
  const [selected, setSelected] = useState<Claim | null>(null)
  const [note, setNote] = useState("")
  const [q, setQ] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null)
  const [params] = useSearchParams()

  async function load() {
    setLoading(true)
    try {
      const all = await api<Claim[]>(`/api/claims?status=${statusFilter}`)
      setClaims(all)
      const id = params.get("claim")
      if (id) {
        const c = await api<Claim>(`/api/claims/${id}`)
        setSelected(c)
        setSheetOpen(true)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().catch(() => toast.error("Could not load queue"))
  }, [params, statusFilter])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return claims
    return claims.filter(
      (c) =>
        (c.ticket_number || "").toLowerCase().includes(s) ||
        (c.paper_title || "").toLowerCase().includes(s) ||
        (c.owner_name || "").toLowerCase().includes(s) ||
        (c.owner_department || "").toLowerCase().includes(s)
    )
  }, [claims, q])

  async function openClaim(id: string) {
    const c = await api<Claim>(`/api/claims/${id}`)
    setSelected(c)
    setSheetOpen(true)
  }

  async function act(kind: "approve" | "reject") {
    if (!selected) return
    setBusy(true)
    try {
      const path = kind === "approve" ? approvePath : "reject"
      await api(`/api/claims/${selected.id}/${path}`, {
        method: "POST",
        json: { note },
      })
      toast.success(kind === "approve" ? "Approved" : "Rejected")
      setSelected(null)
      setSheetOpen(false)
      setNote("")
      setConfirm(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed")
    } finally {
      setBusy(false)
    }
  }

  const actions = selected ? (
    <div className="flex gap-2">
      <Button className="flex-1" disabled={busy} onClick={() => setConfirm("approve")}>
        {approveLabel}
      </Button>
      <Button
        className="flex-1"
        variant="destructive"
        disabled={busy}
        onClick={() => setConfirm("reject")}
      >
        Reject
      </Button>
    </div>
  ) : null

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search ticket, paper, faculty…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <div className="overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card">
            <AnimatePresence initial={false}>
              {filtered.map((c, i) => (
                <motion.button
                  key={c.id}
                  type="button"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.15) }}
                  onClick={() => openClaim(c.id)}
                  className={cn(
                    "flex w-full flex-col gap-1 border-b border-border/60 px-4 py-3.5 text-left transition-colors hover:bg-accent/40 active:bg-accent/70 sm:flex-row sm:items-center sm:gap-3",
                    selected?.id === c.id && "bg-accent/50"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {c.ticket_number}
                      </span>
                      <StatusChip status={c.status} contest={c.contest_forward} />
                    </div>
                    <div className="mt-1 line-clamp-1 text-sm font-medium">{c.paper_title}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.owner_name}
                      {showDept && c.owner_department ? ` · ${c.owner_department}` : ""}
                    </div>
                  </div>
                  <div className="text-sm font-semibold">
                    <Money value={c.remuneration} />
                  </div>
                </motion.button>
              ))}
            </AnimatePresence>
            {!filtered.length ? (
              <div className="px-4 py-16 text-center text-sm text-muted-foreground">
                No pending tickets
              </div>
            ) : null}
          </div>

          <div className="hidden lg:block">
            {selected ? (
              <div className="sticky top-20 space-y-4 rounded-[var(--radius)] border border-border/80 bg-card p-5">
                <TicketDetailBody claim={selected} />
                {actions}
              </div>
            ) : (
              <div className="rounded-[var(--radius)] border border-dashed border-border px-4 py-16 text-center text-sm text-muted-foreground">
                Select a ticket to review
              </div>
            )}
          </div>
        </div>
      )}

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto rounded-t-[1.25rem] lg:hidden">
          <SheetHeader className="text-left">
            <SheetTitle className="font-mono text-base text-primary">
              {selected?.ticket_number || "Ticket"}
            </SheetTitle>
            <SheetDescription className="sr-only">Review and approve</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4 pb-6">
            {selected ? <TicketDetailBody claim={selected} /> : null}
            <Textarea
              placeholder="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="resize-none"
            />
            {actions}
          </div>
        </SheetContent>
      </Sheet>

      <div className="mt-4 hidden lg:block">
        <Textarea
          placeholder="Approval / reject note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="resize-none"
        />
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "approve" ? "Confirm approval?" : "Reject this ticket?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "approve"
                ? "This advances the ticket to the next stage."
                : "The faculty member can edit and resubmit."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className={confirm === "reject" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              onClick={(e) => {
                e.preventDefault()
                if (confirm) act(confirm)
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function HodQueuePage() {
  return (
    <ApprovalQueue
      title="Approvals"
      subtitle="Department tickets waiting for HoD"
      statusFilter="SUBMITTED"
      approvePath="hod-approve"
      approveLabel="Approve → Principal"
    />
  )
}

export function PrincipalQueuePage() {
  return (
    <ApprovalQueue
      title="Approvals"
      subtitle="College-wide tickets after HoD"
      statusFilter="HOD_APPROVED"
      approvePath="principal-approve"
      approveLabel="Approve → Finance"
      showDept
    />
  )
}

export function PrincipalOverviewPage() {
  const [dash, setDash] = useState<{
    by_status?: Record<string, number>
    total_paid?: number
  } | null>(null)

  useEffect(() => {
    api<{ by_status?: Record<string, number>; total_paid?: number }>("/api/dashboard")
      .then(setDash)
      .catch(() => toast.error("Could not load overview"))
  }, [])

  const by = dash?.by_status || {}

  return (
    <div>
      <PageHeader title="Overview" subtitle="Pipeline across the college" />
      <StatStrip
        items={[
          { label: "With HoD", value: by.SUBMITTED || 0 },
          { label: "With you", value: by.HOD_APPROVED || 0 },
          { label: "With Finance", value: by.PRINCIPAL_APPROVED || 0 },
          { label: "Paid", value: by.PAID || 0 },
        ]}
      />
      <p className="mt-8 text-sm text-muted-foreground">
        Paid total:{" "}
        <span className="font-semibold text-foreground">
          <Money value={dash?.total_paid || 0} />
        </span>
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link to="/principal">Open queue</Link>
      </Button>
    </div>
  )
}
