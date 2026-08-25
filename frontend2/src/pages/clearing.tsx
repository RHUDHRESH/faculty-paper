import { useEffect, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Paperclip,
  RefreshCw,
  XCircle,
} from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, Field, Textarea } from "@/ui/field"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/ui/sheet"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows, SkeletonText } from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { money } from "@/ui/paper"
import { toast } from "@/ui/toast"

/**
 * The research cell's daily job: every submitted ticket, oldest first, and
 * the one screen where a figure turns into a payment on its way.
 *
 * Two things this page cannot afford to get wrong. First, the order —
 * `waiting_days` is not decoration, it is the queue's own priority, so
 * nothing here re-sorts what the server already put oldest-first. Second,
 * the amount: a reader confirms the number the screen showed them, the
 * server recomputes it inside the same request, and if those two figures
 * disagree it clears nothing and answers 409. A screen that resent the old
 * number after that, or hid the mismatch behind a generic error, is exactly
 * how a stale amount gets paid.
 */

/* ------------------------------------------------------------------------ */
/* Types — read out of claim_to_dict() in backend/core/api.py               */
/* ------------------------------------------------------------------------ */

type Attachment = {
  id: string
  kind: string
  url: string
  filename: string
  size_bytes: number | null
}

type DuplicateMatch = {
  source?: string | null
  id?: string | null
  title?: string | null
  amount?: number | null
  reference?: string | null
  who?: string | null
  when?: string | null
}

type ClaimAction = {
  id: string
  action: string
  from_status: string | null
  to_status: string
  note: string | null
  actor_name: string
  created_at: string
}

/** What every row of the queue carries — `claim_to_dict()` returns the full
 *  record for each row, so the fields the list needs and the fields the
 *  sheet needs live on the same shape; only `actions` (the history) is
 *  missing until `GET /api/claims/{id}` is fetched for the open ticket. */
type QueueClaim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  doi: string | null
  issn: string | null
  publication_year: number | null
  publication_date: string | null
  publication_type: string | null
  status: string
  owner_name: string
  owner_email: string
  owner_department: string | null
  remuneration: number | null
  remuneration_is_estimate: boolean
  qf_amount: number | null
  base_amount: number | null
  author_point: number | null
  remuneration_category: string | null
  remuneration_note: string | null
  snip: number | null
  snip_source: "SCOPUS" | "SNIP_DUMP" | "MANUAL" | null
  self_reported_snip: number | null
  quartile: string | null
  quartile_source: "SCIMAGO" | "MANUAL" | null
  self_reported_quartile: string | null
  manual_verified_by_name: string | null
  manual_verification_note: string | null
  scimago_sjr: number | null
  scimago_dataset_year: number | null
  author_position: number | null
  total_authors: number | null
  authors_json: string | null
  attachments: Attachment[]
  duplicate_warning: boolean
  duplicate_matches_json: string | null
  override_duplicate: boolean | null
  override_reason: string | null
  override_by_name: string | null
  verification_ok: boolean | null
  verification_snapshot_json: string | null
  calc_error: string | null
  waiting_days: number | null
}

type ClaimDetail = QueueClaim & { actions?: ClaimAction[] }

type RecalcResult = {
  remuneration: number | null
  previous: number | null
  changed: boolean
  base_amount: number | null
  qf_amount: number | null
  remuneration_category: string | null
  remuneration_note: string | null
  calc_error: string | null
}

