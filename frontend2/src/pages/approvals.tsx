import { thresholdFlag } from "@/ui/research-threshold"
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AlertTriangle, Inbox, PauseCircle, RefreshCw, ShieldAlert } from "lucide-react"

import { useAuth } from "@/app/auth"
import { openShortcuts } from "@/app/shortcuts"
import { cn } from "@/lib/cn"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { ClaimNoJump } from "@/ui/claim-number"
import { ComingUp } from "@/ui/coming-up"
import { filterBar } from "@/ui/filter-bar"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, Sub } from "@/ui/text"
import { money } from "@/ui/paper"
import { useSlashToSearch } from "@/ui/queue-keys"
import { toast } from "@/ui/toast"
import { OwnPapersNote } from "@/ui/own-papers"
import { HeaderSpot } from "@/ui/page-header"
import {
  BulkHoldDialog,
  BulkSummaryDialog,
  NoBulkSendBack,
  QueueTable,
  QuietSelect,
  RowFlag,
  SearchBox,
  SkippedDialog,
  reviewLink,
  useUrlFilters,
  type SummaryRow,
} from "@/ui/queue"
import { ApproveDialog, RejectDialog } from "@/pages/approvals-actions"
import type { BulkApproveResult, QueueClaim, QueuePayload } from "@/pages/approvals-actions"

/**
 * The Principal's queue: every `CLEARED` claim waiting between the research
 * cell and the Director, longest wait first.
 *
 * Two things this page cannot afford to get wrong. First, the order: a
 * Principal manages this queue by how long something has waited, so
 * `waiting_days` is on every row and the default sort is the server's own.
 * Second, `needs_second_approval`: a claim over the high-value threshold needs
 * a signature from someone other than whoever cleared it. This desk shows it
 * and never offers the research cell's second-signature action.
 *
 * A row opens the full-page review (`/review/:id?queue=approvals`). The old
 * side sheet is gone; its approve and send-back dialogs live on in
 * `approvals-actions.tsx`.
 */

const FILTER_KEYS = ["q", "department", "sort", "waiting_over", "min_amount", "quartile"] as const
const RESULT_LIMIT = 200

const SORTS = [
  { value: "waiting", label: "Longest wait first" },
  { value: "recent", label: "Most recently cleared" },
  { value: "amount", label: "Highest amount first" },
  { value: "amount_asc", label: "Lowest amount first" },
  { value: "department", label: "Department" },
  { value: "title", label: "Paper title" },
]

/** Why a claim is not ready to approve in a batch, in words for the desk. */
function notReady(c: QueueClaim): string[] {
  const why: string[] = []
  if (c.on_hold) why.push("on hold")
  if ((c.open_flags ?? 0) > 0) why.push("open flag")
  if (c.duplicate_warning) why.push("possible duplicate")
  if (c.calc_error || c.remuneration == null) why.push("no amount")
  return why
}

const isReady = (c: QueueClaim) => notReady(c).length === 0

