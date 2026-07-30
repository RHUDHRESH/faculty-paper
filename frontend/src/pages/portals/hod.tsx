"use client"

import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { AnimatePresence, motion } from "framer-motion"
import { AlertTriangle, CheckCircle2, Inbox, MousePointerClick, Search } from "lucide-react"
import { toast } from "sonner"

import {
  EmptyState,
  FilterBar,
  MasterDetail,
  PageHeader,
  Section,
  StatStrip,
} from "@/components/layout/page"
import {
  ContestCallout,
  Money,
  StatusChip,
  StatusTimeline,
  VerificationSnapshot,
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
    <div className="space-y-4">
      <StatusTimeline status={claim.status} />

      <div>
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold leading-snug">
          {claim.paper_title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {claim.owner_name}
          {claim.owner_department ? ` · ${claim.owner_department}` : ""}
        </p>
        {claim.journal_title ? (
          <p className="text-sm text-muted-foreground">{claim.journal_title}</p>
        ) : null}
      </div>

      {/* Contest note: first-class callout */}
      <ContestCallout note={claim.contest_note} />

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-2.5 rounded-[var(--radius)] bg-muted/50 p-3.5 text-sm">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            SNIP
          </div>
          <div className="mt-0.5 font-medium">{claim.snip ?? "—"}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Quartile
          </div>
          <div className="mt-0.5 font-medium">{claim.quartile || "—"}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Indexing
          </div>
          <div className="mt-0.5 font-medium">{claim.indexing_status || "—"}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Amount
          </div>
          <div className="mt-0.5 text-base font-semibold text-primary">
            <Money value={claim.remuneration} />
          </div>
        </div>
      </div>

      {/* Verification issues — shown prominently */}
      {snap?.issues?.length ? (
        <div className="rounded-[var(--radius)] border border-amber-200/80 bg-amber-50 px-4 py-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-amber-800/80">
            <AlertTriangle className="size-3.5" aria-hidden />
            Verification issues
          </p>
          <ul className="mt-2 space-y-1.5">
            {snap.issues.map((issue) => (
              <li key={issue} className="flex items-start gap-2 text-sm text-amber-900">
                <span className="mt-0.5 shrink-0 text-amber-500" aria-hidden>
                  ›
                </span>
                {issue}
              </li>
            ))}
          </ul>
        </div>
      ) : snap !== null ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
          Verification snapshot is clean
        </p>
      ) : null}

      {/* Scopus verification details */}
      {snap?.scopus ? (
        <VerificationSnapshot snapshot={snap.scopus} />
      ) : null}

      {claim.scopus_url ? (
        <a
          className="inline-flex items-center text-sm text-primary underline-offset-4 hover:underline"
          href={claim.scopus_url}
          target="_blank"
          rel="noreferrer"
        >
          Open Scopus record ↗
        </a>
      ) : null}

      {(claim.actions || []).length > 0 ? (
        <>
          <Separator />
          <ul className="space-y-1.5 text-sm">
            {(claim.actions || []).map((a) => (
              <li key={a.id} className="text-muted-foreground">
                <span className="font-medium text-foreground">{a.action}</span>
                {" · "}
                {a.actor_name}
                {" · "}
                <span className="tabular-nums">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
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

  const listPanel = (
    <div className="overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card">
      {loading ? (
        <div className="space-y-px p-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-[calc(var(--radius)-2px)]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Inbox className="size-5" />}
          title={q ? "No matches" : "All clear"}
          description={q ? "Try a different search." : "No pending tickets in this queue."}
          className="border-0 rounded-none"
        />
      ) : (
        <AnimatePresence initial={false}>
          {filtered.map((c, i) => (
            <motion.button
              key={c.id}
              type="button"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.025, 0.12) }}
              onClick={() => openClaim(c.id)}
              className={cn(
                "flex w-full items-center gap-3 border-b border-border/60 px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-accent/40 active:bg-accent/60",
                selected?.id === c.id && "bg-accent/50"
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {c.ticket_number}
                  </span>
                  <StatusChip status={c.status} contest={c.contest_forward} />
                </div>
                <div className="mt-0.5 line-clamp-1 text-sm font-medium leading-snug">
                  {c.paper_title}
                </div>
                <div className="text-xs text-muted-foreground">
                  {c.owner_name}
                  {showDept && c.owner_department ? ` · ${c.owner_department}` : ""}
                </div>
              </div>
              <div className="shrink-0 text-sm font-semibold tabular-nums">
                <Money value={c.remuneration} />
              </div>
            </motion.button>
          ))}
        </AnimatePresence>
      )}
    </div>
  )

  const detailPanel = selected ? (
    <div className="sticky top-20 flex max-h-[calc(100vh-5.5rem)] flex-col overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card">
      <div className="flex-1 overflow-y-auto p-5">
        <TicketDetailBody claim={selected} />
      </div>
      {/* Sticky actions footer inside the detail panel */}
      <div className="shrink-0 space-y-2.5 border-t border-border/70 bg-card/95 px-4 py-3 backdrop-blur">
        <Textarea
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="resize-none text-sm"
        />
        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={busy}
            onClick={() => setConfirm("approve")}
            onKeyDown={(e) => e.key === "Enter" && setConfirm("approve")}
          >
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
      </div>
    </div>
  ) : (
    <EmptyState
      icon={<MousePointerClick className="size-5" />}
      title="Select a ticket"
      description="Click any ticket in the list to review its details."
    />
  )

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />

      <FilterBar className="mb-4">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search ticket, paper, faculty…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </FilterBar>

      <MasterDetail list={listPanel} detail={detailPanel} />

      {/* Mobile sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[92vh] overflow-y-auto rounded-t-[1.25rem] lg:hidden"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="font-mono text-base text-primary">
              {selected?.ticket_number || "Ticket"}
            </SheetTitle>
            <SheetDescription className="sr-only">Review and approve or reject</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4 pb-8">
            {selected ? <TicketDetailBody claim={selected} /> : null}
            <Textarea
              placeholder="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="resize-none"
            />
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={busy}
                onClick={() => setConfirm("approve")}
              >
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
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "approve" ? "Confirm approval?" : "Reject this ticket?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "approve"
                ? "This advances the ticket to the next stage."
                : "The faculty member will be notified and can edit and resubmit."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className={
                confirm === "reject"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
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
      subtitle="Department tickets waiting for HoD sign-off"
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
      subtitle="College-wide tickets cleared by HoD"
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
    <div className="space-y-8">
      <PageHeader title="Overview" subtitle="Live pipeline across the college" />

      <Section
        title="Pipeline"
        description="How many claims are at each stage right now."
      >
        <StatStrip
          items={[
            { label: "With HoD", value: by.SUBMITTED ?? 0 },
            { label: "With you", value: by.HOD_APPROVED ?? 0 },
            { label: "With Finance", value: by.PRINCIPAL_APPROVED ?? 0 },
            { label: "Paid out", value: by.PAID ?? 0 },
          ]}
        />
      </Section>

      <Section title="Disbursements">
        <div className="flex items-center justify-between rounded-[var(--radius)] border border-border/80 bg-card px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Total paid to date
            </p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">
              <Money value={dash?.total_paid ?? 0} size="lg" />
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/principal">Open queue</Link>
          </Button>
        </div>
      </Section>
    </div>
  )
}
