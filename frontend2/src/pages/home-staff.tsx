import { firstName } from "@/lib/names"
import { Link } from "react-router-dom"
import { motion } from "motion/react"
import { useState } from "react"
import {
  ArrowUpRight,
  BarChart3,
  Building2,
  ClipboardCheck,
  Copy,
  FileCheck,
  Plus,
  TriangleAlert,
  Users,
} from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import {
  MoneySkeleton,
  MoneyStrip,
  NeedsYou,
  OnTheWay,
  PaidList,
  useOwnPapers,
} from "@/pages/home-faculty"
import { Button } from "@/ui/button"
import { money, Stage, stageOf } from "@/ui/paper"
import { Callout, ErrorState, InlineError, Skeleton } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * The first screen for everybody who is not a claimant — the research cell, a
 * super admin, the Principal, Finance and a head of department.
 *
 * Four of the six roles in this system used to sign in and land on "Not built
 * yet", which is the worst possible first sentence an app can say to the
 * person who runs it. Each of these answers the one question that role
 * actually arrives with, and nothing else:
 *
 *   office     what is stuck, what is waiting, what moved
 *   principal  what is waiting on me, and what is it worth
 *   finance    what is payable, what does it total, what is blocked
 *   head       what has my department published, and who has not
 *
 * Every figure here is fetched from the same endpoint as the screen it links
 * to, never recomputed from a different one. A home page whose count
 * disagrees with the queue it points at is worse than a home page with no
 * count on it, because the reader cannot tell which of the two is lying.
 */

/* ------------------------------------------------------------------------ */
/* Shared parts                                                              */
/* ------------------------------------------------------------------------ */

export function greeting(name: string | undefined): string {
  const first = firstName(name)
  return first ? `Hello, ${first}` : "Home"
}

/** A number that is an answer, not a tile — same as the faculty home. */
export function Figure({
  label,
  value,
  hint,
  tone,
  muted,
  loading,
}: {
  label: string
  value: string
  hint?: string
  tone?: "critical" | "positive" | "caution"
  muted?: boolean
  loading?: boolean
}) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      {loading ? (
        <Skeleton className="mt-1 h-7 w-24" />
      ) : (
        <p
          className={cn(
            "mt-0.5 text-2xl font-semibold tabular",
            tone === "critical" && "text-critical",
            tone === "positive" && "text-positive",
            tone === "caution" && "text-caution",
            muted && "text-fg-subtle"
          )}
        >
          {value}
        </p>
      )}
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}

/**
 * One queue, as a line you can act on.
 *
 * Deliberately a row and not a card: five bordered boxes down a page is the
 * furniture this app's whole design brief is a reaction against, and a queue
 * with nothing in it should recede rather than sit there in a box demanding
 * the same attention as one with forty tickets waiting.
 */
export function QueueRow({
  icon: Icon,
  label,
  count,
  detail,
  to,
  tone,
  loading,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count: number | null
  detail?: string
  to: string
  tone?: "critical" | "caution"
  loading?: boolean
}) {
  const empty = count === 0

  return (
    <li className="row">
      <Link to={to} className="flex items-center gap-4 px-1 py-3 sm:px-2">
        <Icon
          className={cn(
            "size-4 shrink-0",
            empty ? "text-fg-subtle" : tone === "critical" ? "text-critical" : "text-fg-muted"
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className={cn("block text-base", empty && "text-fg-muted")}>{label}</span>
          {detail && <Meta className="block truncate">{detail}</Meta>}
        </span>
        {loading ? (
          <Skeleton className="h-6 w-10" />
        ) : (
          <span
            className={cn(
              "shrink-0 text-lg font-semibold tabular",
              empty && "text-fg-subtle",
              !empty && tone === "critical" && "text-critical",
              !empty && tone === "caution" && "text-caution"
            )}
          >
            {count === null ? "—" : count.toLocaleString("en-IN")}
          </span>
        )}
        <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
      </Link>
    </li>
  )
}

export type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name?: string | null
  owner_department?: string | null
  status: string
  remuneration: number | null
  updated_at: string | null
}

/**
 * A ticket, in a list on a home page.
 *
 * It carries an amount, so it is only ever rendered on a home that is
 * allowed to show one. `HodHome` deliberately does not use it — the
 * money-blind screen is built out of its own money-free rows rather than out
 * of this one with a flag turned off, because a flag defaulting to "show"
 * is one careless call site away from a leak.
 */
export function ClaimRow({ claim }: { claim: Claim }) {
  return (
    <li className="row">
      <Link to={`/papers/${claim.id}`} className="flex items-center gap-4 px-1 py-2.5 sm:px-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base">{claim.paper_title || "Untitled"}</span>
          <Meta className="block truncate">
            {[claim.owner_name, claim.owner_department, claim.ticket_number]
              .filter(Boolean)
              .join(" · ")}
          </Meta>
        </span>
        <span className="hidden w-24 shrink-0 text-right text-base tabular sm:block">
          {claim.remuneration ? money(claim.remuneration) : ""}
        </span>
        <Stage stage={stageOf(claim.status)} className="w-[7.5rem] shrink-0" />
        <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
      </Link>
    </li>
  )
}

export function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-2"
    >
      {children}
    </motion.section>
  )
}