export function Approvals() {
  const { me } = useAuth()
  const navigate = useNavigate()
  // The backend allows the Principal and a super admin standing in for one.
  const allowed = me?.role === "PRINCIPAL" || me?.role === "SUPER_ADMIN"

  const { values, set, clear, active: filtered } = useUrlFilters(FILTER_KEYS)
  const { q, department, waiting_over: waitingOver, min_amount: minAmount, quartile } = values
  const sort = values.sort || "waiting"
  const searchRef = useRef<HTMLInputElement>(null)
  useSlashToSearch(searchRef)

  const listQuery = new URLSearchParams()
  if (q) listQuery.set("q", q)
  if (department) listQuery.set("department", department)
  if (sort !== "waiting") listQuery.set("sort", sort)
  if (waitingOver) listQuery.set("waiting_over", waitingOver)
  if (minAmount) listQuery.set("min_amount", minAmount)
  if (quartile) listQuery.set("quartile", quartile)
  listQuery.set("limit", String(RESULT_LIMIT))

  const { data, isLoading, isError, isFetching, refetch } = useApi<QueuePayload>(
    ["principal-queue", q, department, sort, waitingOver, minAmount, quartile],
    `/api/principal/queue?${listQuery.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )
  const rows = useMemo(() => data?.results ?? [], [data])
  const ready = rows.filter(isReady)

  const [selected, setSelected] = useState<Map<string, QueueClaim>>(new Map())
  const [activeRow, setActiveRow] = useState(0)
  const [moreFilters, setMoreFilters] = useState(false)
  const [dialog, setDialog] = useState<null | "ready" | "selected" | "hold">(null)
  // One claim, decided on its own row: approve at the figure shown, or send
  // back with its own reason. Neither can be done in bulk (every send-back
  // needs a reason of its own; an approval confirms the one amount).
  const [acting, setActing] = useState<{ claim: QueueClaim; mode: "approve" | "send-back" } | null>(null)
  const [result, setResult] = useState<{ result: BulkApproveResult; lookup: Map<string, QueueClaim> } | null>(null)
  const [holdResult, setHoldResult] = useState<{ skipped: { id: string; reason: string }[]; lookup: Map<string, QueueClaim> } | null>(null)

  const href = (c: QueueClaim) => {
    const f = new URLSearchParams()
    for (const k of FILTER_KEYS) if (values[k]) f.set(k, values[k])
    return reviewLink(c.id, "approvals", filtered ? f : undefined)
  }

  useEffect(() => {
    setActiveRow((i) => Math.min(i, Math.max(0, rows.length - 1)))
  }, [rows.length])

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
      const every = rows.length > 0 && rows.every((c) => next.has(c.id))
      for (const c of rows) {
        if (every) next.delete(c.id)
        else next.set(c.id, c)
      }
      return next
    })
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (dialog) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (document.querySelector('[role="dialog"]')) return
      if (rows.length === 0) return
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setActiveRow((i) => Math.min(i + 1, rows.length - 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setActiveRow((i) => Math.max(i - 1, 0))
      } else if (e.key === "x") {
        e.preventDefault()
        const row = rows[activeRow]
        if (row) toggleSelected(row)
      } else if (e.key === "Enter") {
        e.preventDefault()
        const row = rows[activeRow]
        if (row) navigate(href(row))
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, activeRow, dialog])

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

  const selectedRows = [...selected.values()]
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const selectedNotReady = selectedRows.filter((c) => !isReady(c)).length
  const selectedNeedSecond = selectedRows.filter((c) => c.needs_second_approval).length
  const selectedOffList = selected.size - rows.filter((c) => selected.has(c.id)).length
  const readyTotal = ready.reduce((s, c) => s + (c.remuneration || 0), 0)

  const summary = (c: QueueClaim, withNote: boolean): SummaryRow => {
    const why = withNote ? notReady(c) : []
    return { ...c, note: why.length ? why.join(", ") : null }
  }

  function leftOut(batch: QueueClaim[]) {
    const ids = new Set(batch.map((c) => c.id))
    const rest = rows.filter((c) => !ids.has(c.id))
    const tally = new Map<string, number>()
    for (const c of rest) for (const w of notReady(c)) tally.set(w, (tally.get(w) ?? 0) + 1)
    return {
      count: rest.length,
      reasons: [...tally].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
    }
  }

  async function runBulkApprove(batch: QueueClaim[]) {
    const ids = batch.map((c) => c.id)
    const lookup = new Map(batch.map((c) => [c.id, c]))
    try {
      const res = await bulkApprove.mutateAsync({ claim_ids: ids })
      const skippedIds = new Set(res.skipped.map((s) => s.id))
      setSelected((prev) => {
        const next = new Map(prev)
        for (const id of ids) if (!skippedIds.has(id)) next.delete(id)
        return next
      })
      if (res.skipped.length === 0) {
        toast.stamp("Approved", `${res.approved} ${res.approved === 1 ? "claim" : "claims"} sent to the Director.`)
      } else {
        setResult({ result: res, lookup })
      }
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  const flagsFor = (c: QueueClaim) => (
    <>
      {c.on_hold && (
        <RowFlag tone="caution">
          <PauseCircle className="size-3" aria-hidden /> On hold
        </RowFlag>
      )}
      {(c.open_flags ?? 0) > 0 && (
        <RowFlag tone="caution">
          <AlertTriangle className="size-3" aria-hidden /> {c.open_flags} open {c.open_flags === 1 ? "flag" : "flags"}
        </RowFlag>
      )}
      {c.duplicate_warning && (
        <RowFlag tone="critical">
          <AlertTriangle className="size-3" aria-hidden /> Possible duplicate
        </RowFlag>
      )}
      {c.needs_second_approval && (
        <RowFlag tone="caution">
          <ShieldAlert className="size-3" aria-hidden /> Needs a second signature
        </RowFlag>
      )}
      {thresholdFlag(c) && <RowFlag tone="caution">{thresholdFlag(c)}</RowFlag>}
      {c.owner_threshold_unset && <RowFlag tone="caution">Research faculty, threshold not set</RowFlag>}
      {(c.calc_error || c.remuneration == null) && <RowFlag tone="critical">No amount</RowFlag>}
      {!c.calc_error && c.remuneration_is_estimate && <RowFlag tone="caution">Estimate</RowFlag>}
    </>
  )

  return (
    <div className="page space-y-5">
      <header className="page-head">
        <div>
          <PageTitle>Approvals</PageTitle>
          <Sub className="mt-1">Cleared claims waiting on you. Approve the spend, hold one, or send it back with a reason.</Sub>
          <OwnPapersNote className="mt-1" />
        </div>
        <Button kind="quiet" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
          Refresh
        </Button>
        <HeaderSpot name="spot-approvals" />
      </header>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {data ? (
          <p className="text-sm text-fg-muted">
            <span className="font-semibold text-fg">{data.totals.count}</span> waiting ·{" "}
            <span className="tabular font-semibold text-fg">{money(data.totals.amount)}</span> in all
            {data.totals.longest_wait_days != null &&
              ` · oldest waiting ${data.totals.longest_wait_days} ${data.totals.longest_wait_days === 1 ? "day" : "days"}`}
          </p>
        ) : (
          <span />
        )}
        {rows.length > 0 && (
          <Button kind="quiet" size="sm" onClick={() => downloadApprovals(rows)}>
            Download these {rows.length} as CSV
          </Button>
        )}
      </div>

      <div className={filterBar}>
        <SearchBox
          inputRef={searchRef}
          value={q}
          onCommit={(next) => set({ q: next })}
          placeholder="Claim no., title or claimant"
          label="Search the queue"
          className="sm:w-56"
        />
        <QuietSelect value={department} onChange={(v) => set({ department: v })} label="Filter by department">
          <option value="">All departments</option>
          {(data?.departments ?? []).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </QuietSelect>
        <QuietSelect value={sort} onChange={(v) => set({ sort: v === "waiting" ? "" : v })} label="Sort the queue">
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </QuietSelect>
        <Button kind="quiet" size="sm" className="sm:hidden" aria-expanded={moreFilters} onClick={() => setMoreFilters(!moreFilters)}>
          {moreFilters ? "Fewer filters" : "More filters"}
        </Button>
        <div className={cn("contents", !moreFilters && "max-sm:hidden")}>
        <QuietSelect value={quartile} onChange={(v) => set({ quartile: v })} label="Filter by quartile">
          <option value="">Any quartile</option>
          {["Q1", "Q2", "Q3", "Q4"].map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </QuietSelect>
        <SearchBox
          value={waitingOver}
          onCommit={(next) => set({ waiting_over: next.replace(/\D/g, "") })}
          placeholder="Days over"
          label="Only claims waiting longer than this many days"
          inputMode="numeric"
          className="sm:w-28"
        />
        <SearchBox
          value={minAmount}
          onCommit={(next) => set({ min_amount: next.replace(/\D/g, "") })}
          placeholder="₹ over"
          label="Only claims over this amount, in rupees"
          inputMode="numeric"
          className="sm:w-28"
        />
        </div>
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clear}>
            Clear filters
          </Button>
        )}
      </div>
      <ClaimNoJump term={q} skip={new Set(rows.map((c) => c.id))} />

      {ready.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-sunken px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">{ready.length}</span> of {rows.length} shown {ready.length === 1 ? "is" : "are"} ready to approve.{" "}
            <span className="text-fg-muted">No open flag, no duplicate and an amount worked out.</span>
          </p>
          <Button kind="primary" size="sm" className="ml-auto" onClick={() => setDialog("ready")}>
            Review the {ready.length} ready
          </Button>
        </div>
      )}

      <Meta className="hidden md:block">
        <kbd className="rounded border border-edge px-1 text-[10px]">j</kbd>/
        <kbd className="rounded border border-edge px-1 text-[10px]">k</kbd> to move ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">x</kbd> to select ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">Enter</kbd> to open ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">/</kbd> to search ·{" "}
        <button type="button" onClick={openShortcuts} className="underline underline-offset-2">
          all shortcuts
        </button>
      </Meta>

      {selected.size > 0 && (
        <div className="sticky top-14 z-20 space-y-2 rounded-lg bg-accent-wash px-4 py-3 shadow-pop md:top-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold">{selected.size}</span> selected ·{" "}
              <span className="font-semibold tabular">{money(selectedTotal)}</span>
              {selectedOffList > 0 && <span className="text-fg-muted"> · {selectedOffList} not shown by the filters</span>}
              {selectedNotReady > 0 && <span className="text-fg-muted"> · {selectedNotReady} not ready</span>}
              {selectedNeedSecond > 0 && (
                <span className="text-fg-muted"> · {selectedNeedSecond} still need a second signature after this</span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button kind="quiet" size="sm" onClick={() => setSelected(new Map())}>
                Clear selection
              </Button>
              <Button kind="default" size="sm" onClick={() => setDialog("hold")}>
                Put on hold
              </Button>
              <Button kind="primary" size="sm" onClick={() => setDialog("selected")}>
                Approve {selected.size} {selected.size === 1 ? "claim" : "claims"}
              </Button>
            </div>
          </div>
          <NoBulkSendBack />
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
          guide="approve-claims"
          art="empty-queue"
          icon={Inbox}
          title={filtered ? "Nothing matches these filters" : "Nothing waiting"}
          message={filtered ? "Try widening the search, department or wait-time filter." : "Every checked claim has been approved or sent back."}
          action={filtered ? undefined : <ComingUp desk="principal" />}
        />
      ) : (
        <>
          {data && data.total > rows.length && (
            <Meta className="block">
              Showing the first {rows.length} of {data.total}. Narrow the filters to see the rest.
            </Meta>
          )}
          <QueueTable
            label="Claims waiting for approval"
            rows={rows}
            reviewHref={href}
            showAmount
            flags={flagsFor}
            extra={{
              header: "Decide",
              className: "w-28",
              cell: (c) => (
                <div className="flex flex-wrap gap-2 md:flex-col md:items-stretch md:gap-1">
                  <Button kind="quiet" size="sm" onClick={() => setActing({ claim: c, mode: "send-back" })}>
                    Send back
                  </Button>
                  <Button
                    kind="primary"
                    size="sm"
                    disabled={!!c.calc_error || c.remuneration == null}
                    title={c.calc_error || c.remuneration == null ? "The amount could not be worked out" : undefined}
                    onClick={() => setActing({ claim: c, mode: "approve" })}
                  >
                    Approve
                  </Button>
                </div>
              ),
            }}
            active={activeRow}
            onActive={setActiveRow}
            select={{ selected: new Set(selected.keys()), onToggle: toggleSelected, onToggleAll: toggleAllVisible }}
          />
        </>
      )}

      <BulkSummaryDialog
        open={dialog === "ready"}
        onOpenChange={(o) => setDialog(o ? "ready" : null)}
        title={`Approve ${ready.length} ready ${ready.length === 1 ? "claim" : "claims"}?`}
        rows={ready.map((c) => summary(c, false))}
        showMoney
        leftOut={leftOut(ready)}
        confirmLabel={`Approve ${ready.length} for ${money(readyTotal)}`}
        footnote="They go to the Director to authorise, then Finance pays. Each is checked again as it approves; a claim whose amount has moved is skipped, not approved at the wrong number."
        onConfirm={() => runBulkApprove(ready)}
      />
      <BulkSummaryDialog
        open={dialog === "selected"}
        onOpenChange={(o) => setDialog(o ? "selected" : null)}
        title={`Approve ${selectedRows.length} ${selectedRows.length === 1 ? "claim" : "claims"}?`}
        rows={selectedRows.map((c) => summary(c, true))}
        showMoney
        confirmLabel={`Approve ${selectedRows.length} for ${money(selectedTotal)}`}
        footnote="They go to the Director to authorise, then Finance pays. Open any claim with a flag before you approve it if you are unsure."
        onConfirm={() => runBulkApprove(selectedRows)}
      />
      <BulkHoldDialog
        open={dialog === "hold"}
        onOpenChange={(o) => setDialog(o ? "hold" : null)}
        rows={selectedRows}
        onDone={(res) => {
          const held = new Set(res.held_ids)
          const lookup = new Map(selectedRows.map((c) => [c.id, c]))
          setSelected((prev) => {
            const next = new Map(prev)
            for (const id of held) next.delete(id)
            return next
          })
          if (res.skipped.length > 0) setHoldResult({ skipped: res.skipped, lookup })
        }}
      />

      {acting?.mode === "approve" && (
        <ApproveDialog
          claim={acting.claim}
          open
          onOpenChange={(o) => !o && setActing(null)}
          me={me}
          onApproved={() => setActing(null)}
        />
      )}
      {acting?.mode === "send-back" && (
        <RejectDialog
          claim={acting.claim}
          open
          onOpenChange={(o) => !o && setActing(null)}
          onRejected={() => setActing(null)}
        />
      )}

      {result && (
        <SkippedDialog
          title={`Approved ${result.result.approved} of ${result.result.approved + result.result.skipped.length}`}
          description={`${money(result.result.total)} sent to the Director. The rest were skipped, each for its own reason below. Nothing was approved at a wrong figure.`}
          skipped={result.result.skipped}
          lookup={result.lookup}
          onClose={() => setResult(null)}
        />
      )}
      {holdResult && (
        <SkippedDialog
          title="Some could not be put on hold"
          description="The others are on hold. These were left as they were."
          skipped={holdResult.skipped}
          lookup={holdResult.lookup}
          onClose={() => setHoldResult(null)}
        />
      )}
    </div>
  )
}

/** The approvals list as it is filtered on screen, for the Principal's own records. */
function downloadApprovals(rows: QueueClaim[]) {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
  const head = ["Claim no.", "Paper", "Claimant", "Department", "Journal", "Quartile", "Waiting days", "Amount (INR)"]
  const lines = rows.map((c) =>
    [c.ticket_number, c.paper_title, c.owner_name, c.owner_department, c.journal_title, c.quartile, c.waiting_days, c.remuneration]
      .map(cell)
      .join(",")
  )
  const blob = new Blob(["﻿" + [head.map(cell).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `approvals-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