type BulkClearResult = {
  cleared: number
  skipped: { id: string; reason: string }[]
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Clearing() {
  const { me } = useAuth()
  const allowed = can(me?.role).clear

  const {
    data: claims,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useApi<QueueClaim[]>(
    ["clearing-queue"],
    "/api/admin/clearing-queue?status=SUBMITTED",
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const rows = claims ?? []

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkResult, setBulkResult] = useState<{
    result: BulkClearResult
    lookup: Map<string, QueueClaim>
  } | null>(null)

  // A refresh underneath a selection must not wipe it — but a ticket that
  // stopped being in the queue (cleared by someone else, or by this bulk
  // action) has to leave the selection too, or "12 selected" keeps counting
  // a row that no longer exists.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(rows.map((c) => c.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims])

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, rows.length - 1)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // A sheet or dialog already owns the keyboard while it is open — this
      // shortcut set is for the list.
      if (openId) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return
      if (rows.length === 0) return

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, rows.length - 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
      } else if (e.key === "x") {
        e.preventDefault()
        const row = rows[active]
        if (row) toggleSelected(row.id)
      } else if (e.key === "Enter") {
        e.preventDefault()
        const row = rows[active]
        if (row) setOpenId(row.id)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [rows, active, openId])

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const bulkClear = useApiMutation<{ claim_ids: string[]; note?: string }, BulkClearResult>(
    "/api/admin/bulk-clear",
    { invalidates: [["clearing-queue"]] }
  )

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="Only the research cell and a super admin can clear tickets."
        />
      </div>
    )
  }

  const selectedRows = rows.filter((c) => selected.has(c.id))
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const selectedMissing = selectedRows.filter((c) => c.calc_error || c.remuneration == null).length

  const allVisibleSelected = rows.length > 0 && rows.every((c) => selected.has(c.id))
  const someVisibleSelected = rows.some((c) => selected.has(c.id))

  async function runBulkClear() {
    const ids = [...selected]
    const lookup = new Map(rows.map((c) => [c.id, c]))
    try {
      const result = await bulkClear.mutateAsync({ claim_ids: ids })
      setBulkResult({ result, lookup })
      const skippedIds = new Set(result.skipped.map((s) => s.id))
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of ids) if (!skippedIds.has(id)) next.delete(id)
        return next
      })
      if (result.skipped.length === 0) {
        toast.ok(`Cleared — ${result.cleared} ${result.cleared === 1 ? "ticket" : "tickets"} sent to the Principal`)
      }
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Clearing queue</PageTitle>
          <Sub className="mt-1">
            Submitted tickets, oldest first — the one that has waited longest is next.
          </Sub>
        </div>
        <Button kind="quiet" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </header>

      <Meta className="block">
        <kbd className="rounded border border-edge px-1 text-[10px]">j</kbd>/
        <kbd className="rounded border border-edge px-1 text-[10px]">k</kbd> or arrows to move ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">x</kbd> to select ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">Enter</kbd> to open
      </Meta>

      {someVisibleSelected && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-accent-wash px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">{selected.size}</span> selected ·{" "}
            <span className="font-semibold tabular">{money(selectedTotal)}</span>
            {selectedMissing > 0 && (
              <span className="text-fg-muted">
                {" "}
                ({selectedMissing} without an amount, excluded from this total)
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button kind="quiet" size="sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
            <Button kind="primary" size="sm" onClick={() => setBulkConfirmOpen(true)}>
              Clear {selected.size} {selected.size === 1 ? "ticket" : "tickets"}
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={52} />
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          message="The server did not answer. Nothing has been lost or cleared."
          onRetry={() => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing waiting"
          message="Every submitted ticket has been checked. That is good news — come back when the next one lands."
        />
      ) : (
        <TableScroller minWidth="62rem">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" className={cn(stickyHeadCell, "w-10")}>
                  <Checkbox
                    checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                    onCheckedChange={() => {
                      setSelected((prev) => {
                        if (allVisibleSelected) {
                          const next = new Set(prev)
                          for (const c of rows) next.delete(c.id)
                          return next
                        }
                        return new Set([...prev, ...rows.map((c) => c.id)])
                      })
                    }}
                    aria-label={allVisibleSelected ? "Deselect all" : "Select all"}
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
                <th scope="col" className={cn(stickyHeadCell, "w-28")}>
                  <ColumnLabel>Verified</ColumnLabel>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => (
                <tr
                  key={c.id}
                  aria-selected={selected.has(c.id)}
                  onClick={() => {
                    setActive(i)
                    setOpenId(c.id)
                  }}
                  className={cn(
                    "row cursor-pointer border-b border-line last:border-b-0",
                    i === active && "bg-hover",
                    selected.has(c.id) && "bg-selected"
                  )}
                >
                  <td className="px-3 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(c.id)}
                      onCheckedChange={() => toggleSelected(c.id)}
                      aria-label={`Select ${c.paper_title || "this ticket"}`}
                    />
                  </td>
                  <td className="px-3 py-3 align-top">
                    <span className="block break-words text-base">{c.paper_title || "Untitled"}</span>
                    <Meta className="mt-0.5 block">{c.ticket_number || "Not yet ticketed"}</Meta>
                    {(c.duplicate_warning || c.calc_error || c.remuneration_is_estimate) && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {c.duplicate_warning && (
                          <RowFlag tone="critical">
                            <AlertTriangle className="size-3" /> Possible duplicate
                          </RowFlag>
                        )}
                        {c.calc_error && (
                          <RowFlag tone="critical">
                            <AlertTriangle className="size-3" /> Could not calculate
                          </RowFlag>
                        )}
                        {!c.calc_error && c.remuneration_is_estimate && (
                          <RowFlag tone="caution">Estimate</RowFlag>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <span className="block">{c.owner_name}</span>
                    {c.owner_department && <Meta className="block">{c.owner_department}</Meta>}
                  </td>
                  <td className="px-3 py-3 align-top text-sm text-fg-muted">
                    {c.journal_title || "—"}
                  </td>
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
                  <td className="px-3 py-3 align-top">
                    <VerifiedBadge ok={c.verification_ok} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}

      <TicketSheet
        openId={openId}
        onClose={() => setOpenId(null)}
        isSuperAdmin={me?.role === "SUPER_ADMIN"}
      />

      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={setBulkConfirmOpen}
        title={`Clear ${selected.size} ${selected.size === 1 ? "ticket" : "tickets"}?`}
        description={`${money(selectedTotal)} total. Each ticket is re-checked against its stored figures as it clears — a row whose amount has moved is skipped, not cleared at the wrong number.`}
        confirmLabel="Clear"
        onConfirm={runBulkClear}
      />

      {bulkResult && (
        <BulkResultDialog
          result={bulkResult.result}
          lookup={bulkResult.lookup}
          onClose={() => setBulkResult(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Row pieces                                                               */
/* ------------------------------------------------------------------------ */

function RowFlag({ tone, children }: { tone: "critical" | "caution"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium",
        tone === "critical" ? "bg-critical-wash text-critical" : "bg-caution-wash text-caution"
      )}
    >
      {children}
    </span>
  )
}

function VerifiedBadge({ ok }: { ok: boolean | null }) {
  if (ok === true) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-positive">
        <CheckCircle2 className="size-3.5" aria-hidden /> Passed
      </span>
    )
  }
  if (ok === false) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-critical">
        <XCircle className="size-3.5" aria-hidden /> Failed
      </span>
    )
  }
  return <span className="text-sm text-fg-muted">Not checked</span>
}

function waitingLabel(days: number | null | undefined): string {
  if (days == null) return "—"
  if (days <= 0) return "Today"
  if (days === 1) return "1 day"
  return `${days} days`
}

/* ------------------------------------------------------------------------ */
/* Bulk result — every skip named, not just a count                        */
/* ------------------------------------------------------------------------ */

function BulkResultDialog({
  result,
  lookup,
  onClose,
}: {
  result: BulkClearResult
  lookup: Map<string, QueueClaim>
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            Cleared {result.cleared} of {result.cleared + result.skipped.length}
          </DialogTitle>
          <DialogDescription>
            {result.skipped.length === 0
              ? "Every selected ticket cleared."
              : "The rest were skipped — each for its own reason, below. Nothing was cleared at a wrong figure."}
          </DialogDescription>
        </DialogHeader>
        {result.skipped.length > 0 && (
          <DialogBody>
            <ul className="space-y-3">
              {result.skipped.map((s) => {
                const claim = lookup.get(s.id)
                return (
                  <li key={s.id} className="text-sm">
                    <p className="font-medium">
                      {claim?.ticket_number || claim?.paper_title || s.id}
                    </p>
                    <p className="text-fg-muted">{s.reason}</p>
                  </li>
                )
              })}
            </ul>
          </DialogBody>
        )}
        <DialogFooter>
          <Button kind="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* The ticket sheet                                                         */
/* ------------------------------------------------------------------------ */

function TicketSheet({
  openId,
  onClose,
  isSuperAdmin,
}: {
  openId: string | null
  onClose: () => void
  isSuperAdmin: boolean
}) {
  const {
    data: claim,
    isLoading,
    error,
    refetch,
  } = useApi<ClaimDetail>(["claim", openId], `/api/claims/${openId}`, { enabled: !!openId })

  const [clearOpen, setClearOpen] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)

  const duplicateMatches = parseJsonArray<DuplicateMatch>(claim?.duplicate_matches_json)
  const snapshot = parseJsonObject<{ issues?: string[] }>(claim?.verification_snapshot_json)

  return (
    <Sheet open={!!openId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        {isLoading ? (
          <>
            <SheetHeader>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="mt-2 h-4 w-1/3" />
            </SheetHeader>
            <SheetBody>
              <SkeletonText lines={5} />
            </SheetBody>
          </>
        ) : error ? (
          <>
            <SheetHeader>
              <SheetTitle>Could not open this ticket</SheetTitle>
            </SheetHeader>
            <SheetBody>
              <ErrorState onRetry={() => void refetch()} />
            </SheetBody>
          </>
        ) : claim ? (
          <>
            <SheetHeader>
              <SheetTitle className="break-words">{claim.paper_title || "Untitled"}</SheetTitle>
              <SheetDescription>
                {claim.ticket_number || "Not yet ticketed"}
                {claim.journal_title ? ` · ${claim.journal_title}` : ""}
              </SheetDescription>
            </SheetHeader>

            <SheetBody className="space-y-8">
              <section className="space-y-1">
                <SectionTitle>Claimant</SectionTitle>
                <p className="text-sm">{claim.owner_name}</p>
                <Meta className="block">
                  {[claim.owner_department, claim.owner_email].filter(Boolean).join(" · ")}
                </Meta>
              </section>

              <section className="space-y-2">
                <SectionTitle>Verification</SectionTitle>
                <VerifiedBadge ok={claim.verification_ok} />
                {snapshot?.issues && snapshot.issues.length > 0 ? (
                  <ul className="space-y-1 text-sm text-critical">
                    {snapshot.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                ) : claim.verification_ok ? (
                  <p className="text-sm text-fg-muted">No issues found.</p>
                ) : null}
              </section>

              {claim.duplicate_warning && (
                <Callout tone="critical" title="This paper may already have been paid">
                  {duplicateMatches.length > 0 ? (
                    <ul className="mt-2 space-y-1.5">
                      {duplicateMatches.map((m, i) => (
                        <li key={m.id ?? i} className="text-sm">
                          {[m.reference, m.who, m.when].filter(Boolean).join(" · ") || "A prior payment"}
                          {m.amount != null && <> — {money(m.amount)}</>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>Check the payment history before this goes any further.</p>
                  )}
                  {claim.override_duplicate && (
                    <p className="mt-2 text-sm">
                      Overridden{claim.override_by_name ? ` by ${claim.override_by_name}` : ""}
                      {claim.override_reason ? `: ${claim.override_reason}` : "."}
                    </p>
                  )}
                </Callout>
              )}

              <section className="space-y-3">
                <SectionTitle>The payout</SectionTitle>
                <p className="text-2xl font-semibold tabular">
                  {claim.calc_error ? "—" : money(claim.remuneration)}
                </p>
                {claim.remuneration_category && (
                  <p className="text-sm text-fg-muted">{claim.remuneration_category}</p>
                )}
                {claim.calc_error && (
                  <Callout tone="critical" title="This amount could not be worked out">
                    {claim.calc_error}
                  </Callout>
                )}
                {claim.remuneration_is_estimate && (
                  <Callout tone="caution" title="This is an estimate">
                    It rests on values reported by the claimant, not a verified SNIP or
                    quartile.
                  </Callout>
                )}
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  <Figure label="SNIP" value={claim.snip != null ? claim.snip.toFixed(3) : "—"} note={snipNote(claim)} />
                  <Figure label="Quartile" value={claim.quartile || "—"} note={quartileNote(claim)} />
                  <Figure label="QF amount" value={money(claim.qf_amount)} />
                  <Figure label="Base amount" value={money(claim.base_amount)} />
                </div>
                {(claim.manual_verified_by_name || claim.manual_verification_note || claim.remuneration_note) && (
                  <p className="text-sm text-fg-muted">
                    {claim.manual_verified_by_name && <>Manually verified by {claim.manual_verified_by_name}. </>}
                    {claim.manual_verification_note}
                    {claim.manual_verification_note && claim.remuneration_note ? " " : ""}
                    {claim.remuneration_note}
                  </p>
                )}
              </section>

              <section className="space-y-3">
                <SectionTitle>Attachments</SectionTitle>
                {claim.attachments.length === 0 ? (
                  <p className="text-sm text-fg-muted">Nothing attached.</p>
                ) : (
                  <ul className="divide-y divide-line border-y border-line">
                    {claim.attachments.map((a) => (
                      <li key={a.id} className="row">
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 px-1 py-2"
                        >
                          <Paperclip className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-sm">{a.filename}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-3">
                <SectionTitle>History</SectionTitle>
                {!claim.actions || claim.actions.length === 0 ? (
                  <p className="text-sm text-fg-muted">No history recorded.</p>
                ) : (
                  <ul className="space-y-3 border-l border-line pl-4">
                    {[...claim.actions].reverse().map((a) => (
                      <li key={a.id} className="text-sm">
                        <p>{actionSentence(a)}</p>
                        <Meta>
                          {a.actor_name} · {formatDateTime(a.created_at)}
                        </Meta>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </SheetBody>

            {claim.status === "SUBMITTED" && (
              <SheetFooter>
                <Button kind="danger" onClick={() => setRejectOpen(true)}>
                  Send it back
                </Button>
                <Button kind="primary" onClick={() => setClearOpen(true)}>
                  Clear
                </Button>
              </SheetFooter>
            )}

            <ClearDialog
              claim={claim}
              open={clearOpen}
              onOpenChange={setClearOpen}
              isSuperAdmin={isSuperAdmin}
              onCleared={onClose}
            />
            <RejectDialog claim={claim} open={rejectOpen} onOpenChange={setRejectOpen} onRejected={onClose} />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="tabular text-sm">{value}</p>
      {note && <p className="text-xs text-fg-subtle">{note}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Clear — recalculate, confirm at that figure, and re-confirm if it moved  */
/* ------------------------------------------------------------------------ */

/**
 * The one dialog money actually moves through.
 *
 * Opening it always recalculates first, so the amount on screen is never
 * older than this dialog. If clearing then answers 409 — the figure moved
 * again between that recalculation and the click — this does not retry with
 * the old number or the new one on its own; it names both, says plainly why,
 * and waits for a fresh, explicit "Clear" click. Resending the stale amount
 * automatically is the exact failure this guard exists to prevent.
 */
function ClearDialog({
  claim,
  open,
  onOpenChange,
  isSuperAdmin,
  onCleared,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  isSuperAdmin: boolean
  onCleared: () => void
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "changed">("loading")
  const [amount, setAmount] = useState<number | null>(null)
  const [calcError, setCalcError] = useState<string | null>(null)
  const [is502, setIs502] = useState(false)
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const recalc = useApiMutation<{ skip_external?: boolean }, RecalcResult>(
    `/api/claims/${claim.id}/recalculate`,
    // Recalculating persists the fresh verified values even if this dialog
    // is then cancelled, so the list and the sheet underneath must not go on
    // showing the figure from before this call.
    { invalidates: [["clearing-queue"], ["claim", claim.id]] }
  )
  const clear = useApiMutation<{ note?: string; expected_amount?: number }, ClaimDetail>(
    `/api/claims/${claim.id}/clear`,
    { invalidates: [["clearing-queue"], ["claim", claim.id]] }
  )

  async function runRecalc(skipExternal = false) {
    setPhase("loading")
    setIs502(false)
    try {
      const r = await recalc.mutateAsync({ skip_external: skipExternal })
      setAmount(r.remuneration)
      setCalcError(r.calc_error)
      setPhase(r.calc_error ? "error" : "ready")
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        setIs502(true)
        setPhase("error")
      } else {
        toast.fail(err)
        onOpenChange(false)
      }
    }
  }

  useEffect(() => {
    if (open) {
      setNote("")
      setChangedMessage(null)
      void runRecalc()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function confirmClear() {
    if (amount == null) return
    setBusy(true)
    setConfirmedAmount(amount)
    try {
      const result = await clear.mutateAsync({ note: note.trim() || undefined, expected_amount: amount })
      toast.ok(
        `Cleared — ${money(result.remuneration)} sent to the Principal${
          claim.ticket_number ? ` for ${claim.ticket_number}` : ""
        }`
      )
      onOpenChange(false)
      onCleared()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setChangedMessage(err.message)
        setPhase("changed")
      } else {
        toast.fail(err)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Clear this ticket?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {claim.paper_title}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {phase === "loading" && (
            <p className="text-sm text-fg-muted">Checking the figure against Scopus…</p>
          )}

          {phase === "error" && is502 && (
            <Callout tone="critical" title="Scopus could not be reached">
              <p>The amount was not refreshed. Nothing has been cleared.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button kind="default" size="sm" onClick={() => void runRecalc(false)}>
                  Retry
                </Button>
                {isSuperAdmin && (
                  <Button kind="quiet" size="sm" onClick={() => void runRecalc(true)}>
                    Use stored values instead
                  </Button>
                )}
              </div>
            </Callout>
          )}

          {phase === "error" && !is502 && (
            <Callout tone="critical" title="This amount could not be worked out">
              {calcError || "Nothing has been cleared."}
            </Callout>
          )}

          {phase === "ready" && (
            <>
              <p className="text-2xl font-semibold tabular">{money(amount)}</p>
              <Field label="Note (optional)">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              </Field>
            </>
          )}

          {phase === "changed" && (
            <Callout tone="caution" title="The figure changed since this screen was drawn">
              <p>You confirmed {money(confirmedAmount)}.</p>
              <p className="mt-1">{changedMessage}</p>
              <p className="mt-2">Nothing has been cleared. Recalculate to see the new figure and confirm again.</p>
            </Callout>
          )}
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {phase === "changed" ? (
            <Button kind="primary" onClick={() => void runRecalc()}>
              Recalculate
            </Button>
          ) : (
            <Button
              kind="primary"
              disabled={phase !== "ready" || amount == null || busy}
              onClick={() => void confirmClear()}
            >
              {busy ? "Clearing…" : `Clear — ${amount != null ? money(amount) : "…"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Reject                                                                    */
/* ------------------------------------------------------------------------ */

function RejectDialog({
  claim,
  open,
  onOpenChange,
  onRejected,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onRejected: () => void
}) {
  const [note, setNote] = useState("")
  const reject = useApiMutation<{ note: string }, ClaimDetail>(`/api/claims/${claim.id}/reject`, {
    invalidates: [["clearing-queue"], ["claim", claim.id]],
  })

  useEffect(() => {
    if (open) setNote("")
  }, [open])

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10
  const canSubmit = trimmed.length >= 10

  async function submit() {
    try {
      await reject.mutateAsync({ note: trimmed })
      toast.ok(`Sent back${claim.ticket_number ? ` — ${claim.ticket_number}` : ""}`)
      onOpenChange(false)
      onRejected()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Send this ticket back?</DialogTitle>
          <DialogDescription>{claim.paper_title}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field
            label="Reason"
            hint="The claimant sees this sentence first, at the top of their paper — say what to fix."
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What needs to change before this can be filed again"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={reject.isPending}>
            Cancel
          </Button>
          <Button kind="danger" disabled={!canSubmit || reject.isPending} onClick={() => void submit()}>
            {reject.isPending ? "Sending…" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */
/* ------------------------------------------------------------------------ */

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

function parseJsonObject<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null
  } catch {
    return null
  }
}

// Machine-confirmed and self-reported are said differently on purpose — a
// reader must be able to tell what Scopus verified from what the claimant
// typed, since only one of those is grounds to change the amount.
function snipNote(c: ClaimDetail): string | undefined {
  const parts: string[] = []
  if (c.snip_source === "SCOPUS") parts.push("Confirmed by Scopus")
  else if (c.snip_source === "SNIP_DUMP") parts.push("Confirmed from the SNIP dataset")
  else if (c.snip_source === "MANUAL") parts.push("Entered manually")
  if (c.self_reported_snip != null && c.self_reported_snip !== c.snip) {
    parts.push(`Self-reported: ${c.self_reported_snip}`)
  }
  return parts.length ? parts.join(" · ") : undefined
}

function quartileNote(c: ClaimDetail): string | undefined {
  const parts: string[] = []
  if (c.quartile_source === "SCIMAGO") {
    parts.push(
      c.scimago_sjr != null
        ? `Scimago, SJR ${c.scimago_sjr}${c.scimago_dataset_year ? ` (${c.scimago_dataset_year})` : ""}`
        : "Confirmed by Scimago"
    )
  } else if (c.quartile_source === "MANUAL") {
    parts.push("Entered manually")
  }
  if (c.self_reported_quartile != null && c.self_reported_quartile !== c.quartile) {
    parts.push(`Self-reported: ${c.self_reported_quartile}`)
  }
  return parts.length ? parts.join(" · ") : undefined
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

// Same codes `_transition()` writes in backend/core/api.py — read there, not
// guessed, so a code this sheet does not recognise still falls back to a
// humanised version of itself rather than a blank line in the history.
function actionSentence(a: ClaimAction): string {
  const who = a.actor_name
  const base = (() => {
    switch (a.action) {
      case "CREATE_DRAFT":
        return `${who} started this draft`
      case "ADMIN_CREATE":
        return `${who} created this on the author's behalf`
      case "SUBMIT":
        return `${who} filed it`
      case "CONTEST_FORWARD":
        return `${who} filed it, flagging it for review`
      case "RESUBMIT":
        return `${who} filed it again`
      case "WITHDRAW":
        return `${who} withdrew it to fix it`
      case "CLEAR":
        return `${who} checked it and sent it to the Principal`
      case "PRINCIPAL_APPROVE":
        return `${who} approved it`
      case "PRINCIPAL_SEND_BACK":
        return `${who} sent it back to the research cell`
      case "SECOND_APPROVE":
        return `${who} gave the second approval`
      case "MARK_PAID":
        return `${who} marked it paid`
      case "VOID_PAYMENT":
        return `${who} voided the payment`
      case "REJECT":
        return `${who} sent it back`
      case "STATUS_OVERRIDE":
        return `${who} moved it to ${a.to_status.replace(/_/g, " ").toLowerCase()} directly`
      case "VERIFY":
        return `${who} verified it`
      case "MANUAL_VERIFY":
        return `${who} verified it manually`
      case "PACK_CORRECT":
        return `${who} corrected a field`
      case "ADMIN_EDIT":
        return `${who} edited it`
      case "REASSIGN":
        return `${who} reassigned it`
      default:
        return `${who} ${a.action.replace(/_/g, " ").toLowerCase()}`
    }
  })()
  return a.note ? `${base} — ${a.note}` : base
}
