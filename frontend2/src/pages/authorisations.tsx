import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { CircleCheck, Stamp } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import {
  AuthoriseDialog,
  BulkAuthoriseDialog,
  SendBackDialog,
  thresholdClause,
  type AuthClaim,
} from "@/pages/authorise-dialogs"
import { DeskTable } from "@/pages/desk-table"
import { BatchCheck } from "@/pages/batch-check"
import { BudgetStrip, budgetLine } from "@/pages/budget-strip"
import { useBudgetNow } from "@/pages/pay-parts"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ClaimNoJump } from "@/ui/claim-number"
import { ComingUp } from "@/ui/coming-up"
import { filterBar } from "@/ui/filter-bar"
import { money } from "@/ui/paper"
import { PageHeader } from "@/ui/page-header"
import { Pagination } from "@/ui/pagination"
import { useSlashToSearch } from "@/ui/queue-keys"
import { QuietSelect, SearchBox, reviewLink, useUrlFilters } from "@/ui/queue"
import { Details } from "@/ui/section"
import { ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
import { OwnPapersNote } from "@/ui/own-papers"
import { thresholdFlag } from "@/ui/research-threshold"

/**
 * The Director's queue: everything the Principal has approved and nobody has
 * yet authorised (docs/ux/28).
 *
 * The Principal answers "is this claim correct and should we pay it". The
 * Director answers "can the institution pay it, this month, against this
 * budget, alongside everything else being authorised". So the top says three
 * figures and then the one picture that second question needs: the budget
 * strip, with this queue carved out of the year. The work is two lanes: the
 * claims that can be authorised now (every one has an amount worked out), and
 * the few that cannot yet and why. One primary button authorises the lot, or
 * what has been chosen; `a` authorises the cursor row or the chosen ones and
 * Enter confirms; `A` (shift) authorises every ready claim.
 *
 * The Director is contest-blind: the server strips every flag, contest and
 * duplicate key from what this desk receives, and this screen names none of
 * them. The chain past the Principal is forward-only, so the Director has no
 * send-back; a super admin standing in keeps it as the rescue.
 */

const PAGE_SIZE = 50
const FILTER_KEYS = ["q", "department", "sort"] as const

export type Claim = AuthClaim
export { BulkAuthoriseDialog }

type DepartmentTotal = { department: string | null; count: number; amount: number }

type QueuePayload = {
  total: number
  limit: number
  offset: number
  results: Claim[]
  /** Over everything the filter matched, never the page. */
  totals: { count: number; amount: number; longest_wait_days: number | null }
  departments: string[]
  by_department?: DepartmentTotal[]
}

export function Authorisations() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const allowed = can(me?.role).authorise
  const standingIn = me?.role === "SUPER_ADMIN"

  const { values, set, clear, active: filtered } = useUrlFilters(FILTER_KEYS)
  const { q, department } = values
  const sort = values.sort || "waiting"
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)
  const searchRef = useRef<HTMLInputElement>(null)
  useSlashToSearch(searchRef)

  const [selected, setSelected] = useState<Map<string, Claim>>(new Map())
  const [acting, setActing] = useState<{ claim: Claim; mode: "authorise" | "send-back" } | null>(null)
  const [batch, setBatch] = useState<Claim[] | null>(null)
  const [activeRow, setActiveRow] = useState(0)

  function setPage(next: number) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next > 0) p.set("page", String(next))
        else p.delete("page")
        return p
      },
      { replace: true }
    )
  }

  const query = new URLSearchParams()
  if (q) query.set("q", q)
  if (department) query.set("department", department)
  query.set("sort", sort)
  query.set("limit", String(PAGE_SIZE))
  query.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<QueuePayload>(
    ["director-queue", q, department, sort, page],
    `/api/director/queue?${query.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )
  const budget = useBudgetNow(allowed)

  const rows = useMemo(() => data?.results ?? [], [data])
  const ready = useMemo(() => rows.filter((r) => !r.calc_error), [rows])
  const stuck = useMemo(() => rows.filter((r) => r.calc_error), [rows])
  // The cursor walks the ready lane first, then the other: one list to the keys.
  const order = useMemo(() => [...ready, ...stuck], [ready, stuck])
  const chosen = ready.filter((r) => selected.has(r.id))
  const chosenTotal = chosen.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const readyTotal = ready.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const totals = data?.totals

  const href = (c: Claim) => {
    const f = new URLSearchParams()
    for (const k of FILTER_KEYS) if (values[k]) f.set(k, values[k])
    return reviewLink(c.id, "authorisations", filtered ? f : undefined)
  }

  // A selection made on one page is meaningless on the next, and a hidden
  // selection is how somebody authorises rows they cannot see.
  useEffect(() => {
    setSelected(new Map())
  }, [q, department, sort, page])
  useEffect(() => {
    setActiveRow((i) => Math.min(i, Math.max(0, order.length - 1)))
  }, [order.length])

  function toggle(c: Claim) {
    if (c.calc_error) return
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }
  const allChosen = ready.length > 0 && ready.every((c) => selected.has(c.id))
  function toggleAll() {
    setSelected(allChosen ? new Map() : new Map(ready.map((c) => [c.id, c])))
  }

  // Keys: j/k move, x chooses, Enter opens, a authorises the chosen (or the
  // row under the cursor), A authorises every ready claim on the page.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (document.querySelector('[role="dialog"]')) return
      if (order.length === 0) return
      const row = order[activeRow]
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setActiveRow((i) => Math.min(i + 1, order.length - 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setActiveRow((i) => Math.max(i - 1, 0))
      } else if (e.key === "x" && row) {
        e.preventDefault()
        toggle(row)
      } else if (e.key === "Enter" && row && !target?.closest("button, a")) {
        e.preventDefault()
        navigate(href(row))
      } else if (e.key === "a") {
        e.preventDefault()
        if (chosen.length > 0) setBatch(chosen)
        else if (row && !row.calc_error) setActing({ claim: row, mode: "authorise" })
      } else if (e.key === "A" && ready.length > 0) {
        e.preventDefault()
        setBatch(ready)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, activeRow, chosen, ready])

  if (!allowed) {
    return (
      <div className="page py-8">
        <NotOpen message="Authorising a payment is the Director's, and a super admin standing in for one." />
      </div>
    )
  }

  const departmentOptions = data?.departments ?? []
  const longest = totals?.longest_wait_days
  const selection = new Set(selected.keys())

  /** Why a claim can or cannot be authorised yet, in a phrase; a research threshold is said beside the amount. */
  const statusText = (c: Claim) => {
    if (c.calc_error) return "The amount could not be worked out, so it cannot be authorised yet."
    const held = thresholdClause(c) ?? thresholdFlag(c)
    return held ? `Ready to authorise. ${held}` : "Ready to authorise"
  }

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Authorisations"
        sub="Claims the Principal approved, waiting for your signature."
        action={
          ready.length > 0 ? (
            <Button kind={chosen.length > 0 ? "default" : "primary"} size="lg" onClick={() => setBatch(ready)}>
              <Stamp />
              Authorise all {formatCount(ready.length)} · {money(readyTotal)}
            </Button>
          ) : undefined
        }
      />

      {!(isError && !data) && (
        <>
          <Answer
            items={[
              { label: "Waiting for you", value: totals ? totals.count : null, zero: "Nothing is waiting for you" },
              { label: department ? `From ${department}` : "Comes to", value: totals ? money(totals.amount) : null },
              {
                label: "Days the longest has waited",
                value: totals ? (longest ?? 0) : null,
                zero: "Nothing is waiting",
                tone: longest != null && longest > 30 ? "critical" : undefined,
              },
            ]}
          />
          {(totals?.count ?? 0) > 0 && (
            <div className="max-w-2xl space-y-3">
              <p className="text-base text-fg">{budgetLine(budget.data, "authorising", (totals?.count ?? 0) !== 1) ?? " "}</p>
              <BudgetStrip budget={budget.data?.college} batch={totals?.amount ?? 0} labels="wide" />
            </div>
          )}
          {(totals?.count ?? 0) > 0 && <BatchCheck stage="authorise" department={department || undefined} />}
        </>
      )}

      <section className="min-w-0 space-y-4" aria-label="Approved claims">
        <div className={filterBar} role="search">
          <SearchBox
            inputRef={searchRef}
            value={q}
            onCommit={(next) => set({ q: next })}
            placeholder="Search claimant, paper or claim no."
            label="Search the queue"
          />
          <QuietSelect value={department} onChange={(v) => set({ department: v })} label="Filter by department">
            <option value="">All departments</option>
            {departmentOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </QuietSelect>
          <QuietSelect value={sort} onChange={(v) => set({ sort: v === "waiting" ? "" : v })} label="Sort">
            <option value="waiting">Longest waiting first</option>
            <option value="recent">Most recently approved</option>
            <option value="amount">Largest amount first</option>
            <option value="department">By department</option>
          </QuietSelect>
          {filtered && (
            <Button kind="quiet" onClick={clear}>
              Clear filters
            </Button>
          )}
        </div>
        <ClaimNoJump term={q} skip={new Set(rows.map((c) => c.id))} />

        {chosen.length > 0 && (
          // Pinned under the header while the list scrolls: on a phone the
          // rows being ticked are a screen below where the button was.
          <div className="sticky top-14 z-20 flex flex-wrap items-center justify-between gap-3 rounded-panel bg-surface px-4 py-3 shadow-pop ring-1 ring-edge md:top-2">
            <p className="text-sm tabular">
              <span className="font-semibold">{formatCount(chosen.length)}</span> chosen,{" "}
              <span className="font-semibold">{money(chosenTotal)}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button kind="default" onClick={() => setSelected(new Map())}>
                Clear choice
              </Button>
              <Button kind="primary" onClick={() => setBatch(chosen)}>
                <Stamp />
                Authorise {formatCount(chosen.length)} chosen
              </Button>
            </div>
          </div>
        )}

        {isLoading && !data ? (
          <SkeletonRows rows={6} rowHeight={56} />
        ) : isError ? (
          <ErrorState
            title="Could not load the queue"
            message={
              error?.status === 403
                ? "Not allowed. Only the Director, or a super admin standing in, can authorise."
                : "The server did not answer. Nothing has been authorised."
            }
            onRetry={error?.status === 403 ? false : () => refetch()}
          />
        ) : (
          <>
            <DeskTable
              rows={order}
              href={href}
              id="authorisations"
              title="Authorisations"
              caption="Approved claims waiting for authorisation, ready ones first"
              active={activeRow}
              onActive={setActiveRow}
              selection={{
                selected: selection,
                onToggle: toggle,
                onToggleAll: toggleAll,
                canSelect: (c) => !c.calc_error,
                allLabel: "Choose every ready claim",
              }}
              extra={[
                {
                  key: "approved",
                  header: "Approved on",
                  exportValue: (c) => c.principal_approved_at,
                  cell: (c) => approvedOn(c.principal_approved_at),
                },
              ]}
              status={{
                header: "Status",
                text: statusText,
                cell: (c) => <span className={c.calc_error ? "text-critical" : undefined}>{statusText(c)}</span>,
              }}
              action={(c) =>
                c.calc_error ? (
                  <Button size="sm" asChild>
                    <Link to={href(c)}>Open</Link>
                  </Button>
                ) : (
                  <>
                    {standingIn && (
                      <Button size="sm" kind="danger" onClick={() => setActing({ claim: c, mode: "send-back" })}>
                        Send back
                      </Button>
                    )}
                    <Button size="sm" onClick={() => setActing({ claim: c, mode: "authorise" })}>
                      Authorise
                    </Button>
                  </>
                )
              }
              empty={
                filtered
                  ? {
                      icon: CircleCheck,
                      guide: "authorise-the-month",
                      title: department ? `Nothing waiting from ${department}` : "No claim matches these filters",
                      message: "Another department or search may still have claims waiting.",
                      action: (
                        <Button kind="default" onClick={clear}>
                          Show the whole queue
                        </Button>
                      ),
                    }
                  : {
                      icon: CircleCheck,
                      guide: "authorise-the-month",
                      title: "Nothing is waiting for your signature",
                      message: "The Principal's next approvals appear here as soon as they are signed.",
                      action: (
                        <Button kind="default" asChild>
                          <Link to="/track">See where claims are</Link>
                        </Button>
                      ),
                    }
              }
            />
            {rows.length === 0 && !filtered && <ComingUp desk="director" />}
            <Pagination page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onChange={(next) => setPage(next)} />
          </>
        )}
      </section>

      {rows.length > 0 && (data?.by_department?.length ?? 0) > 1 && (
        <Details label="what is waiting, by department" count={data?.by_department?.length}>
          <ul className="mt-1 max-w-xl divide-y divide-line">
            {data?.by_department?.map((r) => {
              const name = r.department ?? ""
              const on = !!name && name === department
              return (
                <li key={name || "none"}>
                  <button
                    type="button"
                    disabled={!name}
                    aria-pressed={on}
                    onClick={() => set({ department: on ? "" : name })}
                    className={cn(
                      "flex min-h-11 w-full items-baseline justify-between gap-3 rounded-control px-2 py-2 text-left text-sm",
                      name && "hover:bg-hover",
                      on && "bg-selected"
                    )}
                  >
                    <span className="min-w-0 truncate">
                      {name || "No department"} <span className="text-fg-subtle">· {r.count}</span>
                    </span>
                    <span className="shrink-0 font-medium tabular">{money(r.amount)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Details>
      )}

      <Details label="how this desk works">
        <div className="mt-1 max-w-prose space-y-2 text-sm text-fg-muted">
          <p>Authorising releases a claim to Finance at the amount shown, and Finance pays that and nothing else.</p>
          <OwnPapersNote />
          {!standingIn && <p>A question about an approval goes to the Principal. This desk only moves claims forward.</p>}
          <p>
            Keys: j and k move, x chooses, a authorises the chosen claims or the one under the cursor, shift and a
            authorises every ready claim, Enter opens the claim, / searches.
          </p>
        </div>
      </Details>

      {acting?.mode === "authorise" && <AuthoriseDialog claim={acting.claim} onClose={() => setActing(null)} />}
      {acting?.mode === "send-back" && <SendBackDialog claim={acting.claim} onClose={() => setActing(null)} />}
      {batch && (
        <BulkAuthoriseDialog claims={batch} onClose={() => setBatch(null)} onDone={() => setSelected(new Map())} />
      )}
    </div>
  )
}

const approvedOn = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}
