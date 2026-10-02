import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ChevronDown, ChevronUp, Keyboard, PanelLeft, PanelLeftClose } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { paperTitle } from "@/lib/names"
import { Button } from "@/ui/button"
import { CopyButton } from "@/ui/copy"
import { stageOf } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { ClaimThread, type ThreadStage } from "@/ui/thread"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog"
import { useQueueKeys } from "@/ui/queue-keys"
import { checklistItems, composeSendBackReason, useMarks } from "@/ui/review-marks"
import { ErrorState, Skeleton, SkeletonText } from "@/ui/state"

import { useChecklist } from "./checklist"
import { AuthoriseBar } from "./authorise-bar"
import { DecisionBar, type DecisionDialog } from "./decision-bar"
import { DecisionDialogs } from "./decision-dialogs"
import { requestMark } from "./events"
import { ResizeHandle, useStoredWidth } from "./panes"
import { QueueRail } from "./queue-rail"
import { PANEL_SECTIONS, ReviewPanel, type PanelSection } from "./review-panel"
import type { QueueName, WorkspaceBundle } from "./types"
import { filterRows, isQueueName, nextAfter, QUEUE_LABEL, QUEUE_PATH, useRail } from "./use-rail"
import { DocumentViewer } from "./viewer/document-viewer"

/**
 * `/review/:claimId`: the full-page place a claim is judged.
 *
 * The side sheet it replaces showed the record and offered a link to open
 * the PDFs in another tab. A reviewer's job is the comparison, so the paper
 * and the record have to be on screen together: the queue on the left, the
 * document in the middle (the biggest thing on the page), the claim against
 * the record on the right, and the decision along the bottom, always in view.
 *
 * Below the desktop breakpoint the three areas become tabs, because three
 * columns on a phone is three unreadable slivers.
 *
 * The page is outside the app's sidebar shell on purpose: the shell's
 * padding and navigation would take a third of the height the document needs.
 * "Back to the queue" is the way out, and Ctrl K still works.
 */

type Tab = "document" | "review" | "queue"

const TABS: { id: Tab; label: string }[] = [
  { id: "document", label: "Document" },
  { id: "review", label: "Review" },
  { id: "queue", label: "Queue" },
]

