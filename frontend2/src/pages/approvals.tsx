import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Paperclip,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react"

import { useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
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
import { Checkbox, Field, Input, NumberInput, Textarea } from "@/ui/field"
import { ClaimContext, PaperLinks } from "@/pages/claim-context"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/ui/sheet"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows, SkeletonText } from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { money } from "@/ui/paper"
import { toast } from "@/ui/toast"

/**
 * The Principal's queue: every `CLEARED` ticket waiting between the research
 * cell and Finance, sliced by wait time.
 *
 * Two things this page cannot afford to get wrong. First, the order — a
 * Principal manages this queue by how long something has waited, not by
 * title or department, so `waiting_days` is shown on every row and the
 * default sort is the one the backend already sorts by: longest wait first.
 * Second, `needs_second_approval` — a claim over the high-value threshold
 * needs a signature from someone other than whoever cleared it
 * (`cleared_by_name`). This screen only offers principal-approve,
 * principal-reject and the bulk-approve of those two; the second-signature
 * endpoint itself belongs to the research cell's desk, not the Principal's,
 * so it is shown here for information and never offered as an action —
 * offering it would just be refused.
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

/** What every row of the queue carries, plus the second-signature fields
 *  that make this desk's job different from the research cell's. */
type QueueClaim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name: string
  owner_email: string
  owner_department: string | null
  remuneration: number | null
  remuneration_is_estimate: boolean
  qf_amount: number | null
  base_amount: number | null
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
  status: string
  cleared_by_name: string | null
  cleared_at: string | null
  needs_second_approval: boolean
  second_approved_by_name: string | null
  second_approved_at: string | null
}

type ClaimDetail = QueueClaim & { actions?: ClaimAction[] }

type QueuePayload = {
  total: number
  limit: number
  offset: number
  results: QueueClaim[]
  totals: { count: number; amount: number; longest_wait_days: number | null }
  departments: string[]
}

type BulkApproveResult = {
  approved: number
  total: number
  skipped: { id: string; reason: string }[]
}

const SORT_OPTIONS: ComboboxOption[] = [
  { value: "waiting", label: "Longest wait first" },
  { value: "recent", label: "Most recently cleared" },
  { value: "amount", label: "Highest amount first" },
  { value: "amount_asc", label: "Lowest amount first" },
  { value: "department", label: "Department" },
  { value: "title", label: "Paper title" },
]