/* ------------------------------------------------------------------------ */
/* The office — research cell and super admin                               */
/* ------------------------------------------------------------------------ */

type StageCounts = {
  counts: {
    all: number
    draft: number
    filed: number
    checked: number
    approved: number
    paid: number
    sent_back: number
  }
}

type FaultsSummary = { total: number; urgent: number; checked_at: string }
type RequestsSummary = { pending: number }
type DuplicatesSummary = { summary: { open: number; at_issue: number } }
type Dashboard = {
  recent: Claim[]
  total_paid: number
  ledger_total?: number
  ledger_since?: string | null
}

/** "Every payment in the ledger since Jan 2024", or nothing without a ledger. */
export function collegeSince(ym: string | null | undefined): string | undefined {
  if (!ym) return undefined
  const [y, m] = ym.split("-").map(Number)
  const d = new Date(y, (m || 1) - 1, 1)
  return `Every payment in the ledger since ${d.toLocaleDateString("en-IN", { month: "short", year: "numeric" })}`
}

/**
 * What is stuck, what is waiting, and what moved.
 *
 * The clearing count comes from `/api/claims/counts` rather than from the
 * length of `/api/admin/clearing-queue`, which is capped at 200 rows — on a
 * backlog of 340 the queue screen says 340 and a count taken from the array
 * would have said 200, on the same page, three lines apart.
 */