export function ReviewWorkspace() {
  const { claimId = "" } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { me } = useAuth()
  const perms = can(me?.role)

  const queueParam = params.get("queue")
  // A link without a queue lands in the reader's own: the Principal's
  // approvals and the Director's authorisations are not the clearing queue.
  const ownQueue: QueueName = me?.role === "PRINCIPAL" ? "approvals" : me?.role === "DIRECTOR" ? "authorisations" : "clearing"
  const queue: QueueName = isQueueName(queueParam) ? queueParam : ownQueue

  // One request for the whole page. The answer also fills the caches the
  // older components read (the claim, its flags), so none of them asks again.
  const bundle = useApi<WorkspaceBundle>(["review-workspace", claimId], `/api/claims/${claimId}/workspace`, {
    enabled: !!claimId,
    queryFn: async () => {
      const b = await api<WorkspaceBundle>(`/api/claims/${claimId}/workspace`)
      qc.setQueryData(["claim", claimId], b.claim)
      if (b.review) qc.setQueryData(["claim-review", claimId], b.review)
      return b
    },
  })
  const claim = bundle.data?.claim
  const own = bundle.data?.own ?? false

  /* ---- the queue ------------------------------------------------------- */

  const rail = useRail(queue, true)
  const [railFilter, setRailFilter] = useState(() => params.get("filter") ?? "")
  const rows = useMemo(() => filterRows(rail.rows, railFilter), [rail.rows, railFilter])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const at = rows.findIndex((r) => r.id === claimId)

  const hrefFor = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params)
      return `/review/${id}${next.toString() ? `?${next.toString()}` : ""}`
    },
    [params]
  )

  const openClaim = useCallback((id: string) => navigate(hrefFor(id), { replace: true }), [hrefFor, navigate])

  const move = useCallback(
    (delta: 1 | -1) => {
      const list = rowsRef.current
      if (list.length === 0) return
      const from = list.findIndex((r) => r.id === claimId)
      const target = list[from < 0 ? (delta > 0 ? 0 : list.length - 1) : from + delta]
      if (target) openClaim(target.id)
    },
    [claimId, openClaim]
  )

  // After a decision the next claim opens: the queue is worked one claim
  // after another, not returned to a list to find the place again.
  const afterDecision = useCallback(() => {
    const next = nextAfter(rowsRef.current, claimId) ?? nextAfter(rail.rows, claimId)
    if (next) openClaim(next.id)
    else navigate(QUEUE_PATH[queue])
  }, [claimId, navigate, openClaim, queue, rail.rows])

  /* ---- what is open ---------------------------------------------------- */

  const [tab, setTab] = useState<Tab>("document")
  const [docIndex, setDocIndex] = useState(0)
  const [dialog, setDialog] = useState<DecisionDialog | null>(null)
  const [section, setSection] = useState<PanelSection>("check")
  const [keysOpen, setKeysOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("review.rail") !== "closed")

  useEffect(() => {
    setDocIndex(0)
    setDialog(null)
  }, [claimId])

  useEffect(() => {
    localStorage.setItem("review.rail", railOpen ? "open" : "closed")
  }, [railOpen])

  const [railWidth, setRailWidth] = useStoredWidth("rail", 264, 200, 420)
  const [panelWidth, setPanelWidth] = useStoredWidth("panel", 440, 320, 720)

  const files = claim?.attachments ?? []
  const [checklist, setChecklist] = useChecklist(claimId)
  const marks = useMarks(claimId)

  const atMyDesk = !!claim && !own && claim.status === "SUBMITTED" && perms.clear
  // The Principal's own step: a cleared claim that is not hers.
  const atMyApproval = !!claim && !own && claim.status === "CLEARED" && perms.approve
  const step = useCallback(
    (delta: 1 | -1) => {
      if (files.length === 0) return
      setDocIndex((i) => (i + delta + files.length) % files.length)
      setTab("document")
    },
    [files.length]
  )

  const showPanel = useCallback((s: PanelSection) => {
    setSection(s)
    setTab("review")
  }, [])

  const keys = useMemo<Record<string, () => void>>(
    () => ({
      j: () => move(1),
      k: () => move(-1),
      "[": () => step(-1),
      "]": () => step(1),
      m: () => {
        setTab("document")
        requestMark()
      },
      c: () => atMyDesk && setDialog("clear"),
      a: () => atMyApproval && claim?.remuneration != null && setDialog("approve"),
      s: () => (atMyDesk || atMyApproval) && setDialog("sendback"),
      h: () => (atMyDesk || atMyApproval) && setDialog(claim?.on_hold ? null : "hold"),
      f: () => perms.clear && !own && setDialog("flag"),
      "?": () => setKeysOpen(true),
      "1": () => showPanel(PANEL_SECTIONS[0]),
      "2": () => showPanel(PANEL_SECTIONS[1]),
      "3": () => showPanel(PANEL_SECTIONS[2]),
      "4": () => showPanel(PANEL_SECTIONS[3]),
    }),
    [atMyDesk, atMyApproval, claim?.on_hold, claim?.remuneration, move, step, perms.clear, own, showPanel]
  )
  useQueueKeys(keys, !!claim)

  // The queue's `s` opens a claim already asking to send it back (`?do=sendback`),
  // once, when the claim is at this desk. The address is cleaned so a refresh
  // does not ask again.
  const wanted = params.get("do")
  useEffect(() => {
    if (!wanted || !claim) return
    if ((atMyDesk || atMyApproval) && (wanted === "sendback" || wanted === "clear" || wanted === "hold")) setDialog(wanted)
    const next = new URLSearchParams(params)
    next.delete("do")
    navigate(`/review/${claimId}${next.toString() ? `?${next.toString()}` : ""}`, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, claim?.id, atMyDesk, atMyApproval])

  const thread = ((claim?.status ? stageOf(claim.status).step : null)?.toLowerCase() ?? null) as ThreadStage | null

  /* ---- the states before the page is there ----------------------------- */

  if (bundle.isError) {
    const status = bundle.error?.status
    return (
      <Frame queue={queue}>
        <div className="mx-auto w-full max-w-md p-8">
          <ErrorState
            title={status === 403 ? "This claim is not open to this account" : status === 404 ? "There is no such claim" : "Could not open this claim"}
            message={
              status === 403
                ? "The review workspace is for the desks that check and approve claims."
                : status === 404
                  ? "It may have been removed, or the link is wrong."
                  : "The server did not answer. Nothing has been changed."
            }
            onRetry={status === 403 || status === 404 ? false : () => void bundle.refetch()}
          />
        </div>
      </Frame>
    )
  }

  const isSuperAdmin = me?.role === "SUPER_ADMIN"

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-bg text-fg">
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-2 py-1.5 sm:px-3">
        <Link
          to={QUEUE_PATH[queue]}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-fg-muted hover:bg-hover hover:text-fg max-sm:h-10"
        >
          <ArrowLeft className="size-4" aria-hidden />
          <span className="max-sm:sr-only">{QUEUE_LABEL[queue]}</span>
        </Link>
        <span aria-hidden className="h-5 w-px shrink-0 bg-line" />
        {claim ? (
          <>
            <Avatar
              person={{ name: claim.owner_name, initials: initialsOf(claim.owner_name), photo_url: claim.owner_photo_url ?? null }}
              size="sm"
              className="max-sm:hidden"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                <span className="font-medium">{claim.owner_name}</span>
                {claim.owner_department && <span className="text-fg-muted"> · {claim.owner_department}</span>}
              </p>
              <p className="flex min-w-0 items-center gap-0.5 text-xs text-fg-muted">
                <span className="tabular shrink-0">{claim.ticket_number || "No claim no."}</span>
                {claim.ticket_number && <CopyButton value={claim.ticket_number} label="claim number" />}
                <span className="hidden min-w-0 truncate md:inline" title={claim.paper_title}>
                  · {paperTitle(claim.paper_title)}
                </span>
              </p>
            </div>
            {thread && <ClaimThread at={thread} className="hidden w-[24rem] shrink-0 xl:grid" />}
            {claim.waiting_days != null && claim.status === "SUBMITTED" && (
              <span
                className={cn(
                  "hidden shrink-0 text-sm tabular sm:inline",
                  claim.waiting_days > 30 ? "font-medium text-critical" : claim.waiting_days > 14 ? "font-medium text-caution" : "text-fg-muted"
                )}
              >
                {claim.waiting_days <= 0 ? "Filed today" : `${claim.waiting_days} ${claim.waiting_days === 1 ? "day" : "days"} waiting`}
              </span>
            )}
          </>
        ) : (
          <Skeleton className="h-4 w-40" />
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {at >= 0 && (
            <span className="mr-1 text-xs tabular text-fg-muted" aria-live="polite">
              {at + 1} of {rows.length}
            </span>
          )}
          <Button kind="quiet" size="icon" aria-label="Previous claim" aria-keyshortcuts="k" disabled={rows.length === 0 || at === 0} onClick={() => move(-1)}>
            <ChevronUp />
          </Button>
          <Button kind="quiet" size="icon" aria-label="Next claim" aria-keyshortcuts="j" disabled={rows.length === 0 || at === rows.length - 1} onClick={() => move(1)}>
            <ChevronDown />
          </Button>
          <Button kind="quiet" size="icon" aria-label="Keyboard shortcuts" className="max-lg:hidden" onClick={() => setKeysOpen(true)}>
            <Keyboard />
          </Button>
          <Button
            kind="quiet"
            size="icon"
            aria-label={railOpen ? "Hide the queue" : "Show the queue"}
            aria-pressed={railOpen}
            className="max-lg:hidden"
            onClick={() => setRailOpen((v) => !v)}
          >
            {railOpen ? <PanelLeftClose /> : <PanelLeft />}
          </Button>
        </span>
      </header>

      <div role="tablist" aria-label="Parts of the workspace" className="flex shrink-0 gap-1 border-b border-line bg-bg px-2 pt-1 lg:hidden">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "h-10 flex-1 rounded-t-md text-sm",
              tab === t.id ? "bg-surface font-medium shadow-[inset_0_-2px_0_var(--color-accent)]" : "text-fg-muted hover:bg-hover"
            )}
          >
            {t.label}
            {t.id === "queue" && rows.length > 0 && <span className="ml-1 tabular text-fg-subtle">{rows.length}</span>}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Queue"
          style={{ ["--w" as string]: `${railWidth}px` }}
          className={cn(
            "min-h-0 w-full shrink-0 border-r border-line lg:w-[var(--w)]",
            tab === "queue" ? "block" : "hidden",
            railOpen ? "lg:block" : "lg:hidden"
          )}
        >
          <QueueRail
            rows={rows}
            total={rail.rows.length}
            currentId={claimId}
            hrefFor={hrefFor}
            isLoading={rail.isLoading}
            isError={rail.isError}
            onRetry={() => void rail.refetch()}
            filter={railFilter}
            onFilter={setRailFilter}
            title={QUEUE_LABEL[queue]}
          />
        </aside>
        {railOpen && (
          <ResizeHandle edge="left" width={railWidth} min={200} max={420} onChange={setRailWidth} label="Resize the queue" />
        )}

        <main
          aria-label="Document"
          className={cn("min-h-0 min-w-0 flex-1 flex-col lg:flex", tab === "document" ? "flex" : "hidden")}
        >
          {claim ? (
            <DocumentViewer claimId={claim.id} files={files} index={docIndex} onIndex={setDocIndex} proofLinks={proofLinks(claim)} />
          ) : (
            <div className="grid h-full place-items-center bg-sunken p-8" role="status" aria-label="Opening the claim">
              <div className="w-full max-w-sm space-y-3">
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-72 w-full" />
              </div>
            </div>
          )}
        </main>

        <ResizeHandle edge="right" width={panelWidth} min={320} max={720} onChange={setPanelWidth} label="Resize the review panel" />
        <section
          aria-label="Review"
          style={{ ["--w" as string]: `${panelWidth}px` }}
          className={cn(
            "min-h-0 w-full shrink-0 overflow-y-auto overscroll-contain border-l border-line bg-bg lg:block lg:w-[var(--w)]",
            tab === "review" ? "block" : "hidden"
          )}
        >
          {claim ? (
            <ReviewPanel
              claim={claim}
              role={me?.role}
              checklist={checklist}
              onChecklist={setChecklist}
              extras={{ own, showFlags: bundle.data?.review != null }}
              section={section}
              onSection={setSection}
              markCount={marks.marks.length}
            />
          ) : (
            <div className="space-y-4 p-4">
              <Skeleton className="h-10 w-2/3" />
              <SkeletonText lines={6} />
            </div>
          )}
        </section>
      </div>

      {claim && (
        <>
          {queue === "authorisations" && perms.authorise && (me?.role === "DIRECTOR" || claim.status === "PRINCIPAL_APPROVED") ? (
            <AuthoriseBar claim={claim} own={own} isSuperAdmin={isSuperAdmin} onDone={afterDecision} />
          ) : (
            <DecisionBar claim={claim} own={own} canClear={perms.clear} canApprove={perms.approve} isSuperAdmin={isSuperAdmin} queue={queue} open={setDialog} />
          )}

          {!own && (
            <DecisionDialogs
              claim={claim}
              dialog={dialog}
              setDialog={setDialog}
              isSuperAdmin={isSuperAdmin}
              sendBackReason={composeSendBackReason(marks.marks, checklistItems(checklist))}
              onDone={afterDecision}
            />
          )}
        </>
      )}

      <KeysDialog open={keysOpen} onOpenChange={setKeysOpen} />
    </div>
  )
}