const RESULT_LIMIT = 200

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Approvals() {
  const { me } = useAuth()
  // The backend's `_may_approve_as_principal` allows the Principal and a
  // super admin standing in for one — matched here directly rather than
  // through `can().approve`, which only covers the Principal.
  const allowed = me?.role === "PRINCIPAL" || me?.role === "SUPER_ADMIN"

  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const department = searchParams.get("department") ?? ""
  const sort = searchParams.get("sort") ?? "waiting"
  const waitingOverParam = searchParams.get("waiting_over") ?? ""
  const minAmountParam = searchParams.get("min_amount") ?? ""
  const quartile = searchParams.get("quartile") ?? ""
  const [minDraft, setMinDraft] = useState(minAmountParam)
  useEffect(() => setMinDraft(minAmountParam), [minAmountParam])
  useEffect(() => {
    if (minDraft === minAmountParam) return
    const t = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (minDraft) next.set("min_amount", minDraft)
        else next.delete("min_amount")
        return next
      }, { replace: true })
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minDraft])

  const [searchDraft, setSearchDraft] = useState(q)
  useEffect(() => setSearchDraft(q), [q])
  const [waitingDraft, setWaitingDraft] = useState(waitingOverParam)
  useEffect(() => setWaitingDraft(waitingOverParam), [waitingOverParam])

  // The box's own state so typing feels instant; the URL only catches up
  // once typing pauses.
  useEffect(() => {
    if (searchDraft === q) return
    const t = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (searchDraft) next.set("q", searchDraft)
        else next.delete("q")
        return next
      }, { replace: true })
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft])

  useEffect(() => {
    if (waitingDraft === waitingOverParam) return
    const t = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (waitingDraft) next.set("waiting_over", waitingDraft)
        else next.delete("waiting_over")
        return next
      }, { replace: true })
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingDraft])

  function selectDepartment(next: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next) p.set("department", next)
      else p.delete("department")
      return p
    })
  }

  function selectSort(next: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next && next !== "waiting") p.set("sort", next)
      else p.delete("sort")
      return p
    })
  }

  function clearFilters() {
    setSearchDraft("")
    setWaitingDraft("")
    setMinDraft("")
    setSearchParams(new URLSearchParams())
  }

  const listQuery = new URLSearchParams()
  if (q) listQuery.set("q", q)
  if (department) listQuery.set("department", department)
  if (sort && sort !== "waiting") listQuery.set("sort", sort)
  if (waitingOverParam) listQuery.set("waiting_over", waitingOverParam)
  if (minAmountParam) listQuery.set("min_amount", minAmountParam)
  if (quartile) listQuery.set("quartile", quartile)
  listQuery.set("limit", String(RESULT_LIMIT))

  const {
    data,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useApi<QueuePayload>(
    ["principal-queue", q, department, sort, waitingOverParam],
    `/api/principal/queue?${listQuery.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const rows = data?.results ?? []
  const filtered =
    Boolean(q) || Boolean(department) || Boolean(waitingOverParam) || Boolean(minAmountParam) || Boolean(quartile)

  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "All departments" },
    ...(data?.departments ?? []).map((d) => ({ value: d, label: d })),
  ]

  // Whole rows, not just ids. The search, department and wait-time filters
  // each refetch a different slice of the queue, so a row selected before a
  // filter was narrowed is simply not in `rows` any more — keeping only its
  // id meant its title and amount vanished with it and the bar could no
  // longer say what was selected or what it came to.
  const [selected, setSelected] = useState<Map<string, QueueClaim>>(new Map())
  const [active, setActive] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkResult, setBulkResult] = useState<{
    result: BulkApproveResult
    lookup: Map<string, QueueClaim>
  } | null>(null)

  // Nothing prunes the selection against the rows on screen. A refetch under
  // a narrowed filter is not evidence that a ticket left the queue, and
  // dropping it silently is how a Principal loses fifteen chosen rows by
  // typing in the search box. A ticket that genuinely has moved on is caught
  // where it matters instead: bulk-approve re-checks every id server-side and
  // skips it by name rather than approving it.

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

  const bulkApprove = useApiMutation<{ claim_ids: string[]; note?: string }, BulkApproveResult>(
    "/api/principal/bulk-approve",
    { invalidates: [...CHAIN] }
  )

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="Only the Principal, and a super admin standing in for one, can approve spend here."
        />
      </div>
    )
  }

  // Off the rows themselves, so a ticket selected before a filter narrowed
  // the queue still contributes its amount to the total shown.
  const selectedRows = [...selected.values()]
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const selectedMissing = selectedRows.filter((c) => c.calc_error || c.remuneration == null).length
  const selectedNeedSecond = selectedRows.filter((c) => c.needs_second_approval).length

  // The bar shows whenever anything at all is selected, not only when one of
  // the selected rows survived the current filter. Gating it on the latter
  // meant filtering the queue down to nothing hid the bar with the selection
  // still live: no count, no total, and no way to act on or clear it.
  const anySelected = selected.size > 0
  // These two remain about the rows on screen, because that is genuinely what
  // the header's select-all box acts on.
  const allVisibleSelected = rows.length > 0 && rows.every((c) => selected.has(c.id))
  const someVisibleSelected = rows.some((c) => selected.has(c.id))
  const selectedOffList = selected.size - rows.filter((c) => selected.has(c.id)).length

  async function runBulkApprove() {
    const ids = [...selected.keys()]
    const lookup = new Map(selected)
    try {
      const result = await bulkApprove.mutateAsync({ claim_ids: ids })
      setBulkResult({ result, lookup })
      const skippedIds = new Set(result.skipped.map((s) => s.id))
      setSelected((prev) => {
        const next = new Map(prev)
        for (const id of ids) if (!skippedIds.has(id)) next.delete(id)
        return next
      })
      if (result.skipped.length === 0) {
        toast.ok(`Approved — ${result.approved} ${result.approved === 1 ? "ticket" : "tickets"} sent to Finance`)
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
          <PageTitle>Approvals</PageTitle>
          <Sub className="mt-1">
            Cleared tickets waiting on you — approve the spend, or send one back to the research cell.
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
        {data && (
          <>
            {" · "}
            {data.totals.count} waiting · {money(data.totals.amount)} total
            {data.totals.longest_wait_days != null &&
              ` · oldest waiting ${data.totals.longest_wait_days} ${data.totals.longest_wait_days === 1 ? "day" : "days"}`}
          </>
        )}
      </Meta>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title, ticket or claimant"
            aria-label="Search the queue"
            className="pl-8"
          />
        </div>
        <Combobox
          value={department}
          onChange={selectDepartment}
          options={departmentOptions}
          placeholder="All departments"
          aria-label="Filter by department"
          className="w-52"
        />
        <Combobox
          value={sort}
          onChange={selectSort}
          options={SORT_OPTIONS}
          placeholder="Sort"
          aria-label="Sort the queue"
          className="w-52"
        />
        <div className="w-40">
          <NumberInput
            value={waitingDraft}
            onChange={(e) => setWaitingDraft(e.target.value)}
            placeholder="Waiting over"
            unit="days"
            aria-label="Only tickets waiting longer than this many days"
            min={0}
          />
        </div>
        <div className="w-40">
          <NumberInput
            value={minDraft}
            onChange={(e) => setMinDraft(e.target.value)}
            placeholder="Over"
            unit="₹"
            aria-label="Only claims over this amount, in rupees"
            min={0}
          />
        </div>
        <select
          value={quartile}
          onChange={(e) =>
            setSearchParams((prev) => {
              const p = new URLSearchParams(prev)
              if (e.target.value) p.set("quartile", e.target.value)
              else p.delete("quartile")
              return p
            })
          }
          aria-label="Filter by quartile"
          className="h-9 rounded-md border-0 bg-surface px-2 text-sm shadow-well ring-1 ring-inset ring-field"
        >
          <option value="">Any quartile</option>
          {["Q1", "Q2", "Q3", "Q4"].map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
        {rows.length > 0 && (
          <Button kind="quiet" size="sm" className="ml-auto" onClick={() => downloadApprovals(rows)}>
            Download these {rows.length} as CSV
          </Button>
        )}
      </div>

      {anySelected && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-accent-wash px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">{selected.size}</span> selected ·{" "}
            <span className="font-semibold tabular">{money(selectedTotal)}</span>
            {selectedOffList > 0 && (
              <span className="text-fg-muted">
                {" "}
                · {selectedOffList} not shown by the current filters
              </span>
            )}
            {selectedMissing > 0 && (
              <span className="text-fg-muted"> ({selectedMissing} without an amount, excluded from this total)</span>
            )}
            {selectedNeedSecond > 0 && (
              <span className="text-fg-muted">
                {" "}
                ({selectedNeedSecond} still need a second signature after this)
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button kind="quiet" size="sm" onClick={() => setSelected(new Map())}>
              Clear selection
            </Button>
            <Button kind="primary" size="sm" onClick={() => setBulkConfirmOpen(true)}>
              Approve {selected.size} {selected.size === 1 ? "ticket" : "tickets"}
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
          message="The server did not answer. Nothing has been lost or approved."
          onRetry={() => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          art="empty-queue"
          icon={Inbox}
          title={filtered ? "Nothing matches these filters" : "Nothing waiting"}
          message={
            filtered
              ? "Try widening the search, department or wait-time filter."
              : "Every cleared ticket has been approved or sent back. That is good news — come back when the next one lands."
          }
        />
      ) : (
        <>
          {data && data.total > rows.length && (
            <Meta className="block">
              Showing the first {rows.length} of {data.total}. Narrow the filters to see the rest.
            </Meta>
          )}
          {/* Below `md` the same rows are stacked as cards. Seven columns do
              not fit 375px, and a table only reachable by dragging it sideways
              is a queue a Principal cannot triage on a phone — the page column
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

          <TableScroller minWidth="66rem" className="hidden md:block">
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
                  <th scope="col" className={cn(stickyHeadCell, "w-44")}>
                    <ColumnLabel>Journal</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-24 text-right")}>
                    <ColumnLabel>Waiting</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-32 text-right")}>
                    <ColumnLabel>Amount</ColumnLabel>
                  </th>
                  <th scope="col" className={cn(stickyHeadCell, "w-40")}>
                    <ColumnLabel>Second signature</ColumnLabel>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c, i) => (
                  // No `aria-selected` here. A `<tr>` in a plain `<table>` is
                  // a `row` inside a `table`, not a `grid`, so the attribute is
                  // dropped outright — the selection was announced nowhere and
                  // `bg-selected` was the whole of it. The row's own checkbox
                  // is a real `checkbox` with a real name, so its checked state
                  // is what carries the selection to a screen reader.
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
                      <Meta className="mt-0.5 block">
                        {c.ticket_number || "Not yet ticketed"} · Cleared by {c.cleared_by_name || "—"}
                      </Meta>
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
                          {!c.calc_error && c.remuneration_is_estimate && <RowFlag tone="caution">Estimate</RowFlag>}
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
                    <td className="px-3 py-3 align-top">
                      <SecondSignature claim={c} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </>
      )}

      <TicketSheet openId={openId} onClose={() => setOpenId(null)} me={me} />

      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={setBulkConfirmOpen}
        title={`Approve ${selected.size} ${selected.size === 1 ? "ticket" : "tickets"}?`}
        description={`${money(selectedTotal)} total, sent to Finance. Each ticket is re-checked against its stored figures as it approves — a row whose amount has moved is skipped, not approved at the wrong number.`}
        confirmLabel={`Approve — ${money(selectedTotal)}`}
        onConfirm={runBulkApprove}
      />

      {bulkResult && (
        <BulkResultDialog result={bulkResult.result} lookup={bulkResult.lookup} onClose={() => setBulkResult(null)} />
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
 *  and dropping the amount or the second-signature flag below `md` is how a
 *  Principal approves spend on a phone without seeing what they approved. */
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
          {(c.needs_second_approval || c.second_approved_by_name) && <SecondSignature claim={c} />}
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

/** The one thing this desk cannot act on but must never hide: whether a
 *  large claim still needs a second, different signature before Finance
 *  can pay it, and who cleared it so a reader can tell whether their own
 *  approval will count as that signature. */
function SecondSignature({ claim }: { claim: QueueClaim }) {
  if (claim.needs_second_approval) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-caution">
        <ShieldAlert className="size-3.5 shrink-0" aria-hidden /> Needs a second signature
      </span>
    )
  }
  if (claim.second_approved_by_name) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden /> Seconded by {claim.second_approved_by_name}
      </span>
    )
  }
  return <span className="text-xs text-fg-muted">—</span>
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
  result: BulkApproveResult
  lookup: Map<string, QueueClaim>
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            Approved {result.approved} of {result.approved + result.skipped.length}
          </DialogTitle>
          <DialogDescription>
            {result.skipped.length === 0
              ? `${money(result.total)} sent to Finance.`
              : `${money(result.total)} sent to Finance. The rest were skipped — each for its own reason, below. Nothing was approved at a wrong figure.`}
          </DialogDescription>
        </DialogHeader>
        {result.skipped.length > 0 && (
          <DialogBody>
            <ul className="space-y-3">
              {result.skipped.map((s) => {
                const claim = lookup.get(s.id)
                return (
                  <li key={s.id} className="text-sm">
                    <p className="font-medium">{claim?.ticket_number || claim?.paper_title || s.id}</p>
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
  me,
}: {
  openId: string | null
  onClose: () => void
  me: { name: string } | null
}) {
  const {
    data: claim,
    isLoading,
    error,
    refetch,
  } = useApi<ClaimDetail>(["claim", openId], `/api/claims/${openId}`, { enabled: !!openId })

  const [approveOpen, setApproveOpen] = useState(false)
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
              <PaperLinks
                doi={(claim as { doi?: string | null }).doi}
                eid={(claim as { eid?: string | null }).eid}
                scopusUrl={(claim as { scopus_url?: string | null }).scopus_url}
              />
            </SheetHeader>

            <SheetBody className="space-y-8">
              <section className="space-y-1">
                <SectionTitle>Claimant</SectionTitle>
                <p className="text-sm">{claim.owner_name}</p>
                <Meta className="block">
                  {[claim.owner_department, claim.owner_email].filter(Boolean).join(" · ")}
                </Meta>
              </section>

              <ClaimContext claim={claim} />

              <section className="space-y-2">
                <SectionTitle>Cleared by the research cell</SectionTitle>
                <p className="text-sm">
                  {claim.cleared_by_name || "—"}
                  {claim.cleared_at && <span className="text-fg-muted"> · {formatDateTime(claim.cleared_at)}</span>}
                </p>
                {claim.needs_second_approval ? (
                  <Callout tone="caution" title="Needs a second, different signature">
                    <p>
                      This is over the high-value threshold. Approving it here also serves as that second
                      signature — unless you are the same person who cleared it above, in which case someone else
                      on the research cell has to give it separately before Finance can pay this.
                    </p>
                  </Callout>
                ) : claim.second_approved_by_name ? (
                  <p className="text-sm text-fg-muted">
                    Seconded by {claim.second_approved_by_name}
                    {claim.second_approved_at && ` · ${formatDateTime(claim.second_approved_at)}`}
                  </p>
                ) : null}
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
                    It rests on values reported by the claimant, not a verified SNIP or quartile.
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

            {claim.status === "CLEARED" && (
              <SheetFooter>
                <Button kind="danger" onClick={() => setRejectOpen(true)}>
                  Send it back
                </Button>
                <Button kind="primary" onClick={() => setApproveOpen(true)}>
                  Approve
                </Button>
              </SheetFooter>
            )}

            <ApproveDialog claim={claim} open={approveOpen} onOpenChange={setApproveOpen} me={me} onApproved={onClose} />
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
/* Approve — confirm at the figure shown, and re-confirm if it moved        */
/* ------------------------------------------------------------------------ */

/**
 * The one dialog that turns a cleared ticket into money Finance can pay.
 *
 * `principal-approve` recomputes from stored, already-verified values only
 * — never Scopus — so there is no external call to wait on and no outage to
 * retry. The only failure worth guarding is the figure moving between the
 * screen being drawn and the click: the server answers 409 with the
 * recomputed amount in its own message, and this dialog reads that number
 * back out rather than silently resending the stale one. Confirming a second
 * time is always a fresh, explicit click at the new figure — never automatic.
 */
function ApproveDialog({
  claim,
  open,
  onOpenChange,
  me,
  onApproved,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  me: { name: string } | null
  onApproved: () => void
}) {
  const [amount, setAmount] = useState<number | null>(claim.remuneration)
  const [phase, setPhase] = useState<"ready" | "changed">("ready")
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null)
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setAmount(claim.remuneration)
      setPhase("ready")
      setChangedMessage(null)
      setNote("")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const approve = useApiMutation<{ note?: string; expected_amount: number }, ClaimDetail>(
    `/api/claims/${claim.id}/principal-approve`,
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )

  async function confirmApprove() {
    if (amount == null) return
    setBusy(true)
    setConfirmedAmount(amount)
    try {
      const result = await approve.mutateAsync({ note: note.trim() || undefined, expected_amount: amount })
      toast.ok(
        `Approved — ${money(result.remuneration)} sent to Finance${
          claim.ticket_number ? ` for ${claim.ticket_number}` : ""
        }`
      )
      onOpenChange(false)
      onApproved()
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

  function continueWithNewAmount() {
    const parsed = changedMessage ? parseAmountFromMessage(changedMessage) : null
    if (parsed != null) setAmount(parsed)
    setPhase("ready")
    setChangedMessage(null)
  }

  const selfCleared = !!me && !!claim.cleared_by_name && me.name === claim.cleared_by_name

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Approve this spend?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {claim.paper_title}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {phase === "ready" && claim.calc_error ? (
            <Callout tone="critical" title="This amount could not be worked out">
              {claim.calc_error} Nothing has been approved.
            </Callout>
          ) : phase === "ready" ? (
            <>
              <p className="text-2xl font-semibold tabular">{money(amount)}</p>
              {/* What confirming does, in the dialog rather than only in the
                  toast afterwards — by then it has already happened. */}
              <p className="text-sm text-fg-muted">
                This sends {money(amount)} to Finance to pay. Once it has gone, only Finance can
                reverse it.
              </p>
              {claim.needs_second_approval && (
                <Callout tone="caution" title="Needs a second, different signature">
                  Cleared by {claim.cleared_by_name || "someone else"}. Approving here also serves as the second
                  signature{selfCleared ? " — but not from you, since you cleared it yourself" : ""}.
                </Callout>
              )}
              <Field label="Note (optional)">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              </Field>
            </>
          ) : (
            <Callout tone="caution" title="The figure changed since this screen was drawn">
              <p>You confirmed {money(confirmedAmount)}.</p>
              <p className="mt-1">{changedMessage}</p>
              <p className="mt-2">Nothing has been approved. Review the new figure and confirm again.</p>
            </Callout>
          )}
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {phase === "changed" ? (
            <Button kind="primary" onClick={continueWithNewAmount}>
              Show the new figure
            </Button>
          ) : (
            <Button
              kind="primary"
              disabled={amount == null || !!claim.calc_error || busy}
              onClick={() => void confirmApprove()}
            >
              {busy ? "Approving…" : `Approve — ${amount != null ? money(amount) : "…"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Reject — sends the ticket back to the research cell, with a reason       */
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
  const reject = useApiMutation<{ note: string }, ClaimDetail>(`/api/claims/${claim.id}/principal-reject`, {
    invalidates: [...CHAIN, ["claim", claim.id]],
  })

  useEffect(() => {
    if (open) setNote("")
  }, [open])

  const trimmed = note.trim()
  // Matches the backend's own minimum on this endpoint — five characters is
  // enough to catch an empty click, not enough to force an essay.
  const tooShort = trimmed.length > 0 && trimmed.length < 5
  const canSubmit = trimmed.length >= 5

  async function submit() {
    try {
      await reject.mutateAsync({ note: trimmed })
      toast.ok(`Sent back to the research cell${claim.ticket_number ? ` — ${claim.ticket_number}` : ""}`)
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
            hint="Goes back to the research cell to fix, with this note attached — say what to check again."
            error={tooShort ? "At least 5 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What needs a second look before this can be approved"
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

// `_guard_recomputed_amount` writes the recomputed figure into its own 409
// message ("The recomputed amount is ₹52,377.50. ..."), so the fresh number
// can be read straight back out of it rather than re-fetching the claim,
// which — inside the same rolled-back transaction — would still show the
// stale one.
function parseAmountFromMessage(message: string): number | null {
  const m = message.match(/₹([\d,]+(?:\.\d+)?)/)
  if (!m) return null
  const n = Number.parseFloat(m[1].replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
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

/** The approvals list as it is filtered on screen, for the Principal's own records. */
function downloadApprovals(rows: QueueClaim[]) {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
  const head = ["Ticket", "Paper", "Claimant", "Department", "Journal", "Quartile", "Waiting days", "Amount (INR)"]
  const lines = rows.map((c) =>
    [c.ticket_number, c.paper_title, c.owner_name, c.owner_department, c.journal_title, (c as { quartile?: string | null }).quartile, (c as { waiting_days?: number | null }).waiting_days, c.remuneration]
      .map(cell)
      .join(",")
  )
  const blob = new Blob(["\uFEFF" + [head.map(cell).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `approvals-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