export function OfficeHome() {
  const { me } = useAuth()

  const counts = useApi<StageCounts>(["claims", "counts", "home"], "/api/claims/counts")
  const faults = useApi<FaultsSummary>(["admin", "faults"], "/api/admin/faults")
  const requests = useApi<RequestsSummary>(
    ["admin", "profile-requests", "home"],
    "/api/admin/profile-requests?status=PENDING&limit=1"
  )
  const duplicates = useApi<DuplicatesSummary>(
    ["duplicates", "home"],
    "/api/admin/duplicate-findings?kind=SAME_PERSON&status=OPEN&limit=1"
  )
  const dashboard = useApi<Dashboard>(["dashboard"], "/api/dashboard")

  const waiting = counts.data?.counts.filed ?? null
  const sentBack = counts.data?.counts.sent_back ?? null

  return (
    <div className="page space-y-10">
      <header>
        <PageTitle>{greeting(me?.name)}</PageTitle>
        <Sub className="mt-1">What is waiting, what is stuck, and what has moved lately.</Sub>
      </header>

      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
        <Figure
          label="Waiting to be checked"
          value={waiting === null ? "—" : waiting.toLocaleString("en-IN")}
          hint="Filed, not yet cleared"
          loading={counts.isLoading}
          muted={waiting === 0}
        />
        <Figure
          label="Sent back"
          value={sentBack === null ? "—" : sentBack.toLocaleString("en-IN")}
          hint="With the claimant to correct"
          loading={counts.isLoading}
          muted={sentBack === 0}
        />
        <Figure
          label="Paid to date"
          value={money(dashboard.data?.ledger_total ?? dashboard.data?.total_paid)}
          hint={collegeSince(dashboard.data?.ledger_since)}
          loading={dashboard.isLoading}
        />
      </section>

      {faults.isError && (
        <InlineError
          message="Could not check for faults. The queues below are still accurate."
          onRetry={() => faults.refetch()}
        />
      )}

      <Waiting>
        <SectionTitle>Queues</SectionTitle>
        <ul className="divide-y divide-line border-y border-line">
          <QueueRow
            icon={ClipboardCheck}
            label="Papers to check"
            count={waiting}
            detail="Oldest first, cleared to the Principal"
            to="/clearing"
            loading={counts.isLoading}
          />
          <QueueRow
            icon={Users}
            label="Profile corrections"
            count={requests.data?.pending ?? null}
            detail="Names, staff IDs and Scopus links a claimant cannot change themselves"
            to="/requests"
            loading={requests.isLoading}
          />
          <QueueRow
            icon={TriangleAlert}
            label="Faults"
            count={faults.data?.total ?? null}
            detail={
              faults.data?.urgent
                ? `${faults.data.urgent} need attention now`
                : "Records the system cannot reconcile on its own"
            }
            to="/faults"
            tone={faults.data?.urgent ? "critical" : undefined}
            loading={faults.isLoading}
          />
          <QueueRow
            icon={Copy}
            label="Possible duplicate payments"
            count={duplicates.data?.summary.open ?? null}
            detail={
              duplicates.data?.summary.at_issue
                ? `${money(duplicates.data.summary.at_issue)} at issue, unreviewed`
                : "One person paid more than once for the same paper"
            }
            to="/duplicates"
            tone={duplicates.data?.summary.open ? "caution" : undefined}
            loading={duplicates.isLoading}
          />
        </ul>
      </Waiting>

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <SectionTitle>What moved</SectionTitle>
          <Link to="/audit" className="text-sm text-accent underline-offset-4 hover:underline">
            Full audit log
          </Link>
        </div>
        {dashboard.isLoading ? (
          <ul className="divide-y divide-line border-y border-line">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="h-[3.25rem] animate-pulse bg-sunken" />
            ))}
          </ul>
        ) : dashboard.isError ? (
          // "Nothing has changed yet" on a failed request tells the office
          // the queue is quiet when it may be full.
          <ErrorState
            title="Could not load recent activity"
            message="The server did not answer. Nothing has been lost."
            onRetry={() => void dashboard.refetch()}
          />
        ) : (dashboard.data?.recent.length ?? 0) === 0 ? (
          <p className="border-y border-line py-10 text-center text-sm text-fg-muted">
            Nothing has changed yet.
          </p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {dashboard.data?.recent.map((c) => <ClaimRow key={c.id} claim={c} />)}
          </ul>
        )}
      </section>

      {/* The office's work first; an officer's own research after it. */}
      {can(me?.role).fileOwnPapers && <YourPapers />}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The Principal                                                             */
/* ------------------------------------------------------------------------ */

type PrincipalQueue = {
  total: number
  results: Claim[]
  totals: { count: number; amount: number; longest_wait_days: number | null }
}

/**
 * What is waiting on the Principal, what it is worth, and how long the
 * oldest has sat there.
 *
 * The wait figure leads because it is the only one on the page that gets
 * worse by itself. A count of forty is the same forty whether it arrived
 * this morning or in March; "the oldest has waited 62 days" is the sentence
 * that says which.
 */
