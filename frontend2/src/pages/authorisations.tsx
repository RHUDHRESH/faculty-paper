import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { CircleCheck, Stamp } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import {
  AuthoriseDialog,
  BulkAuthoriseDialog,
  SendBackDialog,
  thresholdClause,
  type AuthClaim,
} from "@/pages/authorise-dialogs"
import { BudgetStrip, budgetLine } from "@/pages/budget-strip"
import { useBudgetNow } from "@/pages/pay-parts"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ClaimNo, ClaimNoJump } from "@/ui/claim-number"
import { ComingUp } from "@/ui/coming-up"
import { Checkbox } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { money } from "@/ui/paper"
import { PageHeader } from "@/ui/page-header"
import { Pagination } from "@/ui/pagination"
import { Avatar, initialsOf } from "@/ui/person"
import { useSlashToSearch } from "@/ui/queue-keys"
import { QuietSelect, SearchBox, reviewLink, useUrlFilters, waitTone, waitingLabel } from "@/ui/queue"
import { Details, Section } from "@/ui/section"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
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
        <ErrorState
          art="closed-gate"
          title="Not open to this account"
          message="Authorising a payment is the Director's, and a super admin standing in for one."
        />
      </div>
    )
  }

  const departmentOptions = data?.departments ?? []
  const authoriseAll = (
    <Button
      kind={chosen.length > 0 ? "default" : "primary"}
      size="lg"
      disabled={ready.length === 0}
      onClick={() => setBatch(ready)}
    >
      <Stamp />
      Authorise all {formatCount(ready.length)} · {money(readyTotal)}
    </Button>
  )
  const longest = totals?.longest_wait_days

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Authorisations"
        sub="Claims the Principal approved, waiting for your signature."
        action={ready.length > 0 ? authoriseAll : undefined}
        spot="spot-authorisations"
      />

      {!(isError && !data) && (
        <div className="space-y-5">
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
              <p className="text-lead text-fg">{budgetLine(budget.data, "authorising", (totals?.count ?? 0) !== 1) ?? " "}</p>
              <BudgetStrip budget={budget.data?.college} batch={totals?.amount ?? 0} labels="wide" />
            </div>
          )}
        </div>
      )}

      <section className="min-w-0 space-y-4" aria-label="Approved claims">
        <div className={filterBar}>
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
            <Button kind="default" size="md" onClick={clear}>
              Clear filters
            </Button>
          )}
        </div>
        <ClaimNoJump term={q} skip={new Set(rows.map((c) => c.id))} />

        {chosen.length > 0 && (
          // Pinned under the header while the list scrolls: on a phone the
          // rows being ticked are a screen below where the button was.
          <div className="sticky top-14 z-20 flex flex-wrap items-center justify-between gap-3 rounded-panel bg-accent-wash px-4 py-3 shadow-pop md:top-2">
            <p className="text-sm tabular">
              <span className="font-semibold">{formatCount(chosen.length)}</span> chosen ·{" "}
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
          <SkeletonRows rows={6} rowHeight={72} />
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
        ) : rows.length === 0 ? (
          <EmptyState
            guide="authorise-the-month"
            // With a filter on, "every approved claim has been authorised"
            // would be a claim about the whole college made from one
            // search's empty page.
            art={filtered ? "no-results" : "empty-queue"}
            icon={CircleCheck}
            title={
              department
                ? `Nothing waiting from ${department}`
                : filtered
                  ? "No claim matches these filters"
                  : "Nothing is waiting for your signature"
            }
            message={
              filtered
                ? "Another department or search may still have claims waiting."
                : "The Principal's next approvals appear here as soon as they are signed."
            }
            action={
              filtered ? (
                <Button kind="default" onClick={clear}>
                  Show the whole queue
                </Button>
              ) : (
                <ComingUp desk="director" />
              )
            }
          />
        ) : (
          <>
            {ready.length > 0 && (
              <Section
                title={`Ready to authorise (${formatCount(ready.length)})`}
                action={
                  <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-sm text-fg-muted max-sm:min-h-10">
                    <Checkbox checked={allChosen} onCheckedChange={toggleAll} aria-label="Choose every ready claim" />
                    Choose all
                  </label>
                }
              >
                <ul className="divide-y divide-line" aria-label="Claims ready to authorise">
                  {ready.map((c) => (
                    <AuthRow
                      key={c.id}
                      c={c}
                      href={href(c)}
                      active={order[activeRow]?.id === c.id}
                      chosen={selected.has(c.id)}
                      onActive={() => setActiveRow(order.indexOf(c))}
                      onToggle={() => toggle(c)}
                      onAuthorise={() => setActing({ claim: c, mode: "authorise" })}
                      onSendBack={standingIn ? () => setActing({ claim: c, mode: "send-back" }) : undefined}
                    />
                  ))}
                </ul>
              </Section>
            )}
            {stuck.length > 0 && (
              <Section title={`Cannot be authorised yet (${formatCount(stuck.length)})`}>
                <ul className="divide-y divide-line" aria-label="Claims that cannot be authorised yet">
                  {stuck.map((c) => (
                    <AuthRow
                      key={c.id}
                      c={c}
                      href={href(c)}
                      active={order[activeRow]?.id === c.id}
                      chosen={false}
                      onActive={() => setActiveRow(order.indexOf(c))}
                      onToggle={() => {}}
                      onAuthorise={() => {}}
                    />
                  ))}
                </ul>
              </Section>
            )}
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

/* ------------------------------------------------------------------------ */
/* One row                                                                   */
/* ------------------------------------------------------------------------ */

const approvedOn = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}

/**
 * The person leads, then the paper, then a quiet line (claim number, who
 * approved and when). The research threshold sits beside the amount, so the
 * Director authorises the figure that will be paid. The cursor is `bg-selected`
 * and never a stripe. The whole row opens the claim; the Authorise button acts
 * from where the eye is.
 */
function AuthRow({
  c,
  href,
  active,
  chosen,
  onActive,
  onToggle,
  onAuthorise,
  onSendBack,
}: {
  c: Claim
  href: string
  active: boolean
  chosen: boolean
  onActive: () => void
  onToggle: () => void
  onAuthorise: () => void
  onSendBack?: () => void
}) {
  const navigate = useNavigate()
  const ref = useRef<HTMLLIElement>(null)
  // Follow the cursor when the keys move it, but never on first paint: on a
  // phone the first row is under the fold and the page must not jump to it.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current && active) ref.current?.scrollIntoView?.({ block: "nearest" })
    mounted.current = true
  }, [active])
  const blocked = !!c.calc_error
  const when = approvedOn(c.principal_approved_at)
  const held = thresholdClause(c) ?? thresholdFlag(c)
  const days = c.waiting_days
  return (
    <li
      ref={ref}
      data-active={active || undefined}
      data-claim={c.ticket_number ?? undefined}
      onMouseEnter={onActive}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input, label, [role=checkbox]")) return
        navigate(href)
      }}
      className={cn("flex cursor-pointer items-start gap-2 px-2 py-3 sm:gap-3 sm:px-3", active ? "bg-selected" : "hover:bg-hover")}
    >
      {blocked ? (
        <span className="size-10 shrink-0 max-sm:-ml-1" aria-hidden />
      ) : (
        <label className="-my-1 grid size-10 shrink-0 cursor-pointer place-items-center max-sm:-ml-1" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={chosen} onCheckedChange={onToggle} aria-label={`Choose ${c.ticket_number || c.paper_title}`} />
        </label>
      )}
      <Avatar
        size="md"
        person={{ name: c.owner_name, initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-medium">{c.owner_name}</span>
          {c.owner_department && <span className="text-fg-muted"> · {c.owner_department}</span>}
        </p>
        <Link
          to={href}
          className="line-clamp-2 block text-base text-fg underline-offset-4 hover:underline sm:line-clamp-1"
          title={c.paper_title}
        >
          {paperTitle(c.paper_title)}
        </Link>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          <ClaimNo value={c.ticket_number} className="text-xs" />
          {when && <span>Approved {when}</span>}
          {/* On a phone the figures sit under the paper. */}
          {!blocked && <span className="tabular sm:hidden">{money(c.remuneration)}</span>}
          <span className={cn("tabular sm:hidden", waitTone(days) && `font-medium ${waitTone(days)}`)}>{waitingLabel(days)}</span>
        </p>
        {held && <p className="mt-1 text-sm text-caution">{held}</p>}
        {blocked && <p className="mt-1 text-sm text-critical">The amount could not be worked out, so it cannot be authorised yet.</p>}
        <div className="mt-2 flex gap-2 sm:hidden">
          {!blocked && (
            <Button size="sm" onClick={onAuthorise}>
              Authorise
            </Button>
          )}
          {onSendBack && !blocked && (
            <Button size="sm" kind="danger" onClick={onSendBack}>
              Send back
            </Button>
          )}
        </div>
      </div>
      <div className="hidden w-28 shrink-0 text-right sm:block">
        {!blocked && <p className="tabular text-base font-medium">{money(c.remuneration)}</p>}
      </div>
      <div className="hidden w-[4.5rem] shrink-0 text-right sm:block">
        <p className={cn("tabular text-sm", waitTone(days) ? `font-medium ${waitTone(days)}` : "text-fg-muted")}>{waitingLabel(days)}</p>
      </div>
      <div className="hidden shrink-0 gap-2 sm:flex">
        {onSendBack && !blocked && (
          <Button size="sm" kind="danger" onClick={onSendBack}>
            Send back
          </Button>
        )}
        {blocked ? (
          <Button size="sm" asChild>
            <Link to={href}>Open</Link>
          </Button>
        ) : (
          <Button size="sm" onClick={onAuthorise}>
            Authorise
          </Button>
        )}
      </div>
    </li>
  )
}

