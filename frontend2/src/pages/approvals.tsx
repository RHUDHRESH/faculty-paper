import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Download, Inbox, ListFilter } from "lucide-react"

import { useAuth } from "@/app/auth"
import { openShortcuts } from "@/app/shortcuts"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { AnswerLine } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ClaimNoJump } from "@/ui/claim-number"
import { ComingUp } from "@/ui/coming-up"
import { Checkbox } from "@/ui/field"
import { OwnPapersNote } from "@/ui/own-papers"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { BulkHoldDialog, NoBulkSendBack, QuietSelect, SearchBox, SkippedDialog, reviewLink, useUrlFilters, waitingLabel } from "@/ui/queue"
import { useSlashToSearch } from "@/ui/queue-keys"
import { Details, Rows } from "@/ui/section"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import type { QueueClaim, QueuePayload } from "@/pages/approvals-actions"
import { ApprovalRow } from "@/pages/principal/approval-row"
import { isReady, notReady } from "@/pages/principal/ready"
import { useApprovals } from "@/pages/principal/use-approvals"

/**
 * The Principal's desk (docs/ux/27): every `CLEARED` claim waiting between the
 * research cell and the Director, in two lanes, longest wait first inside each.
 *
 * **Ready to approve** is the batch: nothing on hold, no open flag, no
 * duplicate, an amount worked out. **Needs a look** is the job, each row saying
 * why. The page's one primary button approves the ready lane after one
 * confirmation; a row approves or sends back on its own.
 *
 * Two things this page cannot get wrong. The order: `waiting_days` is the
 * queue's own priority and nothing here re-sorts it. The amount: the server
 * recomputes it as it approves, and a claim whose amount has moved is skipped
 * (bulk) or re-confirmed at the new figure (one), never approved at the old one.
 *
 * Keys: j/k move, x chooses, r chooses every ready claim, a approves the chosen
 * (or the claim under the cursor, if ready), s opens a claim to send back, h
 * holds, Enter opens, / searches.
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

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`

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
  const [showFilters, setShowFilters] = useState(false)

  const listQuery = new URLSearchParams()
  if (q) listQuery.set("q", q)
  if (department) listQuery.set("department", department)
  if (sort !== "waiting") listQuery.set("sort", sort)
  if (waitingOver) listQuery.set("waiting_over", waitingOver)
  if (minAmount) listQuery.set("min_amount", minAmount)
  if (quartile) listQuery.set("quartile", quartile)
  listQuery.set("limit", String(RESULT_LIMIT))

  const { data, isLoading, isError, refetch } = useApi<QueuePayload>(
    ["principal-queue", q, department, sort, waitingOver, minAmount, quartile],
    `/api/principal/queue?${listQuery.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )
  const rows = useMemo(() => data?.results ?? [], [data])
  const ready = rows.filter(isReady)
  const rest = rows.filter((c) => !isReady(c))
  // The cursor's order is the screen's order: the ready lane, then the rest.
  const ordered = useMemo(() => [...ready, ...rest], [ready, rest]) // eslint-disable-line react-hooks/exhaustive-deps

  const [selected, setSelected] = useState<Map<string, QueueClaim>>(new Map())
  const [activeRow, setActiveRow] = useState(0)
  const [hold, setHold] = useState(false)
  const [holdResult, setHoldResult] = useState<{ skipped: { id: string; reason: string }[]; lookup: Map<string, QueueClaim> } | null>(null)
  const ap = useApprovals({
    rows,
    onApproved: (ids) =>
      setSelected((prev) => {
        const next = new Map(prev)
        for (const id of ids) next.delete(id)
        return next
      }),
  })

  const href = (c: QueueClaim) => {
    const f = new URLSearchParams()
    for (const k of FILTER_KEYS) if (values[k]) f.set(k, values[k])
    return reviewLink(c.id, "approvals", filtered ? f : undefined)
  }

  useEffect(() => {
    setActiveRow((i) => Math.min(i, Math.max(0, ordered.length - 1)))
  }, [ordered.length])

  function toggleSelected(c: QueueClaim) {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }
  function toggleLane(lane: QueueClaim[]) {
    setSelected((prev) => {
      const next = new Map(prev)
      const every = lane.length > 0 && lane.every((c) => next.has(c.id))
      for (const c of lane) {
        if (every) next.delete(c.id)
        else next.set(c.id, c)
      }
      return next
    })
  }

  const selectedRows = [...selected.values()]
  const selectedTotal = selectedRows.reduce((s, c) => s + (c.remuneration || 0), 0)

  /** `a`: approve what is chosen, or the claim under the cursor if it is ready. */
  function approveKey() {
    if (selectedRows.length > 0) return ap.approveBatch(selectedRows)
    const row = ordered[activeRow]
    if (!row) return
    if (!isReady(row)) {
      toast.info(`${row.ticket_number ?? "This claim"} is not ready: ${notReady(row).join(", ").toLowerCase()}. Press Enter to look at it.`)
      return
    }
    ap.approveOne(row)
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (hold || holdResult) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (document.querySelector('[role="dialog"]')) return
      if (ordered.length === 0) return
      const row = ordered[activeRow]
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setActiveRow((i) => Math.min(i + 1, ordered.length - 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setActiveRow((i) => Math.max(i - 1, 0))
      } else if (e.key === "x" && row) {
        e.preventDefault()
        toggleSelected(row)
      } else if (e.key === "r") {
        e.preventDefault()
        toggleLane(ready)
      } else if (e.key === "a") {
        e.preventDefault()
        approveKey()
      } else if (e.key === "s" && row) {
        e.preventDefault()
        navigate(`${href(row)}&do=sendback`)
      } else if (e.key === "h") {
        e.preventDefault()
        if (selected.size === 0 && row) toggleSelected(row)
        setHold(true)
      } else if (e.key === "Enter" && row) {
        e.preventDefault()
        navigate(href(row))
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, activeRow, hold, holdResult, selected])

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

  const totals = data?.totals
  const oldest = totals?.longest_wait_days ?? null
  const answer = !data ? (
    "What waits for your approval."
  ) : rows.length === 0 ? (
    filtered ? (
      "No claim matches these filters."
    ) : (
      "Nothing is waiting."
    )
  ) : (
    <>
      {plural(totals?.count ?? rows.length, "claim", "claims")}, {money(totals?.amount ?? 0)}, {(totals?.count ?? rows.length) === 1 ? "is" : "are"} waiting.
    </>
  )

  const laneHead = (title: string, list: QueueClaim[], hint?: string) => (
    <div className="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="tabular text-sm text-fg-muted">
          {list.length}
          {list.some((c) => c.remuneration != null) && ` · ${money(list.reduce((s, c) => s + (c.remuneration || 0), 0))}`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {hint && <Meta className="hidden sm:inline">{hint}</Meta>}
        <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
          <Checkbox
            checked={list.length > 0 && list.every((c) => selected.has(c.id))}
            onCheckedChange={() => toggleLane(list)}
            aria-label={`Choose all ${list.length} in ${title.toLowerCase()}`}
          />
          Choose all
        </label>
      </div>
    </div>
  )

  let cursor = -1
  const lane = (list: QueueClaim[], isReadyLane: boolean) => (
    <Rows>
      {list.map((c) => {
        cursor += 1
        const i = cursor
        return (
          <ApprovalRow
            key={c.id}
            claim={c}
            me={me?.id}
            ready={isReadyLane}
            href={href(c)}
            active={i === activeRow}
            selected={selected.has(c.id)}
            onToggle={() => toggleSelected(c)}
            onActive={() => setActiveRow(i)}
            onApprove={() => ap.approveOne(c)}
            onSendBack={() => ap.sendBack(c)}
          />
        )
      })}
    </Rows>
  )

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Approvals"
        action={
          ready.length > 0 ? (
            <Button kind="primary" onClick={() => ap.approveBatch(ready)} disabled={ap.busy}>
              Approve the {ready.length} ready
            </Button>
          ) : undefined
        }
      />

      <div className="-mt-6 space-y-3">
        <AnswerLine>{answer}</AnswerLine>
        {rows.length > 0 && (
          <p className="max-w-[40rem] text-lead text-fg-muted">
            {rest.length === 0 ? `All ${rows.length} are ready.` : `${ready.length} are ready; ${rest.length} need a look.`}
            {oldest != null && ` The longest has waited ${waitingLabel(oldest).toLowerCase()}.`}
          </p>
        )}
      </div>

      {(rows.length > 0 || filtered) && (
        <section aria-label="Find and narrow" className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <SearchBox
                inputRef={searchRef}
                value={q}
                onCommit={(next) => set({ q: next })}
                placeholder="Claim no., title or claimant"
                label="Search the queue"
                className="min-w-0 flex-1 sm:w-80"
              />
              <Button kind="default" size="sm" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
                <ListFilter />
                Filters
              </Button>
            </div>
            <QuietSelect value={department} onChange={(v) => set({ department: v })} label="Filter by department" className="max-sm:hidden">
              <option value="">All departments</option>
              {(data?.departments ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </QuietSelect>
            {filtered && (
              <Button kind="default" size="sm" onClick={clear}>
                Clear filters
              </Button>
            )}
          </div>
          {showFilters && (
            <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
              <QuietSelect value={department} onChange={(v) => set({ department: v })} label="Filter by department" className="sm:hidden">
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
          )}
          <ClaimNoJump term={q} skip={new Set(rows.map((c) => c.id))} />
        </section>
      )}

      {selected.size > 0 && (
        <div className="sticky top-14 z-20 space-y-2 rounded-panel bg-surface px-4 py-3 shadow-pop ring-1 ring-edge md:top-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold">{selected.size}</span> chosen ·{" "}
              <span className="tabular font-semibold">{money(selectedTotal)}</span>
              {selectedRows.some((c) => !isReady(c)) && (
                <span className="text-caution"> · {selectedRows.filter((c) => !isReady(c)).length} not ready</span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button kind="default" size="sm" onClick={() => setSelected(new Map())}>
                Choose none
              </Button>
              <Button kind="default" size="sm" onClick={() => setHold(true)}>
                Put on hold
              </Button>
              <Button kind="primary" size="sm" onClick={() => ap.approveBatch(selectedRows)}>
                Approve {selected.size} {selected.size === 1 ? "claim" : "claims"}
              </Button>
            </div>
          </div>
          <NoBulkSendBack />
        </div>
      )}

      {isLoading ? (
        <>
          <SkeletonRows rows={8} rowHeight={72} className="hidden md:block" />
          <SkeletonRows rows={5} rowHeight={112} className="md:hidden" />
        </>
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          message="The server did not answer. Nothing has been lost or approved."
          onRetry={() => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          size="region"
          guide="approve-claims"
          art="empty-queue"
          icon={Inbox}
          title={filtered ? "Nothing matches these filters" : "Nothing waiting"}
          message={filtered ? "Widen the search or clear the filters." : "Every checked claim has been approved or sent back."}
          action={filtered ? undefined : <ComingUp desk="principal" />}
        />
      ) : (
        <div className="space-y-10">
          {data && data.total > rows.length && (
            <Meta className="block">
              Showing the first {rows.length} of {data.total}. Narrow the filters to see the rest.
            </Meta>
          )}
          {ready.length > 0 && (
            <section aria-label="Ready to approve">
              {laneHead("Ready to approve", ready)}
              {lane(ready, true)}
            </section>
          )}
          {rest.length > 0 && (
            <section aria-label="Needs a look">
              {laneHead("Needs a look", rest, "Open each one to decide.")}
              {lane(rest, false)}
            </section>
          )}
          <Details label="how this works">
            <div className="max-w-prose space-y-3 pt-2 text-sm text-fg-muted">
              <p>
                Ready means no open flag, no possible duplicate, nothing on hold and an amount worked out. Approving sends a claim to the
                Director to authorise, then Finance pays it. Each claim is checked again as it is approved.
              </p>
              <p>
                Days in amber have waited over 14 days; in red, over 30. Send back goes to the research cell with your reason, never to the
                claimant.
              </p>
              <p>
                Keys: <Kbd>j</Kbd> <Kbd>k</Kbd> move, <Kbd>a</Kbd> approve, <Kbd>x</Kbd> choose one, <Kbd>r</Kbd> choose the ready,{" "}
                <Kbd>s</Kbd> send back, <Kbd>h</Kbd> hold, <Kbd>Enter</Kbd> open, <Kbd>/</Kbd> search.{" "}
                <button type="button" onClick={openShortcuts} className="underline underline-offset-2">
                  All shortcuts
                </button>
              </p>
              <OwnPapersNote />
              <Button kind="default" size="sm" onClick={() => downloadApprovals(ordered)}>
                <Download />
                Download these {ordered.length} as CSV
              </Button>
            </div>
          </Details>
        </div>
      )}

      <BulkHoldDialog
        open={hold}
        onOpenChange={setHold}
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
      {holdResult && (
        <SkippedDialog
          title="Some could not be put on hold"
          description="The others are on hold. These were left as they were."
          skipped={holdResult.skipped}
          lookup={holdResult.lookup}
          onClose={() => setHoldResult(null)}
        />
      )}
      {ap.node}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className={cn("rounded border border-edge px-1 text-[0.6875rem]")}>{children}</kbd>
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