/** The proof a claimant linked in place of uploading (only web links, never a script). */
function proofLinks(claim: { proof_url?: string | null; sec_proof_url?: string | null }): { label: string; url: string }[] {
  const web = (u: string) => /^https?:\/\//i.test(u)
  const out: { label: string; url: string }[] = []
  for (const u of (claim.proof_url ?? "").split(/[\s,]+/).filter(web)) out.push({ label: "Open the paper proof", url: u })
  const refs = (claim.sec_proof_url ?? "").split(/[\s,]+/).filter(web)
  refs.forEach((u, i) => out.push({ label: refs.length === 1 ? "Open the reference proof" : `Open reference proof ${i + 1}`, url: u }))
  return out
}

/** The bare page with a way out, for when there is no claim to show. */
function Frame({ queue, children }: { queue: QueueName; children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col bg-bg">
      <header className="border-b border-line bg-surface px-3 py-1.5">
        <Link to={QUEUE_PATH[queue]} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-fg-muted hover:bg-hover hover:text-fg">
          <ArrowLeft className="size-4" aria-hidden /> {QUEUE_LABEL[queue]}
        </Link>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  )
}

const KEYS: [string, string][] = [
  ["j", "Next claim in the queue"],
  ["k", "Previous claim in the queue"],
  ["c", "Clear this claim (the research cell)"],
  ["a", "Approve this claim (the Principal)"],
  ["s", "Send this claim back"],
  ["h", "Hold this claim"],
  ["f", "Flag this claim"],
  ["m", "Add a mark to the document"],
  ["[", "Previous file"],
  ["]", "Next file"],
  ["1 to 4", "Check, Marks, Past cases, History"],
  ["Ctrl Enter", "Send a typed reason"],
  ["?", "This list"],
]

function KeysDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Keys in the workspace</DialogTitle>
          <DialogDescription>They work anywhere on the page except while you are typing.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <dl className="space-y-2 text-sm">
            {KEYS.map(([key, what]) => (
              <div key={key} className="flex items-center justify-between gap-4">
                <dt className="text-fg-muted">{what}</dt>
                <dd>
                  <kbd className="rounded border border-edge px-1.5 py-0.5 text-xs">{key}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </DialogBody>
        <DialogFooter>
          <Button kind="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
