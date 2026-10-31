import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Inbox } from "lucide-react"

import { useAuth } from "@/app/auth"
import { openShortcuts } from "@/app/shortcuts"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ClaimNoJump } from "@/ui/claim-number"
import { ComingUp } from "@/ui/coming-up"
import { filterBar } from "@/ui/filter-bar"
import { paperTitle } from "@/lib/names"
import { OwnPapersNote } from "@/ui/own-papers"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { BulkHoldDialog, NoBulkSendBack, QuietSelect, SearchBox, SkippedDialog, reviewLink, useUrlFilters } from "@/ui/queue"
import { useSlashToSearch } from "@/ui/queue-keys"
import { Details } from "@/ui/section"
import { ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
import { toast } from "@/ui/toast"
import type { QueueClaim, QueuePayload } from "@/pages/approvals-actions"
import { DeskTable } from "@/pages/desk-table"
import { isReady, notes, notReady } from "@/pages/principal/ready"
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
        <NotOpen message="Only the Principal, and a super admin standing in for one, can approve spend here." />
      </div>
    )
  }

  const totals = data?.totals
  const oldest = totals?.longest_wait_days ?? null
  const count = totals?.count ?? rows.length

  /** Why a claim is not ready, or that it is; then anything worth knowing that does not stop it. */
  const statusText = (c: QueueClaim) => [...(isReady(c) ? ["Ready to approve"] : notReady(c)), ...notes(c)].join(", ")
  const own = (c: QueueClaim) => !!me?.id && c.owner_id === me.id

  const sub = !data
    ? "Claims the research office has cleared, waiting for your approval."
    : rows.length === 0
      ? "Claims the research office has cleared wait here for your approval."
      : `${plural(count, "claim", "claims")}, ${money(totals?.amount ?? rows.reduce((s, c) => s + (c.remuneration || 0), 0))}, ${count === 1 ? "is" : "are"} waiting for your approval.`

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Approvals"
        sub={sub}
        action={
          ready.length > 0 ? (
            <Button kind="primary" onClick={() => ap.approveBatch(ready)} disabled={ap.busy}>
              Approve the {ready.length} ready
            </Button>
          ) : undefined
        }
      />

      <Answer
        items={[
          { value: data ? count : null, label: "claims waiting", zero: "Nothing is waiting" },
          { value: data ? money(totals?.amount ?? 0) : null, label: "comes to" },
          { value: data ? ready.length : null, label: "ready to approve", zero: "None is ready yet", tone: "positive" },
          {
            value: data ? (oldest ?? 0) : null,
            label: "days the longest has waited",
            zero: "Nothing is waiting",
            tone: oldest != null && oldest > 30 ? "critical" : oldest != null && oldest > 14 ? "caution" : "neutral",
          },
        ]}
      />

      {(rows.length > 0 || filtered) && (
        <section aria-label="Find and narrow" className="space-y-2">
          <div className={filterBar} role="search">
            <SearchBox
              inputRef={searchRef}
              value={q}
              onCommit={(next) => set({ q: next })}
              placeholder="Claim no., title or claimant"
              label="Search the queue"
              className="w-full min-w-0 sm:w-80"
            />
            <QuietSelect value={department} onChange={(v) => set({ department: v })} label="Filter by department">
              <option value="">All departments</option>
              {(data?.departments ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}
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
            <QuietSelect value={sort} onChange={(v) => set({ sort: v === "waiting" ? "" : v })} label="Sort the queue">
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </QuietSelect>
            <SearchBox
              value={waitingOver}
              onCommit={(next) => set({ waiting_over: next.replace(/\D/g, "") })}
              placeholder="Days over"
              label="Only claims waiting longer than this many days"
              inputMode="numeric"
              className="sm:w-32"
            />
            <SearchBox
              value={minAmount}
              onCommit={(next) => set({ min_amount: next.replace(/\D/g, "") })}
              placeholder="₹ over"
              label="Only claims over this amount, in rupees"
              inputMode="numeric"
              className="sm:w-32"
            />
            {filtered && (
              <Button kind="quiet" onClick={clear}>
                Clear filters
              </Button>
            )}
          </div>
          <ClaimNoJump term={q} skip={new Set(rows.map((c) => c.id))} />
        </section>
      )}

      {selected.size > 0 && (
        <div className="sticky top-14 z-20 space-y-2 rounded-panel bg-surface px-4 py-3 shadow-pop ring-1 ring-edge md:top-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold">{selected.size}</span> chosen,{" "}
              <span className="tabular font-semibold">{money(selectedTotal)}</span>
              {selectedRows.some((c) => !isReady(c)) && (
                <span className="text-caution">, {selectedRows.filter((c) => !isReady(c)).length} not ready</span>
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
        <SkeletonRows rows={8} rowHeight={56} />
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          message="The server did not answer. Nothing has been lost or approved."
          onRetry={() => refetch()}
        />
      ) : (
        <>
          {data && data.total > rows.length && (
            <p className="text-sm text-fg-muted">
              Showing the first {rows.length} of {data.total}. Narrow the filters to see the rest.
            </p>
          )}
          <DeskTable
            rows={ordered}
            href={href}
            id="approvals"
            title="Approvals"
            caption="Cleared claims waiting for approval, ready ones first"
            active={activeRow}
            onActive={setActiveRow}
            selection={{
              selected: new Set(selected.keys()),
              onToggle: toggleSelected,
              onToggleAll: () => toggleLane(ready),
              allLabel: `Choose all ${ready.length} ready to approve`,
              covers: isReady,
            }}
            status={{
              header: "Checks",
              text: statusText,
              cell: (c) => <span className={isReady(c) ? "text-positive" : "text-caution"}>{statusText(c)}</span>,
            }}
            action={(c) =>
              own(c) ? null : (
                <>
                  <Button kind="quiet" size="sm" onClick={() => ap.sendBack(c)}>
                    Send back
                  </Button>
                  {isReady(c) && c.remuneration != null && !c.calc_error ? (
                    <Button size="sm" onClick={() => ap.approveOne(c)} aria-label={`Approve: ${paperTitle(c.paper_title)}`}>
                      Approve
                    </Button>
                  ) : (
                    <Button size="sm" asChild>
                      <Link to={href(c)}>Review</Link>
                    </Button>
                  )}
                </>
              )
            }
            empty={
              filtered
                ? {
                    icon: Inbox,
                    guide: "approve-claims",
                    title: "Nothing matches these filters",
                    message: "Widen the search or clear the filters.",
                    action: (
                      <Button kind="default" onClick={clear}>
                        Clear filters
                      </Button>
                    ),
                  }
                : {
                    icon: Inbox,
                    guide: "approve-claims",
                    title: "Nothing is waiting",
                    message: "Claims the research office clears appear here for your approval.",
                    action: (
                      <Button kind="default" asChild>
                        <Link to="/track">See where claims are</Link>
                      </Button>
                    ),
                  }
            }
          />
          {rows.length === 0 && !filtered && <ComingUp desk="principal" />}
          {rows.length > 0 && (
            <Details label="how this works">
              <div className="max-w-prose space-y-3 pt-2 text-sm text-fg-muted">
                <p>
                  Ready means no open flag, no possible duplicate, nothing on hold and an amount worked out. Approving sends a claim
                  to the Director to authorise, then Finance pays it. Each claim is checked again as it is approved.
                </p>
                <p>
                  Days in amber have waited over 14 days; in red, over 30. Send back goes to the research office with your reason,
                  never to the claimant.
                </p>
                <p>
                  Keys: <Kbd>j</Kbd> <Kbd>k</Kbd> move, <Kbd>a</Kbd> approve, <Kbd>x</Kbd> choose one, <Kbd>r</Kbd> choose the ready,{" "}
                  <Kbd>s</Kbd> send back, <Kbd>h</Kbd> hold, <Kbd>Enter</Kbd> open, <Kbd>/</Kbd> search.{" "}
                  <button type="button" onClick={openShortcuts} className="underline underline-offset-2">
                    All shortcuts
                  </button>
                </p>
                <OwnPapersNote />
              </div>
            </Details>
          )}
        </>
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
  return <kbd className={cn("rounded border border-edge px-1 text-xs")}>{children}</kbd>
}