export function PrincipalHome() {
  const { me } = useAuth()
  const queue = useApi<PrincipalQueue>(["principal", "queue", "home"], "/api/principal/queue?limit=8")
  const dashboard = useApi<Dashboard>(["dashboard"], "/api/dashboard")

  const totals = queue.data?.totals
  const longest = totals?.longest_wait_days ?? null

  return (
    <div className="page space-y-10">
      <header>
        <PageTitle>{greeting(me?.name)}</PageTitle>
        <Sub className="mt-1">
          Everything the research cell has checked and sent up for your approval.
        </Sub>
      </header>

      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
        <Figure
          label="Waiting on you"
          value={totals ? totals.count.toLocaleString("en-IN") : "—"}
          hint="Checked, awaiting your approval"
          loading={queue.isLoading}
          muted={totals?.count === 0}
        />
        <Figure
          label="Worth"
          value={money(totals?.amount)}
          hint="Across everything waiting, not this page"
          loading={queue.isLoading}
        />
        <Figure
          label="Longest wait"
          value={longest === null ? "—" : `${longest} ${longest === 1 ? "day" : "days"}`}
          hint={longest === null ? "Nothing waiting" : "Since it was checked"}
          tone={longest !== null && longest > 30 ? "critical" : undefined}
          loading={queue.isLoading}
        />
      </section>

      {queue.isError ? (
        <InlineError
          message="Could not load the approval queue."
          onRetry={() => queue.refetch()}
        />
      ) : (queue.data?.total ?? 0) === 0 && !queue.isLoading ? (
        <Callout tone="positive" title="Nothing is waiting on you">
          Every checked paper has been approved. The research cell sends the next batch up as
          soon as it clears them.
        </Callout>
      ) : (
        <Waiting>
          <div className="flex items-baseline justify-between gap-3">
            <SectionTitle>Longest waiting</SectionTitle>
            <Link to="/approvals" className="text-sm text-accent underline-offset-4 hover:underline">
              Open the queue{queue.data ? ` (${queue.data.total})` : ""}
            </Link>
          </div>
          {queue.isLoading ? (
            <ul className="divide-y divide-line border-y border-line">
              {Array.from({ length: 5 }).map((_, i) => (
                <li key={i} className="h-[3.25rem] animate-pulse bg-sunken" />
              ))}
            </ul>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {queue.data?.results.map((c) => <ClaimRow key={c.id} claim={c} />)}
            </ul>
          )}
        </Waiting>
      )}

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <SectionTitle>The college</SectionTitle>
          <Link to="/reports" className="text-sm text-accent underline-offset-4 hover:underline">
            Reports
          </Link>
        </div>
        <Figure
          label="Paid to date"
          value={money(dashboard.data?.ledger_total ?? dashboard.data?.total_paid)}
          hint={collegeSince(dashboard.data?.ledger_since)}
          loading={dashboard.isLoading}
        />
      </section>

      <YourPapers />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Finance                                                                   */
/* ------------------------------------------------------------------------ */

type PayoutsPayload = { total: number; results: Claim[] }
export type BudgetSummary = {
  financial_year: string
  college: { allocated: number | null; spent: number; committed: number; remaining: number | null }
}

// The endpoint caps a page at 200. Everything payable is summed from one
// page of that size, and the screen says so when there is more than that
// rather than quietly presenting a partial total as the total.
const PAYABLE_PAGE = 200

/**
 * What Finance can pay right now, what it comes to, and what is held up.
 *
 * "Blocked" is its own figure because a high-value claim needing a second
 * signature looks completely payable in a list — same stage, same amount, a
 * pay button that simply refuses. Counting those separately is the
 * difference between a queue and a queue with three landmines in it.
 */
export function FinanceHome() {
  const { me } = useAuth()

  const payable = useApi<PayoutsPayload>(
    ["payouts", "payable", "home"],
    `/api/admin/payouts?status=DIRECTOR_APPROVED&limit=${PAYABLE_PAGE}`
  )
  const budget = useApi<BudgetSummary>(["budgets", ""], "/api/budgets")
  // What went out this month and last, straight off the ledger (reversals
  // included, so a voided payment is not counted twice).
  const now = new Date()
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
  const thisMonth = ym(now)
  const lastMonth = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1))
  const paidThis = useApi<{ total: number; total_amount: number }>(
    ["ledger", "month", thisMonth],
    `/api/admin/ledger?month=${thisMonth}&limit=1`
  )
  const paidLast = useApi<{ total: number; total_amount: number }>(
    ["ledger", "month", lastMonth],
    `/api/admin/ledger?month=${lastMonth}&limit=1`
  )
  const monthName = (d: Date) => d.toLocaleDateString("en-IN", { month: "long" })

  const rows = payable.data?.results ?? []
  const total = payable.data?.total ?? 0
  const partial = total > rows.length

  const blocked = rows.filter((c) => (c as Claim & { needs_second_approval?: boolean }).needs_second_approval)
  const ready = rows.filter((c) => !(c as Claim & { needs_second_approval?: boolean }).needs_second_approval)
  const readyAmount = ready.reduce((sum, c) => sum + (c.remuneration || 0), 0)

  return (
    <div className="page space-y-10">
      <header>
        <PageTitle>{greeting(me?.name)}</PageTitle>
        <Sub className="mt-1">
          Everything the Director has authorised and Finance has not yet paid.
        </Sub>
      </header>

      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
        <Figure
          label="Payable now"
          value={ready.length.toLocaleString("en-IN")}
          hint={partial ? `of ${total.toLocaleString("en-IN")} approved` : "Approved and unblocked"}
          loading={payable.isLoading}
          muted={ready.length === 0}
        />
        <Figure
          label="Comes to"
          value={money(readyAmount)}
          hint={partial ? `first ${rows.length} of ${total} — open the queue for the rest` : undefined}
          loading={payable.isLoading}
        />
        <Figure
          label="Blocked"
          value={blocked.length.toLocaleString("en-IN")}
          hint={
            blocked.length
              ? "High value — needs a second signature from the office"
              : "Nothing is held up"
          }
          tone={blocked.length ? "caution" : undefined}
          loading={payable.isLoading}
          muted={blocked.length === 0}
        />
      </section>

      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
        <Figure
          label={`Paid in ${monthName(now)}`}
          value={money(paidThis.data?.total_amount)}
          hint={paidThis.data ? `${paidThis.data.total} ledger row${paidThis.data.total === 1 ? "" : "s"}` : undefined}
          loading={paidThis.isLoading}
        />
        <Figure
          label={`Paid in ${monthName(new Date(now.getFullYear(), now.getMonth() - 1, 1))}`}
          value={money(paidLast.data?.total_amount)}
          hint={paidLast.data ? `${paidLast.data.total} ledger row${paidLast.data.total === 1 ? "" : "s"}` : undefined}
          loading={paidLast.isLoading}
        />
      </section>

      {partial && (
        <Callout tone="info" title={`Showing the first ${rows.length} of ${total}`}>
          The server returns at most {PAYABLE_PAGE} rows at a time, so the figures above cover
          those rows rather than the whole approved queue. Payments pages through all of
          them.
        </Callout>
      )}

      {blocked.length > 0 && (
        <Callout tone="caution" title={`${blocked.length} approved but not payable`}>
          These are over the high-value threshold and need a second, different signature before
          Finance can move them. The research cell or a super admin gives it — the Principal
          cannot, and paying one is refused by the server rather than allowed and reversed later.
        </Callout>
      )}

      {payable.isError ? (
        <InlineError message="Could not load the payable queue." onRetry={() => payable.refetch()} />
      ) : (
        <Waiting>
          <div className="flex items-baseline justify-between gap-3">
            <SectionTitle>Next to pay</SectionTitle>
            <Link to="/payments" className="text-sm text-accent underline-offset-4 hover:underline">
              Payments{total ? ` (${total})` : ""}
            </Link>
          </div>
          {payable.isLoading ? (
            <ul className="divide-y divide-line border-y border-line">
              {Array.from({ length: 5 }).map((_, i) => (
                <li key={i} className="h-[3.25rem] animate-pulse bg-sunken" />
              ))}
            </ul>
          ) : ready.length === 0 ? (
            <p className="border-y border-line py-10 text-center text-sm text-fg-muted">
              Nothing is payable. A paper appears here the moment the Director authorises
              it.
            </p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {ready.slice(0, 8).map((c) => <ClaimRow key={c.id} claim={c} />)}
            </ul>
          )}
        </Waiting>
      )}

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <SectionTitle>
            The budget{budget.data ? ` — FY ${budget.data.financial_year}` : ""}
          </SectionTitle>
          <Link to="/budget" className="text-sm text-accent underline-offset-4 hover:underline">
            Budget
          </Link>
        </div>
        {budget.isError ? (
          // Every figure below falls back to "Not set" or an em dash, so a
          // failed request read as "this college has allocated no budget" to
          // the one person whose job depends on knowing otherwise.
          <ErrorState
            title="Could not load the budget"
            message="The server did not answer. Any allocation already made is still there."
            onRetry={() => void budget.refetch()}
          />
        ) : (
        <div className="grid gap-x-10 gap-y-6 sm:grid-cols-4">
          <Figure
            label="Allocated"
            value={
              budget.data?.college.allocated == null
                ? "Not set"
                : money(budget.data.college.allocated)
            }
            muted={budget.data?.college.allocated == null}
            loading={budget.isLoading}
          />
          <Figure label="Paid out" value={money(budget.data?.college.spent)} loading={budget.isLoading} />
          <Figure
            label="Committed"
            value={money(budget.data?.college.committed)}
            hint="Approved, not yet paid"
            loading={budget.isLoading}
          />
          <Figure
            label="Left"
            value={
              budget.data?.college.remaining == null
                ? "—"
                : money(Math.abs(budget.data.college.remaining))
            }
            tone={
              budget.data?.college.remaining == null
                ? undefined
                : budget.data.college.remaining < 0
                  ? "critical"
                  : "positive"
            }
            hint={
              budget.data && budget.data.college.remaining !== null && budget.data.college.remaining < 0
                ? "Over the allocation"
                : undefined
            }
            loading={budget.isLoading}
          />
        </div>
        )}
      </section>

      <YourPapers />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Head of department                                                        */
/* ------------------------------------------------------------------------ */

type HodStanding = {
  mine: { q1_rate: number | null }
  college: { publications: number; q1_rate: number | null }
  share: number | null
  position: number | null
  of: number
}

type HodTargets = {
  year: number
  department_targets: {
    id: string
    metric_label: string
    target: number
    done: number
    fraction: number | null
    met: boolean
  }[]
}

type HodOverview = {
  department: string
  totals: {
    publications: number
    faculty_in_department: number
    faculty_who_published: number
    q1: number
    first_author: number
    under_review: number
  }
  people: {
    id: string
    name: string
    designation: string | null
    publications: number
    first_author: number
    q1: number
    active: boolean
  }[]
}

/**
 * The viewer's own papers, on a home whose first job is something else: a
 * head of department's, who is faculty that also heads the department
 * (2026-09-23), and an officer's -- the research cell, the coordinator, the
 * Principal, the Director, Finance -- who is an academic too and "must be
 * able to do both".
 *
 * The same pieces a faculty member's home is built from, so the two cannot
 * drift: their own money, anything sent back to them, and every paper still
 * moving drawn as the claimant's journey — never which desk holds it, even
 * for somebody who sits at one. `/api/claims?mine=1` is theirs alone, and the
 * amounts on it are theirs (`hod.for_head`, `core.visibility`).
 */
export function YourPapers({
  note = "What you have filed yourself. Another officer, or the super admin, decides each one — never you.",
}: {
  note?: string
}) {
  const own = useOwnPapers()
  const { claims, isLoading, isError, refetch } = own

  return (
    <section aria-label="Your papers" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionTitle>Your papers</SectionTitle>
          <Meta className="block">{note}</Meta>
        </div>
        <Button kind="default" asChild>
          <Link to="/papers/new">
            <Plus />
            File a paper
          </Link>
        </Button>
      </div>

      {isError ? (
        // A dropped request is not an empty record: no ₹0 in its place.
        <InlineError
          message="Could not load your papers. Nothing has been lost."
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <MoneySkeleton />
      ) : claims.length === 0 ? (
        <p className="text-base text-fg-muted">
          Nothing filed yet. File a paper and follow it here, as any claimant does.
        </p>
      ) : (
        <>
          <MoneyStrip own={own} />
          <NeedsYou sentBack={own.sentBack} drafts={own.drafts} />
          <OnTheWay moving={own.moving} />
          <PaidList payments={own.payments} />
        </>
      )}
    </section>
  )
}

/**
 * A head's department, and — the part no other screen answers — who in it has
 * published nothing.
 *
 * There is not a rupee on this page, and there is none in the endpoint behind
 * it either: `/api/hod/overview` strips every money key server-side before it
 * is serialised. That is the rule this role exists under, and it is enforced
 * there rather than here so that no amount of front-end carelessness can
 * leak one.
 */
export function HodHome() {
  const { me } = useAuth()
  const overview = useApi<HodOverview>(["hod", "overview"], "/api/hod/overview")
  const standing = useApi<HodStanding>(["hod", "standing", ""], "/api/hod/standing")
  const targets = useApi<HodTargets>(["hod", "targets", ""], "/api/hod/targets")

  const totals = overview.data?.totals
  const people = overview.data?.people ?? []
  const silent = people.filter((p) => p.active && p.publications === 0)
  const published = [...people]
    .filter((p) => p.publications > 0)
    .sort((a, b) => b.publications - a.publications)

  return (
    <div className="page space-y-10">
      <header>
        <PageTitle>{greeting(me?.name)}</PageTitle>
        <Sub className="mt-1">
          {overview.data?.department
            ? `${overview.data.department} — what the department has published, and by whom.`
            : "What the department has published, and by whom."}
        </Sub>
      </header>

      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Publications"
          value={totals ? totals.publications.toLocaleString("en-IN") : "—"}
          loading={overview.isLoading}
        />
        <Figure
          label="Q1 papers"
          value={totals ? totals.q1.toLocaleString("en-IN") : "—"}
          hint="Top-quartile journals"
          loading={overview.isLoading}
        />
        <Figure
          label="First author"
          value={totals ? totals.first_author.toLocaleString("en-IN") : "—"}
          hint="Papers led from this department"
          loading={overview.isLoading}
        />
        <Figure
          label="Under review"
          value={totals ? totals.under_review.toLocaleString("en-IN") : "—"}
          hint="Filed, not yet settled"
          loading={overview.isLoading}
        />
      </section>

      {overview.isError && (
        <InlineError
          message={
            overview.error?.status === 403
              ? "This account is not registered as the head of a department."
              : "Could not load the department overview."
          }
          onRetry={overview.error?.status === 403 ? undefined : () => overview.refetch()}
        />
      )}

      <YourPapers note="What you have filed yourself, with your own amounts. Your department's figures carry none." />

      {totals && (
        <section className="space-y-2">
          <SectionTitle>Who has published</SectionTitle>
          <p className="text-base text-fg-muted">
            {totals.faculty_who_published} of {totals.faculty_in_department} in the department.
          </p>

          {published.length > 0 && (
            <ul className="divide-y divide-line border-y border-line">
              {published.slice(0, 10).map((p) => (
                <li key={p.id} className="row">
                  <Link
                    to={`/people/${p.id}`}
                    className="flex items-center gap-4 px-1 py-2.5 sm:px-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base">{p.name}</span>
                      <Meta className="block truncate">{p.designation || "Faculty"}</Meta>
                    </span>
                    <span className="w-16 shrink-0 text-right text-sm tabular text-fg-muted">
                      {p.q1 ? `${p.q1} Q1` : ""}
                    </span>
                    <span className="w-20 shrink-0 text-right text-base tabular">
                      {p.publications}
                    </span>
                    <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {silent.length > 0 && (
        <section className="space-y-2">
          <SectionTitle>Nothing on record</SectionTitle>
          {/* The only screen in the app that answers this. It is a
              department's own business who has not published, and a list of
              names with no context beside them is an accusation — so the
              sentence above it says plainly what the list does and does not
              mean. */}
          <p className="max-w-2xl text-base text-fg-muted">
            {silent.length} {silent.length === 1 ? "member has" : "members have"} nothing filed
            under the scheme. That is not the same as having published nothing — a paper nobody
            filed a claim for does not appear anywhere in this system.
          </p>
          <SilentList people={silent} />
        </section>
      )}

      {/* Where the department sits, which is the one thing a head cannot work
          out from their own numbers alone. */}
      {standing.data && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <SectionTitle>Against the college</SectionTitle>
            <Link
              to="/department"
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              Standing, targets and where the lift is
            </Link>
          </div>
          <div className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
            <Figure
              label="Position"
              value={
                standing.data.position
                  ? `${standing.data.position} of ${standing.data.of}`
                  : "—"
              }
              hint="By number of publications"
            />
            <Figure
              label="Share of the college"
              value={
                standing.data.share == null
                  ? "—"
                  : `${Math.round(standing.data.share * 100)}%`
              }
              hint={`of ${standing.data.college.publications.toLocaleString("en-IN")} publications`}
            />
            <Figure
              label="Q1 rate"
              value={
                standing.data.mine.q1_rate == null
                  ? "—"
                  : `${Math.round(standing.data.mine.q1_rate * 1000) / 10}%`
              }
              hint={
                standing.data.college.q1_rate == null
                  ? undefined
                  : `college ${Math.round(standing.data.college.q1_rate * 1000) / 10}%`
              }
              tone={
                standing.data.mine.q1_rate != null &&
                standing.data.college.q1_rate != null &&
                standing.data.mine.q1_rate < standing.data.college.q1_rate
                  ? "caution"
                  : "positive"
              }
            />
          </div>
        </section>
      )}

      {(targets.data?.department_targets.length ?? 0) > 0 && (
        <section className="space-y-2">
          <SectionTitle>Targets for {targets.data?.year}</SectionTitle>
          <ul className="divide-y divide-line border-y border-line">
            {targets.data?.department_targets.map((t) => (
              <li key={t.id} className="space-y-1.5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-base">{t.metric_label}</span>
                  <span
                    className={cn(
                      "text-base font-medium tabular",
                      t.met ? "text-positive" : "text-fg"
                    )}
                  >
                    {t.done} / {t.target}
                  </span>
                </div>
                <span className="block h-1.5 w-full overflow-hidden rounded-full bg-sunken">
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      t.met ? "bg-positive" : "bg-accent"
                    )}
                    style={{ width: `${Math.min(1, t.fraction ?? 0) * 100}%` }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <SectionTitle>Look further</SectionTitle>
        <ul className="divide-y divide-line border-y border-line">
          <QueueRow
            icon={Building2}
            label="My department"
            count={null}
            detail="Standing against the college, targets, and where the lift is"
            to="/department"
          />
          <QueueRow
            icon={FileCheck}
            label="Department publications"
            count={totals?.publications ?? null}
            detail="Every paper on record, filterable and downloadable"
            to="/publications"
            loading={overview.isLoading}
          />
          <QueueRow
            icon={BarChart3}
            label="Reports"
            count={null}
            detail="Output by year, quartile and journal"
            to="/reports"
          />
        </ul>
      </section>
    </div>
  )
}

/**
 * Members with nothing filed, as a compact grid: a department of seventy
 * would otherwise push everything after it off the bottom of the page. The
 * first twelve are shown; the rest are one press away.
 */
function SilentList({ people }: { people: { id: string; name: string; designation?: string | null }[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? people : people.slice(0, 12)
  return (
    <div className="space-y-2">
      <ul className="grid gap-x-6 border-y border-line sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((p) => (
          <li key={p.id} className="row min-w-0 border-b border-line last:border-b-0">
            <Link to={`/people/${p.id}`} className="flex items-center gap-3 px-1 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{p.name}</span>
                <Meta className="block truncate">{p.designation || "Faculty"}</Meta>
              </span>
              <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      {people.length > 12 && (
        <Button kind="quiet" size="sm" onClick={() => setAll((v: boolean) => !v)}>
          {all ? "Show fewer" : `Show all ${people.length}`}
        </Button>
      )}
    </div>
  )
}
