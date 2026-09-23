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
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
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
import { Checkbox, Field, Input, Textarea } from "@/ui/field"
import { ClaimContext, PaperLinks } from "@/pages/claim-context"
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
  contest_forward?: boolean | null
  duplicate_matches_json: string | null
  override_duplicate: boolean | null
  override_reason: string | null
  override_by_name: string | null
  verification_ok: boolean | null
  verification_snapshot_json: string | null
  calc_error: string | null
  waiting_days: number | null
}

// `status_note` carries the Principal's reason when a ticket is returned to
// this queue. It is on the claim payload but was not in the queue row type.
type ClaimDetail = QueueClaim & {
  actions?: ClaimAction[]
  status_note?: string | null
  //: Both come from `claim_to_dict`, which the sheet fetches in full — the
  //: queue row this type was widened from simply does not carry them.
  needs_second_approval?: boolean
  cleared_by_name?: string | null
}

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

  const all = claims ?? []

  // Narrowing only: the server's oldest-first order is the queue's priority
  // and is never re-sorted here. Keyboard moves and "select all shown" work
  // on what is on screen.
  const [q, setQ] = useState("")
  const [dept, setDept] = useState("")
  const [check, setCheck] = useState<"" | "passed" | "failed" | "flagged">("")
  const needle = q.trim().toLowerCase()
  const rows = all.filter(
    (c) =>
      (!dept || (c.owner_department || "—") === dept) &&
      (!check ||
        (check === "passed" && c.verification_ok === true) ||
        (check === "failed" && c.verification_ok === false) ||
        (check === "flagged" && (c.duplicate_warning || c.contest_forward))) &&
      (!needle ||
        [c.paper_title, c.ticket_number, c.owner_name, c.journal_title]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)))
  )
  const byDept = [...all.reduce((m, c) => m.set(c.owner_department || "—", (m.get(c.owner_department || "—") || 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])
  const queueTotal = all.reduce((s, c) => s + (c.remuneration || 0), 0)
  const oldest = all.reduce((m, c) => Math.max(m, c.waiting_days ?? 0), 0)

  // Whole rows, not just ids — the same shape `payments.tsx` uses. A row that
  // has left this fetch still has to be able to say its own title and amount,
  // or the bar showing the selection cannot describe what is in it.
  const [selected, setSelected] = useState<Map<string, QueueClaim>>(new Map())
  const [active, setActive] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkResult, setBulkResult] = useState<{
    result: BulkClearResult
    lookup: Map<string, QueueClaim>
  } | null>(null)

  // Nothing silently prunes the selection against the rows on screen. A
  // ticket that has genuinely moved on is caught where it counts instead:
  // bulk-clear re-checks every id server-side and skips it by name rather
  // than clearing it, and the bar below says plainly how many of the
  // selected rows are no longer in this queue.

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
        if (row) toggleSelected(row)
      } else if (e.key === "Enter") {
        e.preventDefault()
        const row = rows[active]
        if (row) setOpenId(row.id)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [rows, active, openId])

  function toggleSelected(c: QueueClaim) {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Map(prev)
      const everyShownSelected = rows.length > 0 && rows.every((c) => next.has(c.id))
      for (const c of rows) {
        if (everyShownSelected) next.delete(c.id)
        else next.set(c.id, c)
      }
      return next
    })
  }

  const bulkClear = useApiMutation<{ claim_ids: string[]; note?: string }, BulkClearResult>(
    "/api/admin/bulk-clear",
    { invalidates: [...CHAIN] }
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

  const selectedRows = [...selected.values()]
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const selectedMissing = selectedRows.filter((c) => c.calc_error || c.remuneration == null).length

  // The bar shows whenever anything at all is selected, not only when one of
  // the selected rows is on screen. Gated on the latter, a refresh that
  // carried a selected ticket out of the queue took the whole bar with it —
  // the selection still live, with no count, no total and no way to act.
  const anySelected = selected.size > 0
  // Still about the rows on screen, because that is what the header's
  // select-all box acts on.
  const allVisibleSelected = rows.length > 0 && rows.every((c) => selected.has(c.id))
  const someVisibleSelected = rows.some((c) => selected.has(c.id))
  const selectedOffList = selected.size - rows.filter((c) => selected.has(c.id)).length

  async function runBulkClear() {
    const ids = [...selected.keys()]
    const lookup = new Map(selected)
    try {
      const result = await bulkClear.mutateAsync({ claim_ids: ids })
      setBulkResult({ result, lookup })
      const skippedIds = new Set(result.skipped.map((s) => s.id))
      setSelected((prev) => {
        const next = new Map(prev)
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

      {all.length > 0 && (
        <section aria-label="The queue at a glance" className="space-y-3">
          <p className="text-sm text-fg-muted">
            <span className="font-semibold text-fg">{all.length}</span> waiting ·{" "}
            <span className="tabular font-semibold text-fg">{money(queueTotal)}</span> in all · oldest{" "}
            <span className={cn("font-semibold", oldest > 14 ? "text-critical" : oldest > 7 ? "text-caution" : "text-fg")}>
              {waitingLabel(oldest).toLowerCase()}
            </span>
          </p>
          {byDept.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by department">
              {byDept.map(([d, n]) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={dept === d}
                  onClick={() => setDept(dept === d ? "" : d)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs ring-1 ring-inset",
                    dept === d ? "bg-accent text-accent-fg ring-accent" : "bg-surface text-fg-muted ring-line hover:text-fg"
                  )}
                >
                  {d} <span className="tabular">{n}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by title, ticket, claimant or journal"
              aria-label="Filter the queue"
              className="max-w-sm"
            />
            <select
              value={check}
              onChange={(e) => setCheck(e.target.value as typeof check)}
              aria-label="Filter by verification"
              className="h-9 rounded-md border-0 bg-surface px-2 text-sm shadow-well ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent"
            >
              <option value="">Any verification</option>
              <option value="passed">Verification passed</option>
              <option value="failed">Verification failed</option>
              <option value="flagged">Duplicate or contested</option>
            </select>
            {(q || dept || check) && (
              <Button kind="quiet" size="sm" onClick={() => { setQ(""); setDept(""); setCheck("") }}>
                Show all {all.length}
              </Button>
            )}
            <Button kind="quiet" size="sm" className="ml-auto" onClick={() => downloadQueue(rows)}>
              Download these {rows.length} as CSV
            </Button>
          </div>
        </section>
      )}

      <Meta className="block">
        <kbd className="rounded border border-edge px-1 text-[10px]">j</kbd>/
        <kbd className="rounded border border-edge px-1 text-[10px]">k</kbd> or arrows to move ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">x</kbd> to select ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">Enter</kbd> to open
      </Meta>

      {anySelected && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-accent-wash px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">{selected.size}</span> selected ·{" "}
            <span className="font-semibold tabular">{money(selectedTotal)}</span>
            {selectedOffList > 0 && (
              <span className="text-fg-muted">
                {" "}
                · {selectedOffList} no longer in this queue
              </span>
            )}
            {selectedMissing > 0 && (
              <span className="text-fg-muted">
                {" "}
                ({selectedMissing} without an amount, excluded from this total)
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button kind="quiet" size="sm" onClick={() => setSelected(new Map())}>
              Clear selection
            </Button>
            <Button kind="primary" size="sm" onClick={() => setBulkConfirmOpen(true)}>
              Clear {selected.size} {selected.size === 1 ? "ticket" : "tickets"}
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <>
          <SkeletonRows rows={8} rowHeight={52} className="hidden md:block" />
          <SkeletonRows rows={5} rowHeight={96} className="md:hidden" />
        </>
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          message="The server did not answer. Nothing has been lost or cleared."
          onRetry={() => refetch()}
        />
      ) : all.length > 0 && rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No ticket matches these filters"
          message={`${all.length} are waiting in all.`}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          art="empty-queue"
          icon={Inbox}
          title="Nothing waiting"
          message="Every submitted ticket has been checked. That is good news — come back when the next one lands."
        />
      ) : (
        <>
        {/* Below `md` the same rows are stacked as cards. Seven columns do not
            fit 375px, and a queue only reachable by dragging it sideways is a
            queue the research cell cannot work on a phone — the page column
            itself must never be what scrolls. */}
        <div className="space-y-3 md:hidden">
          <Checkbox
            checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
            onCheckedChange={() => toggleAllVisible()}
            label={allVisibleSelected ? "Deselect all shown" : "Select all shown"}
          />
          <ul className="divide-y divide-line border-y border-line">
            {rows.map((c) => (
              <QueueCard
                key={c.id}
                claim={c}
                selected={selected.has(c.id)}
                onToggle={() => toggleSelected(c)}
                onOpen={() => setOpenId(c.id)}
              />
            ))}
          </ul>
        </div>

        <TableScroller minWidth="62rem" className="hidden md:block">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" className={cn(stickyHeadCell, "w-10")}>
                  <Checkbox
                    checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                    onCheckedChange={() => toggleAllVisible()}
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
                // No `aria-selected` here. A `<tr>` in a plain `<table>` is a
                // `row` inside a `table`, not a `grid`, so the attribute is
                // dropped outright — the selection was announced nowhere and
                // `bg-selected` was the whole of it. The row's own checkbox is
                // a real `checkbox` with a real name, so its checked state is
                // what carries the selection to a screen reader.
                <tr
                  key={c.id}
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
                      onCheckedChange={() => toggleSelected(c)}
                      aria-label={selectLabel(c)}
                    />
                  </td>
                  <td className="px-3 py-3 align-top">
                    <span className="block break-words text-base">{c.paper_title || "Untitled"}</span>
                    <Meta className="mt-0.5 block">{c.ticket_number || "Not yet ticketed"}</Meta>
                    {c.verification_ok === false && issuesOf(c)[0] && (
                      <p className="mt-1 text-xs text-critical">
                        {issuesOf(c)[0]}
                        {issuesOf(c).length > 1 && ` (+${issuesOf(c).length - 1} more)`}
                      </p>
                    )}
                    {(c.duplicate_warning || c.contest_forward || c.calc_error || c.remuneration_is_estimate) && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {c.duplicate_warning && (
                          <RowFlag tone="critical">
                            <AlertTriangle className="size-3" /> Possible duplicate
                          </RowFlag>
                        )}
                        {c.contest_forward && (
                          <RowFlag tone="caution">Contested by the claimant</RowFlag>
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
                    <span
                      className={cn(
                        "tabular",
                        (c.waiting_days ?? 0) > 14
                          ? "font-medium text-critical"
                          : (c.waiting_days ?? 0) > 7 && "font-medium text-caution"
                      )}
                      title={(c.waiting_days ?? 0) > 7 ? "Waiting more than a week" : undefined}
                    >
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
                    <VerifiedBadge ok={c.verification_ok} issues={issuesOf(c)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
        </>
      )}

      <TicketSheet
        openId={openId}
        onClose={() => setOpenId(null)}
        // Working a queue is one ticket after another: once this one is
        // cleared or sent back, the next in queue order opens rather than
        // dropping the reader back at the list to find their place.
        onFinished={() => {
          const at = rows.findIndex((r) => r.id === openId)
          const next = rows[at + 1] ?? rows[at - 1]
          setOpenId(next && next.id !== openId ? next.id : null)
          if (next) setActive(Math.max(0, at))
        }}
        isSuperAdmin={me?.role === "SUPER_ADMIN"}
      />

      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={setBulkConfirmOpen}
        title={`Clear ${selected.size} ${selected.size === 1 ? "ticket" : "tickets"}?`}
        description={`${money(selectedTotal)} total. Each ticket is re-checked against its stored figures as it clears — a row whose amount has moved is skipped, not cleared at the wrong number.`}
        confirmLabel={`Clear — ${money(selectedTotal)}`}
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

/** The checkbox's accessible name. "Select" on its own is what forty
 *  identically-named checkboxes sound like in a row list, so the paper and
 *  its ticket go into the name — that, plus the checkbox's own checked
 *  state, is how the selection is announced at all. */
function selectLabel(c: QueueClaim): string {
  const title = c.paper_title || "this ticket"
  return c.ticket_number ? `Select ${title}, ${c.ticket_number}` : `Select ${title}`
}

/** The same row stacked for a narrow screen. Seven columns do not fit 375px,
 *  and dropping the amount or the duplicate flag below `md` is how a ticket
 *  gets cleared on a phone without its reader seeing either. */
function QueueCard({
  claim: c,
  selected,
  onToggle,
  onOpen,
}: {
  claim: QueueClaim
  selected: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  return (
    <li className={cn("row flex items-start gap-3 px-1 py-3", selected && "bg-selected")}>
      <span className="pt-1">
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={selectLabel(c)} />
      </span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1">
            <span className="block break-words text-base">{c.paper_title || "Untitled"}</span>
            <Meta className="mt-0.5 block">
              {c.ticket_number || "Not yet ticketed"} · {c.owner_name}
            </Meta>
            {c.journal_title && <Meta className="block break-words">{c.journal_title}</Meta>}
          </span>
          <span className="shrink-0 text-right">
            {c.calc_error ? (
              <span className="text-xs text-critical">No amount</span>
            ) : (
              <span className="block text-base tabular">{money(c.remuneration)}</span>
            )}
            <span
              className={cn(
                "block text-xs tabular",
                (c.waiting_days ?? 0) > 7 ? "font-medium text-caution" : "text-fg-muted"
              )}
            >
              {waitingLabel(c.waiting_days)}
            </span>
          </span>
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
          {!c.calc_error && c.remuneration_is_estimate && <RowFlag tone="caution">Estimate</RowFlag>}
          <VerifiedBadge ok={c.verification_ok} />
        </span>
      </button>
    </li>
  )
}

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

/** The plain-English reasons verification recorded, for the row itself. */
function issuesOf(c: QueueClaim): string[] {
  try {
    const snap = JSON.parse(c.verification_snapshot_json || "{}") as { issues?: unknown }
    return Array.isArray(snap.issues) ? snap.issues.filter((i): i is string => typeof i === "string") : []
  } catch {
    return []
  }
}

/** The queue as it stands on screen, for the office's own spreadsheet. */
function downloadQueue(rows: QueueClaim[]) {
  const head = ["Ticket", "Paper", "Claimant", "Department", "Journal", "Waiting days", "Amount", "Verified"]
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
  const body = rows.map((c) =>
    [c.ticket_number, c.paper_title, c.owner_name, c.owner_department, c.journal_title, c.waiting_days, c.remuneration, c.verification_ok === true ? "passed" : c.verification_ok === false ? "failed" : "not checked"]
      .map(cell)
      .join(",")
  )
  const blob = new Blob(["\uFEFF" + [head.map(cell).join(","), ...body].join("\r\n")], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `clearing-queue-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

function VerifiedBadge({ ok, issues = [] }: { ok: boolean | null; issues?: string[] }) {
  if (ok === true) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-positive">
        <CheckCircle2 className="size-3.5" aria-hidden /> Passed
      </span>
    )
  }
  if (ok === false) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-sm text-critical" title={issues.join("\n") || undefined}>
        <XCircle className="size-3.5" aria-hidden /> Failed
        {issues.length > 0 && (
          <span className="sr-only">: {issues.join("; ")}</span>
        )}
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
  onFinished = onClose,
  isSuperAdmin,
}: {
  openId: string | null
  onClose: () => void
  /** After a clear or a send-back: by default, the next ticket in the queue. */
  onFinished?: () => void
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
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [secondOpen, setSecondOpen] = useState(false)
  const [overrideOpen, setOverrideOpen] = useState(false)

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
              <PaperLinks
                doi={claim.doi}
                eid={(claim as { eid?: string | null }).eid}
                scopusUrl={(claim as { scopus_url?: string | null }).scopus_url}
              />
            </SheetHeader>

            <SheetBody className="space-y-8">
              {/* Why it came back, before anything else.
                  A ticket the Principal returned lands here, at SUBMITTED,
                  and the server writes their reason to `status_note`. The
                  Principal is required to give one — so not showing it meant
                  the ticket simply reappeared in this queue with no
                  explanation, and the reader had to guess what had been
                  wrong with it. */}
              {claim.status_note && (
                <Callout tone="caution" title="Sent back to you">
                  <p>{claim.status_note}</p>
                </Callout>
              )}

              <section className="space-y-1">
                <SectionTitle>Claimant</SectionTitle>
                <p className="text-sm">{claim.owner_name}</p>
                <Meta className="block">
                  {[claim.owner_department, claim.owner_email].filter(Boolean).join(" · ")}
                </Meta>
              </section>

              <ClaimContext claim={claim} />

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

            <SheetFooter className="flex-wrap gap-2">
              {/* Manual verification: the lane for a paper the index cannot
                  confirm. Without it such a claim can never be priced, and
                  the Faults screen names this as the remedy. */}
              {(claim.status === "SUBMITTED" || claim.status === "CLEARED") && (
                <Button kind="quiet" onClick={() => setVerifyOpen(true)}>
                  Enter verified values
                </Button>
              )}

              {/* The second signature. It had no control anywhere, so a
                  high-value claim that needed one could never receive it and
                  was permanently unpayable. */}
              {claim.needs_second_approval && (
                <Button kind="default" onClick={() => setSecondOpen(true)}>
                  Add second signature
                </Button>
              )}

              {/* Stranded on a retired ERP status: nothing in the live chain
                  can act on it until somebody moves it back. */}
              {LEGACY_STATUSES.includes(claim.status) && (
                <Button kind="quiet" onClick={() => setOverrideOpen(true)}>
                  Unstick this status
                </Button>
              )}

              {claim.status === "SUBMITTED" && (
                <>
                  <Button kind="danger" onClick={() => setRejectOpen(true)}>
                    Send it back
                  </Button>
                  <Button kind="primary" onClick={() => setClearOpen(true)}>
                    Clear
                  </Button>
                </>
              )}
            </SheetFooter>

            <ClearDialog
              claim={claim}
              open={clearOpen}
              onOpenChange={setClearOpen}
              isSuperAdmin={isSuperAdmin}
              onCleared={onFinished}
            />
            <RejectDialog claim={claim} open={rejectOpen} onOpenChange={setRejectOpen} onRejected={onFinished} />
            <ManualVerifyDialog claim={claim} open={verifyOpen} onOpenChange={setVerifyOpen} />
            <SecondSignatureDialog
              claim={claim}
              open={secondOpen}
              onOpenChange={setSecondOpen}
            />
            <OverrideStatusDialog
              claim={claim}
              open={overrideOpen}
              onOpenChange={setOverrideOpen}
              onDone={onClose}
            />
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
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )
  const clear = useApiMutation<{ note?: string; expected_amount?: number }, ClaimDetail>(
    `/api/claims/${claim.id}/clear`,
    { invalidates: [...CHAIN, ["claim", claim.id]] }
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
              {/* What confirming does, in the dialog rather than only in the
                  toast afterwards — by then it has already happened. */}
              <p className="text-sm text-fg-muted">
                This clears {money(amount)} and sends the ticket to the Principal to approve. It
                leaves this queue.
              </p>
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
    invalidates: [...CHAIN, ["claim", claim.id]],
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


/* ------------------------------------------------------------------------ */
/* The three actions that had no control                                    */
/* ------------------------------------------------------------------------ */

//: Statuses the ERP import writes that nothing in the live chain can act on.
const LEGACY_STATUSES = ["HOD_APPROVED", "RESEARCH_APPROVED", "FINANCE_APPROVED"]

const QUARTILES = ["Q1", "Q2", "Q3", "Q4"]

/**
 * Manual verification — the lane for a paper Scopus and Scimago cannot confirm.
 *
 * Without it the amount is either computed from the claimant's own declaration
 * or not computed at all, so a perfectly good paper in a journal our reference
 * data does not recognise sits unpriced forever. The note is mandatory on the
 * server because somebody is typing a number that decides a payment, and a
 * year later the only account of why is this sentence.
 */
function ManualVerifyDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [snip, setSnip] = useState("")
  const [quartile, setQuartile] = useState("")
  const [note, setNote] = useState("")

  useEffect(() => {
    if (!open) return
    setSnip(claim.snip != null ? String(claim.snip) : "")
    setQuartile(claim.quartile || "")
    setNote("")
  }, [open, claim])

  const save = useApiMutation<
    { snip?: number; quartile?: string; note: string },
    unknown
  >(`/api/admin/claims/${claim.id}/set-verified`, {
    invalidates: [...CHAIN, ["claim", claim.id]],
  })

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10
  const parsedSnip = Number.parseFloat(snip)
  const snipBad = snip.trim() !== "" && !Number.isFinite(parsedSnip)
  const canSubmit = trimmed.length >= 10 && !snipBad && !save.isPending

  async function submit() {
    try {
      await save.mutateAsync({
        snip: snip.trim() === "" ? undefined : parsedSnip,
        quartile: quartile || undefined,
        note: trimmed,
      })
      toast.ok("Verified values recorded — the amount has been recalculated")
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Enter verified values</DialogTitle>
          <DialogDescription>
            For a journal the index cannot confirm. What you enter is treated as
            verified and the amount is worked out from it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="caution" title="This replaces the claimant's own declaration">
            Values entered here are marked MANUAL and survive re-verification, so they
            decide the payment from now on.
          </Callout>

          <div className="grid grid-cols-2 gap-3">
            <Field label="SNIP" error={snipBad ? "That is not a number." : undefined}>
              <Input value={snip} onChange={(e) => setSnip(e.target.value)} placeholder="1.205" />
            </Field>
            <Field label="Quartile">
              <Combobox
                value={quartile}
                onChange={setQuartile}
                options={[
                  { value: "", label: "Leave as it is" },
                  ...QUARTILES.map((q) => ({ value: q, label: q })),
                ]}
              />
            </Field>
          </div>

          <Field
            label="Where these came from"
            hint="A citation somebody auditing this can follow. At least 10 characters."
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="SNIP 1.205 from the 2025 CWTS list; the journal is not in our Scimago dump"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {save.isPending ? "Saving…" : "Record and recalculate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The second signature on a high-value claim.
 *
 * It had no control anywhere in this app, so a claim over the threshold could
 * never receive one and Finance refused it forever — the queue looked like
 * work and was a dead end. The server refuses the signature if it comes from
 * whoever cleared the ticket, which is the entire point of asking for it.
 */
function SecondSignatureDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { me } = useAuth()
  const [note, setNote] = useState("")

  useEffect(() => {
    if (open) setNote("")
  }, [open])

  const sign = useApiMutation<{ note?: string; expected_amount?: number }, unknown>(
    `/api/claims/${claim.id}/second-approve`,
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )

  const selfCleared = Boolean(
    me?.name && claim.cleared_by_name && me.name === claim.cleared_by_name
  )

  async function submit() {
    try {
      await sign.mutateAsync({
        note: note.trim() || undefined,
        expected_amount: claim.remuneration ?? undefined,
      })
      toast.ok(`Second signature recorded — ${money(claim.remuneration)} can now be paid`)
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add the second signature</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {money(claim.remuneration)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {selfCleared ? (
            <Callout tone="critical" title="You cleared this ticket">
              The second signature has to come from somebody else — that is the whole
              reason it is asked for. The server will refuse it from you.
            </Callout>
          ) : (
            <Callout tone="info" title="What this does">
              It confirms the amount as a second, different pair of eyes. Finance cannot
              pay this claim until somebody other than {claim.cleared_by_name || "whoever cleared it"} has.
            </Callout>
          )}

          <Field label="Note" hint="Optional — what you checked.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={sign.isPending}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={selfCleared || sign.isPending}
            onClick={() => void submit()}
          >
            {sign.isPending ? "Signing…" : `Sign — ${money(claim.remuneration)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Unsticking a ticket stranded on a retired ERP status.
 *
 * The import wrote statuses like HOD_APPROVED that nothing in the live chain
 * can act on — such a ticket could not be cleared, paid, or even sent back.
 * The Faults screen has been naming this as the fix while offering no way to
 * do it.
 */
function OverrideStatusDialog({
  claim,
  open,
  onOpenChange,
  onDone,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [to, setTo] = useState("SUBMITTED")
  const [note, setNote] = useState("")

  useEffect(() => {
    if (!open) return
    setTo("SUBMITTED")
    setNote("")
  }, [open])

  const override = useApiMutation<{ to_status: string; note: string }, unknown>(
    `/api/admin/claims/${claim.id}/override-status`,
    { invalidates: [...CHAIN, ["claim", claim.id], ["admin", "faults"]] }
  )

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10

  async function submit() {
    try {
      await override.mutateAsync({ to_status: to, note: trimmed })
      toast.ok(`Moved to ${to.replace(/_/g, " ").toLowerCase()} — it can be worked on again`)
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Move this off a retired status</DialogTitle>
          <DialogDescription>
            It is on {claim.status.replace(/_/g, " ").toLowerCase()}, which the current
            chain has no step for.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="caution" title="Cleared is not a shortcut to paid">
            Moving it to Cleared puts it back in the chain at the checking step — it still
            has to be approved and authorised before Finance can pay it, and the amount is
            recomputed rather than taken from the import.
          </Callout>

          <Field label="Move it to">
            <Combobox
              value={to}
              onChange={setTo}
              options={[
                { value: "SUBMITTED", label: "Filed — back in the clearing queue" },
                { value: "CLEARED", label: "Checked — waiting on the Principal" },
                { value: "REJECTED", label: "Sent back to the claimant" },
              ]}
            />
          </Field>

          <Field
            label="Why"
            hint="Recorded against your name. At least 10 characters."
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Imported from the ERP on a status this chain retired; putting it back for checking"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={override.isPending}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={trimmed.length < 10 || override.isPending}
            onClick={() => void submit()}
          >
            {override.isPending ? "Moving…" : "Move it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
