"use client"

import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { AlertTriangle, CheckCircle2, Inbox, MousePointerClick, Search } from "lucide-react"
import { toast } from "sonner"

import {
  EmptyState,
  ErrorState,
  FilterBar,
  MasterDetail,
  PageHeader,
  Section,
  StatStrip,
} from "@/components/layout/page"
import { ClaimDetailFields } from "@/components/claim-detail-fields"
import {
  ContestCallout,
  CopyTicketLink,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { api, parseVerifySnapshot, type Claim, type Paginated } from "@/lib/api"
import { actionSentence } from "@/lib/claim-actions"
import { Pager } from "@/components/ui/pagination"
import { useApiQuery } from "@/lib/queries"
import { useIsDesktop } from "@/lib/use-media-query"
import { cn } from "@/lib/utils"

type QueueProps = {
  title: string
  subtitle: string
  statusFilter: string
  /** Omitted for the oversight portals, which look but never act. */
  approvePath?: "clear"
  approveLabel?: string
  showDept?: boolean
  /** No note box, no approve, no reject — the oversight portals are read-only. */
  readOnly?: boolean
  emptyTitle?: string
  emptyDescription?: string
}

function TicketDetailBody({ claim }: { claim: Claim }) {
  const snap = parseVerifySnapshot(claim.verification_snapshot_json)
  return (
    <div className="space-y-4">
      <StatusTimeline status={claim.status} />

      <div>
        <h2 className="text-lg font-semibold leading-snug tracking-tight">
          {claim.paper_title}
        </h2>
        <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
          {claim.owner_name}
          {claim.owner_department ? ` · ${claim.owner_department}` : ""}
          <CopyTicketLink claimId={claim.id} />
        </p>
      </div>

      <ContestCallout note={claim.contest_note} />

      <ClaimDetailFields claim={claim} showOwner />

      {/* Verification issues — shown prominently. Dark-mode variants matter
          here: this panel is what an approver reads before clearing money,
          and it used to render as a glaring white-yellow slab in dark mode. */}
      {snap?.issues?.length ? (
        <div className="rounded-[var(--radius)] border border-amber-200/80 bg-amber-50 px-4 py-3 dark:border-amber-500/30 dark:bg-amber-950/40">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-amber-800/80 dark:text-amber-300/90">
            <AlertTriangle className="size-3.5" aria-hidden />
            Verification issues
          </p>
          <ul className="mt-2 space-y-1.5">
            {snap.issues.map((issue) => (
              <li
                key={issue}
                className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-100"
              >
                <span className="mt-0.5 shrink-0 text-amber-500" aria-hidden>
                  ›
                </span>
                {issue}
              </li>
            ))}
          </ul>
        </div>
      ) : snap !== null ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
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
                <span className="font-medium text-foreground">{a.actor_name}</span>{" "}
                {actionSentence(a.action)}
                {a.note ? <span className="block pl-3 text-xs italic">“{a.note}”</span> : null}
                <span className="block pl-3 text-xs tabular-nums opacity-80">
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

/** The manual-verification lane: when Scopus/Scimago cannot confirm a paper,
 * the research cell enters the verified SNIP/quartile with a source note —
 * the payout is never computed from the claimant's own declaration. */
function ManualVerifyDialog({
  claim,
  open,
  onOpenChange,
  onSaved,
}: {
  claim: Claim
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved: (c: Claim) => void
}) {
  const [snip, setSnip] = useState("")
  const [quartile, setQuartile] = useState("")
  const [engineering, setEngineering] = useState("")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const noteTooShort = note.trim().length < 10

  useEffect(() => {
    if (open) {
      setSnip(claim.snip != null ? String(claim.snip) : "")
      setQuartile(claim.quartile || "")
      setEngineering(claim.engineering_class || "")
      setNote(claim.manual_verification_note || "")
    }
  }, [open, claim])

  async function save() {
    setSaving(true)
    try {
      const updated = await api<Claim>(`/api/admin/claims/${claim.id}/set-verified`, {
        method: "POST",
        json: {
          snip: snip.trim() === "" ? null : Number(snip),
          quartile: quartile || null,
          engineering_class: engineering || null,
          note: note.trim(),
        },
      })
      toast.success("Verified values saved and the amount recalculated")
      onSaved(updated)
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save verified values")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set verified values</DialogTitle>
          <DialogDescription>
            Use this when the automatic checks could not confirm the journal. The amount is
            recalculated from what you enter here — self-reported figures are never paid.
            {claim.self_reported_snip != null || claim.self_reported_quartile ? (
              <span className="mt-1 block">
                Claimant declared:{" "}
                {claim.self_reported_snip != null ? `SNIP ${claim.self_reported_snip}` : ""}
                {claim.self_reported_snip != null && claim.self_reported_quartile ? " · " : ""}
                {claim.self_reported_quartile || ""}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="mv-snip">SNIP</Label>
              <Input
                id="mv-snip"
                inputMode="decimal"
                placeholder="e.g. 1.24"
                value={snip}
                onChange={(e) => setSnip(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mv-quartile">Quartile</Label>
              <select
                id="mv-quartile"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={quartile}
                onChange={(e) => setQuartile(e.target.value)}
              >
                <option value="">Not set</option>
                {["Q1", "Q2", "Q3", "Q4"].map((qv) => (
                  <option key={qv} value={qv}>
                    {qv}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mv-eng">Engineering classification</Label>
            <select
              id="mv-eng"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={engineering}
              onChange={(e) => setEngineering(e.target.value)}
            >
              <option value="">Not set</option>
              <option value="Engineering">Engineering</option>
              <option value="Non-Engineering">Non-Engineering</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mv-note">Source note</Label>
            <Textarea
              id="mv-note"
              rows={2}
              placeholder="Where do these values come from? e.g. Scopus source page for ISSN 1234-5678, 2025"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {noteTooShort ? (
              <p className="text-xs text-muted-foreground">
                Cite the source (at least 10 characters) — it goes into the audit log.
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || noteTooShort}>
            Save & recalculate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ApprovalQueue({
  title,
  subtitle,
  statusFilter,
  approvePath,
  approveLabel,
  showDept,
  readOnly,
  emptyTitle,
  emptyDescription,
}: QueueProps) {
  const [selected, setSelected] = useState<Claim | null>(null)
  const [note, setNote] = useState("")
  const [q, setQ] = useState("")
  const [busy, setBusy] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  // On desktop the detail shows inline, so the sheet must stay shut: an open
  // sheet up here renders an invisible overlay that freezes the whole page.
  const isDesktop = useIsDesktop()
  const [confirm, setConfirm] = useState<"approve" | "reject" | "bulk" | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  // The amount shown in the clear confirmation comes from a fresh server
  // recalculation; clearing then sends it back as expected_amount, so what the
  // approver saw is exactly what gets cleared.
  const [recalc, setRecalc] = useState<{
    remuneration: number | null
    previous: number | null
    changed: boolean
    calc_error?: string | null
    remuneration_note?: string | null
  } | null>(null)
  const [overrideTo, setOverrideTo] = useState("SUBMITTED")
  // Mirrors the server rule in reject_claim: sending a ticket back without a
  // reason leaves the faculty member with nothing to act on.
  const rejectReasonTooShort = confirm === "reject" && note.trim().length < 10
  const [params] = useSearchParams()
  // Bulk clearing: the queue is routinely dozens of straightforward tickets and
  // opening each one to press the same button is most of the work.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const bulkable = !readOnly && approvePath === "clear"
  const togglePick = (id: string) =>
    setPicked((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // "ALL" means every ticket the role is allowed to see — the read-only
  // portals list the whole pipeline, not one queue. Background refetch means
  // two reviewers working the queue see each other's clears.
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState("recent")
  const statusFromUrl = params.get("status")
  const effectiveStatus =
    statusFilter === "ALL" && statusFromUrl ? statusFromUrl : statusFilter
  const PAGE = 50
  const {
    data: page,
    isLoading: loading,
    isError,
    refetch,
  } = useApiQuery<Paginated<Claim>>(
    ["claims", "queue", effectiveStatus, offset, sort],
    `/api/claims?limit=${PAGE}&offset=${offset}&sort=${sort}` +
      (effectiveStatus === "ALL" ? "" : `&status=${effectiveStatus}`)
  )
  const claims = page?.results ?? []
  const load = () => refetch()

  useEffect(() => {
    const id = params.get("claim")
    if (!id) return
    api<Claim>(`/api/claims/${id}`)
      .then((c) => {
        setSelected(c)
        setSheetOpen(!isDesktop)
      })
      .catch(() => toast.error("Could not open that ticket"))
  }, [params])

  useEffect(() => {
    if (isDesktop) setSheetOpen(false)
  }, [isDesktop])

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
    setSheetOpen(!isDesktop)
  }

  async function clearSelected() {
    if (!picked.size) return
    setBusy(true)
    try {
      const res = await api<{ cleared: number; skipped: { id: string; reason: string }[] }>(
        "/api/admin/bulk-clear",
        { method: "POST", json: { claim_ids: [...picked], note: note.trim() || null } }
      )
      toast.success(
        `${res.cleared} ticket${res.cleared === 1 ? "" : "s"} cleared and sent to Finance`
      )
      // Never silent: say which ones did not go through and why.
      for (const s of res.skipped.slice(0, 3)) toast.error(`Skipped: ${s.reason}`)
      if (res.skipped.length > 3) toast.error(`${res.skipped.length - 3} more were skipped`)
      setPicked(new Set())
      setNote("")
      setConfirm(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk clear failed")
    } finally {
      setBusy(false)
    }
  }

  async function startClear() {
    if (!selected) return
    setBusy(true)
    try {
      const r = await api<{
        remuneration: number | null
        previous: number | null
        changed: boolean
        calc_error?: string | null
        remuneration_note?: string | null
      }>(`/api/claims/${selected.id}/recalculate`, { method: "POST", json: {} })
      setRecalc(r)
      setConfirm("approve")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not recalculate the amount")
    } finally {
      setBusy(false)
    }
  }

  async function overrideStatus() {
    if (!selected) return
    if (note.trim().length < 10) {
      toast.error("Write a note of at least 10 characters explaining the override")
      return
    }
    setBusy(true)
    try {
      const c = await api<Claim>(`/api/admin/claims/${selected.id}/override-status`, {
        method: "POST",
        json: { to_status: overrideTo, note: note.trim() },
      })
      toast.success(`Status overridden to ${overrideTo}`)
      setSelected(c)
      setNote("")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Override failed")
    } finally {
      setBusy(false)
    }
  }

  async function act(kind: "approve" | "reject") {
    if (!selected) return
    if (kind === "approve" && !approvePath) return
    setBusy(true)
    try {
      const path = kind === "approve" ? approvePath! : "reject"
      await api(`/api/claims/${selected.id}/${path}`, {
        method: "POST",
        json:
          kind === "approve"
            ? { note, expected_amount: recalc?.remuneration ?? null }
            : { note },
      })
      toast.success(kind === "approve" ? "Cleared — sent to Finance" : "Sent back to the faculty")
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
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          description="The server did not respond — nothing was lost."
          onRetry={() => refetch()}
          className="border-0 rounded-none"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Inbox className="size-5" />}
          title={q ? "No matches" : emptyTitle || "All clear"}
          description={
            q ? "Try a different search." : emptyDescription || "No pending tickets in this queue."
          }
          className="border-0 rounded-none"
        />
      ) : (
        <>
          {bulkable ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={picked.size > 0 && picked.size === filtered.length}
                  onCheckedChange={(v) =>
                    setPicked(v === true ? new Set(filtered.map((c) => c.id)) : new Set())
                  }
                  aria-label="Select every ticket shown"
                />
                {picked.size ? `${picked.size} selected` : `Select all ${filtered.length}`}
              </label>
              {picked.size ? (
                <Button type="button" size="xs" disabled={busy} onClick={() => setConfirm("bulk")}>
                  Clear {picked.size} → Finance
                </Button>
              ) : null}
            </div>
          ) : null}
          {filtered.map((c) => (
            <div
              key={c.id}
              className={cn(
                "flex items-center gap-2 border-b border-border last:border-0",
                selected?.id === c.id && "bg-muted/40"
              )}
            >
            {bulkable ? (
              <span className="pl-4">
                <Checkbox
                  checked={picked.has(c.id)}
                  onCheckedChange={() => togglePick(c.id)}
                  aria-label={`Select ${c.ticket_number || "ticket"}`}
                />
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => openClaim(c.id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50"
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
            </button>
            </div>
          ))}
        </>
      )}
    </div>
  )

  const detailPanel = selected ? (
    <div className="sticky top-20 flex max-h-[calc(100vh-5.5rem)] flex-col overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card">
      <div className="flex-1 overflow-y-auto p-5">
        <TicketDetailBody claim={selected} />
      </div>
      {/* Sticky actions footer inside the detail panel */}
      {readOnly ? (
        <div className="shrink-0 space-y-2 border-t border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            View only. Clearing is handled by Admin and payment by Finance.
          </p>
        </div>
      ) : selected && selected.status !== "SUBMITTED" && approvePath === "clear" ? (
        <div className="shrink-0 space-y-2.5 border-t border-border/70 bg-card/95 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            This ticket is in <span className="font-medium">{selected.status}</span> — outside
            the live chain, so it cannot be cleared or sent back from here. A super admin can
            move it with an audited override.
          </p>
          <div className="flex gap-2">
            <select
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              value={overrideTo}
              onChange={(e) => setOverrideTo(e.target.value)}
              aria-label="Override target status"
            >
              <option value="SUBMITTED">SUBMITTED</option>
              <option value="CLEARED">CLEARED</option>
              <option value="REJECTED">REJECTED</option>
            </select>
            <Button className="flex-1" variant="outline" disabled={busy} onClick={overrideStatus}>
              Override status
            </Button>
          </div>
          <Textarea
            placeholder="Reason for the override (required, 10+ characters)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="resize-none text-sm"
          />
        </div>
      ) : (
        <div className="shrink-0 space-y-2.5 border-t border-border/70 bg-card/95 px-4 py-3">
          {approvePath === "clear" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setManualOpen(true)}
            >
              Set verified values…
            </Button>
          ) : null}
          <Textarea
            placeholder="Note — required to send back, optional to clear"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="resize-none text-sm"
          />
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => startClear()}
              onKeyDown={(e) => e.key === "Enter" && startClear()}
            >
              {approveLabel}
            </Button>
            <Button
              className="flex-1"
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirm("reject")}
            >
              Send back
            </Button>
          </div>
        </div>
      )}
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
        <select
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value)
            setOffset(0)
          }}
          aria-label="Sort tickets"
        >
          <option value="recent">Most recent</option>
          <option value="amount">Highest amount</option>
          <option value="title">Title</option>
        </select>
      </FilterBar>

      <MasterDetail
        list={
          <div>
            {listPanel}
            {page ? (
              <Pager
                total={page.total}
                limit={page.limit}
                offset={page.offset}
                onOffsetChange={(o) => {
                  setPicked(new Set())
                  setOffset(o)
                }}
              />
            ) : null}
          </div>
        }
        detail={detailPanel}
      />

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
            {readOnly ? (
              <p className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
                View only. Clearing is handled by Admin and payment by Finance.
              </p>
            ) : (
              <>
                {approvePath === "clear" && selected ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setManualOpen(true)}
                  >
                    Set verified values…
                  </Button>
                ) : null}
                <Textarea
                  placeholder="Note — required to send back, optional to clear"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  className="resize-none"
                />
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={busy}
                    onClick={() => startClear()}
                  >
                    {approveLabel}
                  </Button>
                  <Button
                    className="flex-1"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => setConfirm("reject")}
                  >
                    Send back
                  </Button>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {selected ? (
        <ManualVerifyDialog
          claim={selected}
          open={manualOpen}
          onOpenChange={setManualOpen}
          onSaved={(c) => {
            setSelected(c)
            refetch()
          }}
        />
      ) : null}

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "bulk"
                ? `Clear ${picked.size} ticket${picked.size === 1 ? "" : "s"}?`
                : confirm === "approve"
                  ? "Clear this ticket?"
                  : "Send this ticket back?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "bulk" ? (
                `${picked.size} ticket${picked.size === 1 ? "" : "s"} will be cleared and sent to Finance. Any whose amount changed on recalculation, or that are no longer awaiting clearance, are skipped and listed.`
              ) : confirm === "approve" ? (
                <>
                  The verified values were just re-checked. Clearing sends{" "}
                  <span className="font-semibold text-foreground">
                    <Money value={recalc?.remuneration ?? null} />
                  </span>{" "}
                  to Finance.
                  {recalc?.changed ? (
                    <span className="mt-1 block">
                      Note: the amount changed from{" "}
                      <Money value={recalc?.previous ?? null} /> on re-verification.
                    </span>
                  ) : null}
                  {recalc?.calc_error ? (
                    <span className="mt-1 block">{recalc.calc_error}</span>
                  ) : recalc?.remuneration === 0 && recalc?.remuneration_note ? (
                    <span className="mt-1 block">{recalc.remuneration_note}</span>
                  ) : null}
                </>
              ) : rejectReasonTooShort ? (
                "Write a note of at least 10 characters first — it is the only thing the faculty member sees explaining what to fix."
              ) : (
                "The faculty member will be notified and can edit and resubmit."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || rejectReasonTooShort}
              className={
                confirm === "reject"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              onClick={(e) => {
                e.preventDefault()
                if (confirm === "bulk") clearSelected()
                else if (confirm) act(confirm)
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

/** Admin clearing — the single approval between submission and payment. */
export function AdminClearingQueuePage() {
  return (
    <ApprovalQueue
      title="Clearing queue"
      subtitle="Submitted tickets waiting to be cleared for payment"
      statusFilter="SUBMITTED"
      approvePath="clear"
      approveLabel="Clear → Finance"
      showDept
      emptyTitle="Nothing waiting"
      emptyDescription="Every submitted ticket has been cleared or sent back."
    />
  )
}

export function PrincipalQueuePage() {
  return (
    <ApprovalQueue
      title="All tickets"
      subtitle="Every claim across the college, at every stage"
      statusFilter="ALL"
      showDept
      readOnly
      emptyTitle="No tickets yet"
      emptyDescription="Nothing has been filed."
    />
  )
}

export function PrincipalOverviewPage() {
  const { data: dash, isError, refetch } = useApiQuery<{
    by_status?: Record<string, number>
    total_paid?: number
  }>(["dashboard", "principal"], "/api/dashboard")

  const by = dash?.by_status || {}

  return (
    <div className="space-y-8">
      <PageHeader title="Overview" subtitle="Live pipeline across the college" />

      {isError ? (
        <ErrorState
          title="Could not load overview"
          description="The pipeline numbers did not load."
          onRetry={() => refetch()}
        />
      ) : (
      <>
      <Section
        title="Pipeline"
        description="How many claims are at each stage right now."
      >
        <StatStrip
          items={[
            { label: "Drafts", value: by.DRAFT ?? 0 },
            {
              label: "Awaiting clearance",
              value: (by.SUBMITTED ?? 0) + (by.HOD_APPROVED ?? 0),
              to: "/principal?status=SUBMITTED",
            },
            {
              label: "With Finance",
              value:
                (by.CLEARED ?? 0) +
                (by.PRINCIPAL_APPROVED ?? 0) +
                (by.FINANCE_APPROVED ?? 0) +
                (by.RESEARCH_APPROVED ?? 0),
              to: "/principal?status=CLEARED",
            },
            { label: "Paid out", value: by.PAID ?? 0, to: "/principal?status=PAID" },
          ]}
        />
      </Section>

      <Section title="Disbursements">
        <div className="flex items-center justify-between rounded-[var(--radius)] border border-border/80 bg-card px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Total paid to date
            </p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">
              <Money value={dash?.total_paid ?? 0} size="lg" />
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/principal">Open queue</Link>
          </Button>
        </div>
      </Section>
      </>
      )}
    </div>
  )
}
