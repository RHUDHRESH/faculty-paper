import { useMemo } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Download, Minus, X } from "lucide-react"

import { useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { RankedBars, MixBar, Trend, Distribution, isComparable, type Point } from "@/ui/chart"
import { money, Stage, stageOf } from "@/ui/paper"
import {
  Callout,
  EmptyState,
  ErrorState,
  InlineError,
  Skeleton,
  SkeletonRows,
} from "@/ui/state"
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/ui/sheet"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * The college's oversight report — a small set of large figures, with the
 * rows behind each one a click away.
 *
 * A head of department is refused `/api/reports` outright (403, verified by
 * the server, not by this file), so this component is really two screens
 * sharing one shell: `CollegeReports` for the roles that may see money, and
 * `HodReports` for a head, who never calls `/api/reports` at all — it calls
 * `/api/hod/overview` and `/api/hod/publications`, neither of which carries
 * an amount. Nothing here decides who sees money by hiding a column; the two
 * branches ask two different servers for two different answers.
 *
 * Drill-down is in place, not a link to a separate query screen. Every chart
 * in `@/ui/chart` already knows how to render a point as a link (`to`), and
 * the natural use of that is a link to the thing's own page — which is
 * exactly what a person's bar gets here, since `/people/{id}` already exists.
 * But a department, a quartile or a pipeline stage has no page of its own,
 * and linking it to `/reports/search?department=CSE` would be the "go
 * somewhere else and retype the filter" the brief calls out. So those bars'
 * `to` points at *this* route with a `sheet` query parameter describing what
 * was clicked; this component reads that parameter and opens `Sheet` (from
 * `@/ui/chart`'s sibling `@/ui/sheet`, built for exactly this — "the page
 * underneath never left, never re-fetched, never re-mounted"). Closing it
 * removes the parameter rather than navigating back, so the filters, the
 * scroll position and the rest of the report are exactly as they were.
 *
 * Three questions are asked of this report in every review meeting, and until
 * now each of them had to be worked out from an export: is anything stuck, is
 * the output broad or carried by a few people, and is a department going up or
 * down. `StuckPanel`, `ConcentrationPanel` and `DirectionPanel` below are
 * those three. The last one is the dangerous one and is described at length
 * where it is defined — a year-on-year figure computed off this record without
 * a guard reports the reach of the ERP import as a change in output.
 */

export function Reports() {
  const { me } = useAuth()
  return me?.role === "HOD" ? <HodReports /> : <CollegeReports />
}

/* ------------------------------------------------------------------------ */
/* Shared: the drill-down descriptor and the URL it lives in                */
/* ------------------------------------------------------------------------ */

type Drill = {
  label: string
  caption?: string
  filters: Record<string, string>
  /** Only for a figure whose true total spans more than one raw status that
   *  `/api/reports/search` cannot OR together in a single request — "awaiting
   *  payment" is CLEARED, PRINCIPAL_APPROVED and the two legacy aliases for
   *  each. Fetched as one request per status and merged client-side. */
  statuses?: string[]
}

function readDrill(searchParams: URLSearchParams): Drill | null {
  const raw = searchParams.get("sheet")
  if (!raw) return null
  try {
    return JSON.parse(raw) as Drill
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------ */
/* College reports — every role that may see money                         */
/* ------------------------------------------------------------------------ */

type ReportTotals = {
  publications: number
  count_only: number
  paid_claims: number
  paid_amount: number
  awaiting_payment: number
  committed_amount: number
}

type Capped<T> = { rows: T[]; hidden: number; hidden_count: number; hidden_amount: number }
type PersonPoint = Point & { id: string }
type PipelinePoint = Point & { blurb: string; median_age_days: number; oldest_age_days: number }

/** One publication year: how many papers, how many people wrote them, and how
 *  much of the year's output the ten most prolific accounted for. */
type BreadthRow = {
  key: string
  count: number
  people: number
  per_person: number
  top_ten_share: number
}

type YoyRow = {
  key: string
  count: number
  previous: number
  change: number
  /** Null when the department published nothing in the earlier year, because
   *  the percentage would be a division by zero. */
  percent: number | null
}

/** `_year_on_year_rows` answers with a bare `[]` when the record holds fewer
 *  than two publication years, so this is a union rather than an object with
 *  empty rows — reading `.rows` off the array is `undefined`, not a crash, and
 *  a screen that relies on that is one refactor from a blank panel. */
type YearOnYear = {
  this_year: number
  last_year: number
  this_year_is_partial: boolean
  months_elapsed: number
  rows: YoyRow[]
}

type ReportsPayload = {
  totals: ReportTotals
  by_department: Point[]
  by_quartile: Point[]
  by_month: Point[]
  by_journal: Capped<Point>
  top_by_publications: Capped<PersonPoint>
  top_by_amount: Capped<PersonPoint>
  per_paper: { count: number; mean: number; median: number; min: number; max: number }
  pipeline: PipelinePoint[]
  ageing: { rows: Point[]; oldest_days: number | null; total: number }
  breadth: BreadthRow[]
  year_on_year: YearOnYear | []
  years: number[]
  payout_months: string[]
}

/** The measured half of `/api/trends/me`, narrowed to the part this screen
 *  reads. The full shape lives in `programme.tsx`, which asks for the same
 *  thing under the same query key so the two share one cached response. */
type TrendsOverview = {
  college: {
    window: {
      latest_year: number
      recent_from: number
      recent_to: number
      prior_from: number
      prior_to: number
    }
    totals: {
      papers: number
      papers_prior: number
      /** Whether the earlier window holds enough papers to be compared
       *  against at all. False on this college's record. */
      comparable: boolean
      not_comparable_why: string | null
    }
  }
}


type SearchClaim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name: string
  owner_department: string | null
  publication_year: number | null
  status: string
  remuneration: number | null
  remuneration_is_estimate: boolean
  calc_error: string | null
  updated_at: string | null
  /** Whole days this ticket has sat at the desk it is at now — `_waiting_days`
   *  in `backend/core/api.py`. Measured from when it arrived at the step, not
   *  from `updated_at`, which moves for any edit and would reset the clock
   *  every time somebody opened the ticket to look at it. Null on anything
   *  that is not standing at one of the four desks. */
  waiting_days: number | null
}

type SearchPayload = {
  total: number
  total_amount: number
  results: SearchClaim[]
}

/**
 * `/api/reports/areas` — what the college researches, which nothing else on
 * this screen answers.
 *
 * Two facts have to travel with these rows or they mislead. A paper belongs
 * to every subject area its journal is classified under, so the counts
 * overlap and the amounts behind them cannot be added; and subjects are only
 * known for a paper whose journal Scimago matched, so `coverage` is the
 * denominator without which the bars read as "this is what we do" when they
 * mean "this is what we do, among the papers we can classify".
 */
type AreasPayload = {
  areas: { key: string; count: number; amount: number; quartiles: Record<string, number> }[]
  distinct: number
  shown: number
  coverage: { classified: number; total: number; unclassified: number; fraction: number }
}

/* ------------------------------------------------------------------------ */
/* Is anything stuck?                                                       */
/* ------------------------------------------------------------------------ */

/**
 * The four desks a ticket can be standing at, and who is standing behind it.
 *
 * These are exactly the four statuses `_waiting_days` knows how to time, and
 * the wording matches `stageOf` in `@/ui/paper` — a claimant told their paper
 * is "with Finance" while it is actually waiting for the Director goes and
 * chases a desk that cannot yet see their ticket, and a report that says it
 * differently from the ticket sends the chaser to the same wrong place.
 */
const DESKS = [
  { status: "SUBMITTED", desk: "The research cell" },
  { status: "CLEARED", desk: "The Principal" },
  { status: "PRINCIPAL_APPROVED", desk: "The Director" },
  { status: "DIRECTOR_APPROVED", desk: "Finance" },
] as const

type StuckClaim = SearchClaim & { desk: string }

/**
 * Every ticket standing at a desk, oldest first.
 *
 * One request per desk, because `/api/reports/search` takes a single status
 * and there is no "still open" filter — the same fan-out `fetchCollegeDrill`
 * does, for the same reason. It is affordable: everything still in the chain
 * is 89 rows on this record and has never been more than a few hundred, and
 * 200 per desk fetches all of it. The cap is still checked and reported
 * rather than assumed, because "the oldest ticket" quietly meaning "the oldest
 * of the first 200 we happened to receive" is the sort of wrong answer nobody
 * would ever catch.
 *
 * Sorting is done here rather than by the server on purpose: `waiting_days` is
 * computed per row from four different timestamps and is not a column, so no
 * `sort=` the endpoint offers can order by it.
 */
async function fetchStuck(scope: Record<string, string>): Promise<{
  rows: StuckClaim[]
  capped: boolean
}> {
  const pages = await Promise.all(
    DESKS.map(async ({ status, desk }) => {
      const qs = new URLSearchParams(scope)
      qs.set("status", status)
      qs.set("limit", "200")
      const page = await api<SearchPayload>(`/api/reports/search?${qs.toString()}`)
      return { desk, page }
    })
  )
  const rows = pages.flatMap(({ desk, page }) =>
    page.results.filter((c) => c.waiting_days != null).map((c) => ({ ...c, desk }))
  )
  rows.sort((a, b) => (b.waiting_days ?? 0) - (a.waiting_days ?? 0))
  return { rows, capped: pages.some(({ page }) => page.results.length < page.total) }
}

/** One request per status, merged — see the `statuses` field on `Drill`. */
async function fetchCollegeDrill(d: Drill): Promise<SearchPayload> {
  const statuses = d.statuses && d.statuses.length > 1 ? d.statuses : [d.filters.status ?? ""]
  const pages = await Promise.all(
    statuses.map((status) => {
      const qs = new URLSearchParams(d.filters)
      qs.delete("status")
      if (status) qs.set("status", status)
      qs.set("limit", "200")
      return api<SearchPayload>(`/api/reports/search?${qs.toString()}`)
    })
  )
  const results = pages
    .flatMap((p) => p.results)
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
  return {
    total: pages.reduce((n, p) => n + p.total, 0),
    total_amount: pages.reduce((n, p) => n + p.total_amount, 0),
    results,
  }
}

/** What the college's oversight roles (Research cell, Principal, Finance,
 *  Super admin) see: three headline figures, then how they break down, with
 *  every breakdown a click away from the claims behind it. */
function CollegeReports() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()

  const year = searchParams.get("year") ?? ""
  const department = searchParams.get("department") ?? ""
  const month = searchParams.get("month") ?? ""
  const drill = useMemo(() => readDrill(searchParams), [searchParams])

  const scope = useMemo(() => {
    const s: Record<string, string> = {}
    if (year) s.year = year
    if (department) s.department = department
    if (month) s.month = month
    return s
  }, [year, department, month])

  function setFilter(key: "year" | "department" | "month", value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      next.delete("sheet")
      return next
    })
  }

  function openDrill(d: Drill) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("sheet", JSON.stringify(d))
      return next
    })
  }

  function closeDrill() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete("sheet")
      return next
    })
  }

  function clearFilters() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const key of ["year", "department", "month", "sheet"]) next.delete(key)
      return next
    })
  }

  /** A link that stays on this page — see the file docstring for why this
   *  reads better than routing a bar to a separate query screen. */
  function drillHref(d: Drill): string {
    const next = new URLSearchParams(searchParams)
    next.set("sheet", JSON.stringify(d))
    return `${location.pathname}?${next.toString()}`
  }

  const reportQuery = new URLSearchParams(scope)
  const { data, isLoading, isError, error, refetch } = useApi<ReportsPayload>(
    ["reports", year, department, month],
    `/api/reports?${reportQuery.toString()}`,
    { placeholderData: (prev) => prev }
  )

  const departmentsQuery = useApi<string[]>(["meta", "departments"], "/api/meta/departments")
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "All departments" },
    ...(departmentsQuery.data || []).map((d) => ({ value: d, label: d })),
  ]
  const yearOptions: ComboboxOption[] = [
    { value: "", label: "All years" },
    ...(data?.years || []).map((y) => ({ value: String(y), label: String(y) })),
  ]
  const monthOptions: ComboboxOption[] = [
    { value: "", label: "Every settled month" },
    ...(data?.payout_months || []).map((m) => ({ value: m, label: m })),
  ]

  // Subject areas are the one dimension this screen never showed, and the one
  // a director actually sets priorities from. Its own query, its own failure:
  // if it does not answer, the rest of the report is still a report.
  const areaParams = new URLSearchParams()
  if (year) areaParams.set("year", year)
  if (department) areaParams.set("department", department)
  areaParams.set("limit", "24")
  const areas = useApi<AreasPayload>(
    ["reports", "areas", year, department],
    `/api/reports/areas?${areaParams.toString()}`,
    { placeholderData: (prev) => prev }
  )

  // Deliberately not given `month`. That filter narrows to the month a claim
  // was *settled*, and nothing still waiting has been settled in any month, so
  // passing it would empty this panel the moment a reader picked one — which
  // reads as "nothing is stuck" rather than as "this filter does not apply".
  const stuckScope = useMemo(() => {
    const s: Record<string, string> = {}
    if (year) s.year = year
    if (department) s.department = department
    return s
  }, [year, department])

  const stuck = useQuery({
    queryKey: ["reports", "stuck", year, department],
    queryFn: () => fetchStuck(stuckScope),
  })

  // Same key and same staleTime as `programme.tsx`, so the two screens share
  // one cached answer rather than each paying for the model-health probe that
  // rides along with it.
  const trends = useApi<TrendsOverview>(["trends", "me"], "/api/trends/me", {
    staleTime: 10 * 60_000,
  })

  const drillKey = searchParams.get("sheet") ?? ""
  const drillQuery = useQuery({
    queryKey: ["reports-drill", drillKey],
    queryFn: () => fetchCollegeDrill(drill as Drill),
    enabled: !!drill,
  })

  /** The file is the same scope as the screen. An export that quietly ignores
   *  the filters is how a wrong figure reaches a review meeting. */
  function exportHref(fmt: string): string {
    const params = new URLSearchParams(scope)
    params.set("fmt", fmt)
    return `/api/reports/export?${params.toString()}`
  }

  const filtered = Boolean(year) || Boolean(department) || Boolean(month)
  const coverage = areas.data?.coverage
  // `_year_on_year_rows` answers with a bare list when the record holds fewer
  // than two publication years, so the array case is the "cannot compare" case.
  const yoy =
    data && !Array.isArray(data.year_on_year) ? data.year_on_year : null

  return (
    <div className="page space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Reports</PageTitle>
          <Sub className="mt-1">What the scheme has paid, what it has produced, and what is still open.</Sub>
        </div>
        {/* Secondary, and plural: the report is on the page. These are for
            taking a copy of it somewhere the page cannot go. */}
        <div className="min-w-0">
          <ColumnLabel className="mb-1 block">Also download as</ColumnLabel>
          <div className="flex flex-wrap gap-1">
            <Button kind="quiet" size="sm" asChild>
              <a href={exportHref("xlsx")} download>
                <Download />
                Excel
              </a>
            </Button>
            <Button kind="quiet" size="sm" asChild>
              <a href={exportHref("csv")} download>
                CSV
              </a>
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Combobox
          value={year}
          onChange={(v) => setFilter("year", v)}
          options={yearOptions}
          placeholder="All years"
          aria-label="Filter by publication year"
          className="w-32"
        />
        <Combobox
          value={department}
          onChange={(v) => setFilter("department", v)}
          options={departmentOptions}
          placeholder={departmentsQuery.isLoading ? "Loading…" : "All departments"}
          disabled={departmentsQuery.isLoading}
          aria-label="Filter by department"
          className="w-56"
        />
        <Combobox
          value={month}
          onChange={(v) => setFilter("month", v)}
          options={monthOptions}
          placeholder="Every settled month"
          aria-label="Filter by payout month"
          className="w-48"
        />
      </div>

      {/* What is currently narrowing every figure below, and the way out of
          each one. A filter you can only undo by finding the control you set
          it with is a filter people forget is on. */}
      <div className="flex flex-wrap items-center gap-2">
        <Meta className="tabular">
          {data
            ? `${data.totals.publications.toLocaleString("en-IN")} publication${
                data.totals.publications === 1 ? "" : "s"
              } ${filtered ? "match" : "on record"}`
            : isError
              ? "Count unavailable"
              : "Counting…"}
        </Meta>
        {year && <RemoveChip label={`Year ${year}`} onRemove={() => setFilter("year", "")} />}
        {department && (
          <RemoveChip label={department} onRemove={() => setFilter("department", "")} />
        )}
        {month && (
          <RemoveChip label={`Settled ${month}`} onRemove={() => setFilter("month", "")} />
        )}
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clearFilters}>
            Clear all
          </Button>
        )}
      </div>

      {isLoading && !data ? (
        <ReportsSkeleton />
      ) : isError ? (
        <ErrorState
          title={error?.status === 403 ? "Not visible to this account" : "Could not load the report"}
          message={
            error?.status === 403
              ? "This report is only open to the research cell, the Principal, Finance and system admins."
              : "The server did not answer. Nothing has been lost."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : !data || data.totals.publications === 0 ? (
        <EmptyState
          title={filtered ? "Nothing matches these filters" : "Nothing recorded yet"}
          message={
            filtered
              ? "No publication falls under this year, department and month. Try widening one of them."
              : "Figures appear here once a paper has been filed and moved past draft."
          }
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={clearFilters}>
                Clear the filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
            <Headline
              label="Papers"
              value={data.totals.publications.toLocaleString("en-IN")}
              hint={
                data.totals.count_only
                  ? `${data.totals.count_only.toLocaleString("en-IN")} counted without a payment`
                  : undefined
              }
              onOpen={() => openDrill({ label: "All papers", filters: scope })}
            />
            <Headline
              label="Paid"
              value={money(data.totals.paid_amount)}
              hint={
                data.totals.paid_claims
                  ? `${data.totals.paid_claims.toLocaleString("en-IN")} claims · typically ${money(data.per_paper.median)} each`
                  : "Nothing paid yet"
              }
              onOpen={() =>
                openDrill({
                  label: "Paid claims",
                  filters: { ...scope, status: "PAID" },
                })
              }
            />
            <Headline
              label="Awaiting payment"
              value={money(data.totals.committed_amount)}
              hint={
                data.totals.awaiting_payment
                  ? `${data.totals.awaiting_payment.toLocaleString("en-IN")} claims cleared or approved, not yet paid`
                  : "Nothing waiting"
              }
              onOpen={() =>
                openDrill({
                  label: "Awaiting payment",
                  filters: scope,
                  statuses: [
                    "CLEARED",
                    "PRINCIPAL_APPROVED",
                    "DIRECTOR_APPROVED",
                    "RESEARCH_APPROVED",
                    "FINANCE_APPROVED",
                  ],
                })
              }
            />
          </section>

          <Trend
            title="Paid by month"
            dimension="Month"
            unit="money"
            points={data.by_month.map((p) => ({
              ...p,
              to: drillHref({ label: `Paid in ${p.key}`, filters: { ...scope, status: "PAID", month: p.key } }),
            }))}
          />

          <section className="space-y-10">
            <SectionTitle>Where it comes from</SectionTitle>
            <RankedBars
              title="By department"
              dimension="Department"
              points={data.by_department.map((p) => ({
                ...p,
                to: drillHref({ label: p.label ?? p.key, filters: { ...scope, department: p.key } }),
              }))}
            />
            <RankedBars
              title="Top journals"
              dimension="Journal"
              caption={
                data.by_journal.hidden > 0
                  ? `${data.by_journal.hidden} more journals not shown here — ${data.by_journal.hidden_count.toLocaleString("en-IN")} further papers, ${money(data.by_journal.hidden_amount)}. Narrow a filter above, or export, to see them.`
                  : undefined
              }
              points={data.by_journal.rows.map((p) => ({
                ...p,
                to: drillHref({ label: p.label ?? p.key, filters: { ...scope, journal: p.key } }),
              }))}
            />
          </section>

          <section className="space-y-10">
            <SectionTitle>Which way it is going</SectionTitle>
            <DirectionPanel
              yoy={yoy}
              trends={trends.data}
              trendsLoading={trends.isLoading}
              drillHref={drillHref}
              scope={scope}
            />
            {trends.isError && (
              <InlineError
                message="Could not read the three-year comparison. The year-on-year rows above are unaffected."
                onRetry={() => trends.refetch()}
              />
            )}
          </section>

          <MixBar
            title="Quartile mix"
            dimension="Quartile"
            points={data.by_quartile.map((p) => ({
              ...p,
              to: drillHref({ label: p.label ?? p.key, filters: { ...scope, quartile: p.key } }),
            }))}
          />

          {/* Subject areas overlap, so this section can show counts and only
              counts. Every sentence around it exists to stop a reader adding
              up a column that does not add up. */}
          <section className="space-y-4">
            <SectionTitle>What we research</SectionTitle>
            {areas.isError ? (
              <InlineError
                message="Could not load the subject areas. Every other figure on this page is unaffected."
                onRetry={() => areas.refetch()}
              />
            ) : areas.isLoading && !areas.data ? (
              <SkeletonRows rows={6} rowHeight={32} />
            ) : areas.data && areas.data.areas.length > 0 ? (
              <>
                <Callout tone="caution" title="Counts only — a paper can be in several areas">
                  A paper is counted under every subject area its journal is classified in, so
                  these rows add up to more than the{" "}
                  {data.totals.publications.toLocaleString("en-IN")} publications above, and the
                  money behind them cannot be added at all — the same rupee would be counted
                  once per area. That is why there is no amount here.
                  {coverage && coverage.total > 0 && (
                    <>
                      {" "}
                      Areas are known only for the{" "}
                      {coverage.classified.toLocaleString("en-IN")} of{" "}
                      {coverage.total.toLocaleString("en-IN")} publications (
                      {Math.round(coverage.fraction * 100)}%) whose journal we could match; the
                      other {coverage.unclassified.toLocaleString("en-IN")} are missing from
                      every bar rather than spread across them.
                    </>
                  )}
                </Callout>
                <RankedBars
                  title="Subject areas"
                  dimension="Subject area"
                  limit={12}
                  showAmounts={false}
                  caption={
                    areas.data.distinct > areas.data.shown
                      ? `${(areas.data.distinct - areas.data.shown).toLocaleString("en-IN")} smaller areas are not listed. No single query can filter by area, so these bars do not open a list.`
                      : "No single query can filter by area, so these bars do not open a list."
                  }
                  points={areas.data.areas.map((a) => ({ key: a.key, count: a.count }))}
                />
              </>
            ) : (
              <EmptyState
                title="No subject area is known yet"
                message="Areas come from the journal. None of the publications in scope sits in a journal we could match to a subject classification."
              />
            )}
          </section>

          <section className="space-y-10">
            <SectionTitle>Who is publishing</SectionTitle>
            {/* A row here is a person, and a person already has a page of
                their own — `to` points straight at it rather than at a sheet,
                which is the one place on this screen a bar's `to` means an
                ordinary navigation. */}
            <RankedBars
              title="Most published"
              dimension="Person"
              caption={
                data.top_by_publications.hidden > 0
                  ? `${data.top_by_publications.hidden} more people not shown here.`
                  : undefined
              }
              points={data.top_by_publications.rows.map((p) => ({
                key: p.id,
                label: p.label ?? p.key,
                count: p.count,
                amount: p.amount,
                to: `/people/${p.id}`,
              }))}
            />
            <RankedBars
              title="Highest paid"
              dimension="Person"
              unit="money"
              caption={
                data.top_by_amount.hidden > 0
                  ? `${data.top_by_amount.hidden} more people not shown here.`
                  : undefined
              }
              points={data.top_by_amount.rows.map((p) => ({
                key: p.id,
                label: p.label ?? p.key,
                count: p.count,
                amount: p.amount,
                to: `/people/${p.id}`,
              }))}
            />
            <ConcentrationPanel rows={data.breadth} />
          </section>

          <section className="space-y-10">
            <SectionTitle>What is waiting</SectionTitle>
            <StuckPanel
              rows={stuck.data?.rows ?? []}
              capped={stuck.data?.capped ?? false}
              loading={stuck.isLoading && !stuck.data}
              failed={stuck.isError}
              onRetry={() => stuck.refetch()}
              monthFiltered={Boolean(month)}
              openDrill={() =>
                openDrill({
                  label: "Everything still in the chain",
                  filters: stuckScope,
                  statuses: DESKS.map((d) => d.status),
                })
              }
            />
            <Distribution
              title="By stage"
              dimension="Stage"
              unit="money"
              caption="How much is committed at each stage of the chain, not yet paid."
              points={data.pipeline.map((p) => ({
                ...p,
                to: drillHref({ label: p.label ?? p.key, filters: { ...scope, status: p.key } }),
              }))}
            />
            <Distribution
              title="How long it has waited"
              dimension="Age"
              caption={
                data.ageing.oldest_days != null
                  ? `The oldest open claim has waited ${data.ageing.oldest_days} days. No single query can filter by age, so these bars are not clickable — the numbers below are the whole story.`
                  : undefined
              }
              points={data.ageing.rows}
            />
          </section>
        </>
      )}

      <Sheet open={!!drill} onOpenChange={(open) => !open && closeDrill()}>
        <SheetContent>
          {drill && (
            <>
              <SheetHeader>
                <SheetTitle>{drill.label}</SheetTitle>
                <SheetDescription>
                  {drillQuery.data
                    ? `${drillQuery.data.total.toLocaleString("en-IN")} claim${drillQuery.data.total === 1 ? "" : "s"} · ${money(drillQuery.data.total_amount)}`
                    : "Loading…"}
                </SheetDescription>
              </SheetHeader>
              <SheetBody>
                {drillQuery.isLoading ? (
                  <SkeletonRows rows={6} rowHeight={56} />
                ) : drillQuery.isError ? (
                  <ErrorState
                    title="Could not load these rows"
                    message="The server did not answer. Nothing has been lost."
                    onRetry={() => drillQuery.refetch()}
                  />
                ) : drillQuery.data && drillQuery.data.results.length > 0 ? (
                  <ul className="divide-y divide-line">
                    {drillQuery.data.results.map((c) => (
                      <ClaimRow key={c.id} claim={c} />
                    ))}
                  </ul>
                ) : (
                  <EmptyState title="Nothing matches" message="No claim falls under this filter." />
                )}
                {drillQuery.data && drillQuery.data.results.length < drillQuery.data.total && (
                  <p className="mt-3 text-sm text-fg-muted">
                    Showing the first {drillQuery.data.results.length.toLocaleString("en-IN")} of{" "}
                    {drillQuery.data.total.toLocaleString("en-IN")}. Narrow a filter above, or export, to see
                    the rest.
                  </p>
                )}
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

/** One row inside the drill-down sheet — the same information `papers.tsx`'s
 *  card shows, plus who and which department, since this list spans the
 *  whole college rather than one person's own papers. */
function ClaimRow({ claim: c }: { claim: SearchClaim }) {
  return (
    <li className="row">
      <a href={`/papers/${c.id}`} className="block px-1 py-3">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base">{c.paper_title || "Untitled"}</span>
            <Meta className="mt-0.5 block truncate">
              {[c.owner_name, c.owner_department, c.publication_year].filter(Boolean).join(" · ")}
            </Meta>
          </span>
          <span className="shrink-0 text-right">
            {c.calc_error ? (
              <span className="text-xs text-critical">Could not calculate</span>
            ) : (
              <>
                <span className="block text-base tabular">{money(c.remuneration)}</span>
                {c.remuneration != null && c.remuneration_is_estimate && (
                  <span className="block text-xs text-caution">Estimate</span>
                )}
              </>
            )}
          </span>
        </div>
        <Stage stage={stageOf(c.status)} className="mt-2 w-[8rem]" />
      </a>
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* HOD reports — departmental output, no money anywhere                    */
/* ------------------------------------------------------------------------ */

type HodPerson = {
  id: string
  name: string
  designation: string | null
  publications: number
  first_author: number
  q1: number
}

type HodOverview = {
  department: string
  years_on_record: number[]
  totals: {
    publications: number
    faculty_in_department: number
    faculty_who_published: number
    q1: number
    first_author: number
    under_review: number
  }
  by_year: Point[]
  by_quartile: Point[]
  by_type: Point[]
  by_journal: Point[]
  by_indexing: Point[]
  people: HodPerson[]
}

type HodPubRow = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  publication_year: number | null
  quartile: string | null
  owner_name: string
  progress: string
}

type HodPubPayload = { total: number; results: HodPubRow[] }

/**
 * A chart point with the money taken off it, not merely hidden.
 *
 * `/api/hod/overview` sends `amount: 0` on every row of every breakdown — a
 * placeholder, not a figure — and `Figure` in `@/ui/chart` prints its "Paid"
 * column whenever any point carries an amount that is not null. Zero is not
 * null, so a head of department was being shown a column of rupee signs on
 * four charts. Nothing real leaked, because the values were all ₹0; what
 * leaked was the column, and the day somebody makes that endpoint send a real
 * number the column is already there waiting for it.
 *
 * So the amount is dropped before the chart is handed the row, rather than
 * suppressed inside it. A value the component never receives cannot be
 * printed by the next person who adds a column there.
 */
const countOnly = (p: Point): Point => ({ key: p.key, label: p.label, count: p.count })

/** What a head of department sees: departmental output, by year, quartile,
 *  journal and person — never a rupee, by any route, because this branch
 *  never asks `/api/reports` for anything. Every point handed to a chart has
 *  had its `amount` stripped as well as its axis hidden: `Figure` (inside
 *  `@/ui/chart`) still lists whatever `amount` it is given in its own "show
 *  the numbers" table regardless of which axis it was told to draw, so
 *  hiding the axis alone would have let money back in through that table. */
function HodReports() {
  const [searchParams, setSearchParams] = useSearchParams()
  // See `countOnly` above for why every point on this screen goes through it.
  const location = useLocation()

  const year = searchParams.get("year") ?? ""
  const drill = useMemo(() => readDrill(searchParams), [searchParams])

  function setYear(value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set("year", value)
      else next.delete("year")
      next.delete("sheet")
      return next
    })
  }

  function closeDrill() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete("sheet")
      return next
    })
  }

  function drillHref(d: Drill): string {
    const next = new URLSearchParams(searchParams)
    next.set("sheet", JSON.stringify(d))
    return `${location.pathname}?${next.toString()}`
  }

  const reportQuery = new URLSearchParams()
  if (year) reportQuery.set("year", year)
  const { data, isLoading, isError, refetch } = useApi<HodOverview>(
    ["hod-overview", year],
    `/api/hod/overview?${reportQuery.toString()}`,
    { placeholderData: (prev) => prev }
  )

  const yearOptions: ComboboxOption[] = [
    { value: "", label: "All years" },
    ...(data?.years_on_record || []).map((y) => ({ value: String(y), label: String(y) })),
  ]

  const drillKey = searchParams.get("sheet") ?? ""
  const drillQuery = useApi<HodPubPayload>(
    ["hod-drill", drillKey],
    `/api/hod/publications?${new URLSearchParams({ ...drill?.filters, limit: "200" }).toString()}`,
    { enabled: !!drill }
  )

  function exportHref(fmt: string): string {
    const params = new URLSearchParams()
    if (year) params.set("year", year)
    params.set("fmt", fmt)
    return `/api/hod/export?${params.toString()}`
  }

  const filtered = Boolean(year)

  return (
    <div className="page space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>{data ? `${data.department} — publications` : "Reports"}</PageTitle>
          <Sub className="mt-1">What the department has produced, and by whom.</Sub>
        </div>
        <div className="min-w-0">
          <ColumnLabel className="mb-1 block">Also download as</ColumnLabel>
          <div className="flex flex-wrap gap-1">
            <Button kind="quiet" size="sm" asChild>
              <a href={exportHref("xlsx")} download>
                <Download />
                Excel
              </a>
            </Button>
            <Button kind="quiet" size="sm" asChild>
              <a href={exportHref("csv")} download>
                CSV
              </a>
            </Button>
          </div>
        </div>
      </header>

      <Callout tone="info" title="Payment figures are not shown for this role">
        As a head of department you can see what the department has published, not what anybody
        has been paid for it.
      </Callout>

      <div className="flex flex-wrap items-center gap-3">
        <Combobox
          value={year}
          onChange={setYear}
          options={yearOptions}
          placeholder="All years"
          aria-label="Filter by publication year"
          className="w-32"
        />
        <Meta className="tabular">
          {data
            ? `${data.totals.publications.toLocaleString("en-IN")} publication${
                data.totals.publications === 1 ? "" : "s"
              } ${filtered ? "match" : "on record"}`
            : isError
              ? "Count unavailable"
              : "Counting…"}
        </Meta>
        {year && <RemoveChip label={`Year ${year}`} onRemove={() => setYear("")} />}
      </div>

      {isLoading && !data ? (
        <ReportsSkeleton />
      ) : isError ? (
        <ErrorState
          title="Could not load the report"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => refetch()}
        />
      ) : !data || data.totals.publications === 0 ? (
        <EmptyState
          title={filtered ? "Nothing matches this year" : "Nothing recorded yet"}
          message={
            filtered
              ? "No publication falls under this year. Try clearing it."
              : "Figures appear here once someone in the department has filed a paper."
          }
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={() => setYear("")}>
                Clear the year
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
            <Headline
              label="Publications"
              value={data.totals.publications.toLocaleString("en-IN")}
              hint={`${data.totals.faculty_who_published} of ${data.totals.faculty_in_department} faculty have published`}
            />
            <Headline
              label="Q1 journals"
              value={data.totals.q1.toLocaleString("en-IN")}
              hint={`${data.totals.first_author} as first author`}
            />
            {/* /api/hod/publications has no status filter, so this figure
                states its number honestly rather than opening a list it
                cannot actually produce. */}
            <Headline
              label="Under review"
              value={data.totals.under_review.toLocaleString("en-IN")}
              hint="With the research cell or the Principal"
            />
          </section>

          <Trend
            title="Publications by year"
            dimension="Year"
            showAmounts={false}
            points={data.by_year.map((p) => ({
              ...countOnly(p),
              to: drillHref({ label: `Published in ${p.key}`, filters: { year: p.key } }),
            }))}
          />

          {/* The two review-meeting questions a head is asked about their own
              department. Both are counted from the payload already on screen,
              so neither opens a route to a figure this role may not see. */}
          <section className="space-y-10">
            <HodDirection byYear={data.by_year} />
            <HodConcentration
              people={data.people}
              publications={data.totals.publications}
              facultyInDepartment={data.totals.faculty_in_department}
            />
          </section>

          <MixBar
            title="Quartile mix"
            dimension="Quartile"
            showAmounts={false}
            points={data.by_quartile.map((p) => ({
              ...countOnly(p),
              to: drillHref({
                label: p.label ?? p.key,
                filters: { ...(year ? { year } : {}), quartile: p.key },
              }),
            }))}
          />

          <section className="space-y-10">
            <RankedBars
              title="By journal"
              dimension="Journal"
              caption="Free-text matched, so an unusual abbreviation of the same journal may not group with it."
              showAmounts={false}
              points={data.by_journal.map((p) => ({
                ...countOnly(p),
                to: drillHref({
                  label: p.label ?? p.key,
                  filters: { ...(year ? { year } : {}), q: p.key },
                }),
              }))}
            />
            <RankedBars
              title="By type"
              dimension="Type"
              showAmounts={false}
              points={data.by_type.map(countOnly)}
            />
            <RankedBars
              title="By indexing"
              dimension="Index"
              caption="A paper indexed in more than one place is counted under each, so this can add up to more than the total."
              showAmounts={false}
              points={data.by_indexing.map(countOnly)}
            />
          </section>

          <RankedBars
            title="Faculty"
            dimension="Person"
            limit={data.people.length}
            caption="Everyone in the department, including anyone who has published nothing yet."
            points={data.people.map((p) => ({
              key: p.id,
              label: p.name,
              count: p.publications,
              to: `/people/${p.id}`,
            }))}
          />
        </>
      )}

      <Sheet open={!!drill} onOpenChange={(open) => !open && closeDrill()}>
        <SheetContent>
          {drill && (
            <>
              <SheetHeader>
                <SheetTitle>{drill.label}</SheetTitle>
                <SheetDescription>
                  {drillQuery.data
                    ? `${drillQuery.data.total.toLocaleString("en-IN")} publication${drillQuery.data.total === 1 ? "" : "s"}`
                    : "Loading…"}
                </SheetDescription>
              </SheetHeader>
              <SheetBody>
                {drillQuery.isLoading ? (
                  <SkeletonRows rows={6} rowHeight={56} />
                ) : drillQuery.isError ? (
                  <ErrorState
                    title="Could not load these rows"
                    message="The server did not answer. Nothing has been lost."
                    onRetry={() => drillQuery.refetch()}
                  />
                ) : drillQuery.data && drillQuery.data.results.length > 0 ? (
                  <ul className="divide-y divide-line">
                    {drillQuery.data.results.map((c) => (
                      <li key={c.id} className="row">
                        <a href={`/papers/${c.id}`} className="block px-1 py-3">
                          <span className="block truncate text-base">{c.paper_title || "Untitled"}</span>
                          <Meta className="mt-0.5 block truncate">
                            {[c.owner_name, c.journal_title, c.publication_year].filter(Boolean).join(" · ")}
                          </Meta>
                          <span className="mt-1 block text-sm text-fg-muted">{c.progress}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState title="Nothing matches" message="No publication falls under this filter." />
                )}
                {drillQuery.data && drillQuery.data.results.length < drillQuery.data.total && (
                  <p className="mt-3 text-sm text-fg-muted">
                    Showing the first {drillQuery.data.results.length.toLocaleString("en-IN")} of{" "}
                    {drillQuery.data.total.toLocaleString("en-IN")}. Narrow the year above, or export, to see
                    the rest.
                  </p>
                )}
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Cut one — is anything stuck?                                             */
/* ------------------------------------------------------------------------ */

/** Over a month at one desk. Not a rule of the scheme, a reading of it: the
 *  ageing buckets already break at 30 days, and a ticket that has sat with one
 *  person for longer than the month it was meant to be settled in is the thing
 *  somebody came to this report to find. */
const STUCK_DAYS = 30

/** How many of the longest-waiting tickets to name. Enough to act on in a
 *  meeting, not so many that the panel becomes the queue screen — the whole
 *  open set is one click away in the sheet. */
const STUCK_SHOWN = 8

/**
 * The tickets standing at a desk longest, by name, with the desk on each one.
 *
 * The report already drew how long things had waited as five buckets, which
 * answers "is there a problem" and nothing else. "71 tickets in the 1–3 month
 * bucket" cannot be chased; a paper title, the person waiting on it and the
 * desk it is at can be. That gap — between a distribution and a next action —
 * is what sent people to an export.
 *
 * Loading, failed and empty are three different sentences here. "Nothing is
 * stuck" is good news and reads like it; a failed request says the request
 * failed and offers the retry, because a reader who cannot tell them apart
 * will take a broken panel as an all-clear.
 */
function StuckPanel({
  rows,
  capped,
  loading,
  failed,
  onRetry,
  monthFiltered,
  showAmounts = true,
  openDrill,
}: {
  rows: StuckClaim[]
  capped: boolean
  loading: boolean
  failed: boolean
  onRetry: () => void
  /** Whether a settled-month filter is on, which this panel does not obey. */
  monthFiltered: boolean
  showAmounts?: boolean
  openDrill: () => void
}) {
  const stuck = rows.filter((r) => (r.waiting_days ?? 0) > STUCK_DAYS)
  const oldest = rows[0]?.waiting_days ?? null

  return (
    <section className="min-w-0">
      <h3 className="text-lg font-semibold">Standing at a desk longest</h3>
      <p className="mt-0.5 text-sm text-fg-muted">
        Counted from when the ticket arrived at the step it is at now, not from the last time
        anybody edited it. Paid and returned tickets have stopped waiting and are not here.
        {monthFiltered
          ? " The settled-month filter does not apply: nothing still waiting has been settled in any month."
          : ""}
      </p>

      {loading ? (
        <div className="mt-4">
          <SkeletonRows rows={5} rowHeight={44} />
        </div>
      ) : failed ? (
        <InlineError
          className="mt-4"
          message="Could not read the queue. Every other figure on this page is unaffected."
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <p className="mt-4 rounded-md bg-positive-wash px-3 py-3 text-sm">
          Nothing is standing at a desk. Every ticket in scope has been paid or sent back.
        </p>
      ) : (
        <>
          <p
            className={cn(
              "mt-4 rounded-md px-3 py-2.5 text-sm leading-relaxed",
              stuck.length ? "bg-caution-wash" : "bg-positive-wash"
            )}
          >
            {stuck.length ? (
              <>
                <span className="font-medium">
                  {stuck.length.toLocaleString("en-IN")}{" "}
                  {stuck.length === 1 ? "ticket has" : "tickets have"} waited more than a month.
                </span>{" "}
              </>
            ) : (
              <>Nothing has waited more than a month. </>
            )}
            {oldest != null
              ? `The oldest of the ${rows.length.toLocaleString("en-IN")} still in the chain has been at its step for ${oldest} days.`
              : null}
          </p>

          <ul className="mt-3 divide-y divide-line">
            {rows.slice(0, STUCK_SHOWN).map((c) => (
              <li key={c.id} className="row">
                <Link to={`/papers/${c.id}`} className="block px-1 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base">
                        {c.paper_title || "Untitled"}
                      </span>
                      <Meta className="mt-0.5 block truncate">
                        {[c.owner_name, c.owner_department, c.desk].filter(Boolean).join(" · ")}
                      </Meta>
                    </span>
                    <span className="shrink-0 text-right">
                      {/* The number and the word both say it is bad news; the
                          colour is only the third signal. */}
                      <span
                        className={cn(
                          "block text-base tabular",
                          (c.waiting_days ?? 0) > STUCK_DAYS && "text-caution"
                        )}
                      >
                        {c.waiting_days} {c.waiting_days === 1 ? "day" : "days"}
                      </span>
                      {showAmounts && c.remuneration != null && (
                        <Meta className="block tabular">{money(c.remuneration)}</Meta>
                      )}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-sm text-fg-muted">
            {rows.length > STUCK_SHOWN
              ? `${(rows.length - STUCK_SHOWN).toLocaleString("en-IN")} more are waiting behind these. `
              : ""}
            <button
              type="button"
              onClick={openDrill}
              className="text-accent underline-offset-4 hover:underline"
            >
              Open the whole queue
            </button>
            {capped
              ? " More than 200 tickets are at one desk, so this lists the longest wait among the first 200 the server returned rather than the longest overall."
              : ""}
          </p>
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Cut two — broad, or carried by a few?                                    */
/* ------------------------------------------------------------------------ */

/**
 * How few papers a year can hold and still have a share worth quoting.
 *
 * Not simply "the first year on record". 2019 holds one paper by one person,
 * so its top-ten share is 100% by arithmetic rather than by concentration, and
 * comparing against it made the spread look far more dramatic than it is.
 */
const MEANINGFUL_YEAR = 20

/**
 * Whether the output is broad or rests on a few people, per year.
 *
 * Output can rise because more people published, or because the same people
 * published more, and a total cannot tell those apart — which is why "we are
 * up 20%" and "one lab is up 20%" reached the same meeting as the same
 * sentence. Papers, people, papers each, and the share of the year written by
 * its ten most prolific authors: the last is the one that answers the
 * question, and the first three are what stop it being read out of context.
 */
function ConcentrationPanel({ rows }: { rows: BreadthRow[] }) {
  const latest = rows.length ? rows[rows.length - 1] : null
  const earliest = rows.find((r) => r.count >= MEANINGFUL_YEAR && r !== latest)
  const thin = rows.some((r) => r.count < MEANINGFUL_YEAR)

  if (!latest) {
    return (
      <section className="min-w-0">
        <h3 className="text-lg font-semibold">How many people are carrying it</h3>
        <p className="mt-4 text-sm text-fg-muted">
          No publication in scope has a year on it, so there is nothing to spread across years.
        </p>
      </section>
    )
  }

  const widening = earliest ? latest.top_ten_share < earliest.top_ten_share : false

  return (
    <section className="min-w-0">
      <h3 className="text-lg font-semibold">How many people are carrying it</h3>
      <p className="mt-0.5 text-sm text-fg-muted">
        Output can rise because more people published, or because the same people published
        more. A total cannot tell those apart.
      </p>

      <div className="mt-4">
        <TableScroller minWidth="26rem">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" className={stickyHeadCell}>
                  <ColumnLabel>Year</ColumnLabel>
                </th>
                {["Papers", "People", "Each", "Top ten"].map((h) => (
                  <th key={h} scope="col" className={cn(stickyHeadCell, "text-right")}>
                    <ColumnLabel>{h}</ColumnLabel>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="row border-b border-line last:border-b-0">
                  <td className="px-3 py-2 align-middle tabular">{r.key}</td>
                  <td className="px-3 py-2 text-right align-middle tabular">
                    {r.count.toLocaleString("en-IN")}
                  </td>
                  <td className="px-3 py-2 text-right align-middle tabular">
                    {r.people.toLocaleString("en-IN")}
                  </td>
                  <td className="px-3 py-2 text-right align-middle tabular text-fg-muted">
                    {r.per_person}
                  </td>
                  <td className="px-3 py-2 text-right align-middle">
                    <span className="inline-flex items-center gap-2">
                      <span className="block h-1.5 w-10 overflow-hidden rounded-full bg-line">
                        <span
                          className="block h-full rounded-full bg-accent"
                          style={{ width: `${r.top_ten_share}%` }}
                        />
                      </span>
                      <span className="tabular">{r.top_ten_share}%</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </div>

      <p className="mt-2 text-sm text-fg-muted">
        “Top ten” is the share of that year’s papers written by its ten most prolific authors.{" "}
        {!earliest
          ? "No earlier year holds enough papers to say which way it is moving."
          : widening
            ? `It has fallen from ${earliest.top_ten_share}% in ${earliest.key} to ${latest.top_ten_share}% in ${latest.key} — the work is spread across more people than it was.`
            : `It has risen from ${earliest.top_ten_share}% in ${earliest.key} to ${latest.top_ten_share}% in ${latest.key} — the output rests on fewer people than it did.`}
        {thin
          ? ` Years holding fewer than ${MEANINGFUL_YEAR} papers are listed but never used as the baseline — a share out of one paper is 100% whatever happened.`
          : ""}
      </p>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Cut three — is a department going up or down?                            */
/* ------------------------------------------------------------------------ */

/**
 * Each department this year against its own last year, and — before any of it
 * — whether this record may be read that way at all.
 *
 * This is the cut that is easiest to get confidently wrong, so it is drawn
 * with two guards in front of it and both of them speak before the numbers do.
 *
 * The first is the server's. `/api/trends/me` compares three years against the
 * three before them and refuses the comparison when the earlier window holds
 * under a fifth of the later one, which on this record it does: 140 papers for
 * 2021–2023 against 3,029 since 2024. Its own sentence is printed rather than
 * paraphrased, because the endpoint that made the decision is the thing that
 * should explain it.
 *
 * The second is the same test applied to the pair actually on screen, both to
 * the two years as a whole and to each department in turn. A department with
 * one paper last year and thirty this year is not up 2,900%; it is a
 * department whose earlier year was never filled in, and it gets no direction
 * at all rather than the largest arrow on the page.
 *
 * And a part-year is called out above the rows rather than under them. Every
 * department on this record reads down by half in August, and a reader who
 * scrolls past the caveat believes it.
 */
function DirectionPanel({
  yoy,
  trends,
  trendsLoading,
  drillHref,
  scope,
}: {
  yoy: YearOnYear | null
  trends: TrendsOverview | undefined
  trendsLoading: boolean
  drillHref: (d: Drill) => string
  scope: Record<string, string>
}) {
  const college = trends?.college
  const recentTotal = yoy ? yoy.rows.reduce((n, r) => n + r.count, 0) : 0
  const priorTotal = yoy ? yoy.rows.reduce((n, r) => n + r.previous, 0) : 0
  const pairComparable = yoy ? isComparable(recentTotal, priorTotal) : false
  const max = yoy
    ? Math.max(1, ...yoy.rows.map((r) => Math.max(r.count, r.previous)))
    : 1

  return (
    <section className="min-w-0 space-y-3">
      <div>
        <h3 className="text-lg font-semibold">
          {yoy ? `${yoy.this_year} against ${yoy.last_year}` : "Which way it is going"}
        </h3>
        <p className="mt-0.5 text-sm text-fg-muted">
          Each department’s publications this year beside its own last year. Compared on
          publication year, not payout month: a department is judged on what it published, not
          on when the college got round to paying for it.
        </p>
      </div>

      {/* The longer view, from the endpoint that already knows when it must
          not answer. Its own loading state, because a slow model-health probe
          rides along with it and the rows below must not wait for that. */}
      {trendsLoading && !college ? (
        <Skeleton className="h-16 w-full" />
      ) : college && !college.totals.comparable ? (
        <Callout tone="caution" title="The longer view cannot be read off this record">
          {college.totals.not_comparable_why ??
            `Only ${college.totals.papers_prior.toLocaleString("en-IN")} papers are recorded for ${college.window.prior_from}–${college.window.prior_to}, against ${college.totals.papers.toLocaleString("en-IN")} since ${college.window.recent_from}.`}
        </Callout>
      ) : college ? (
        <Callout tone="info" title={`Against ${college.window.prior_from}–${college.window.prior_to}`}>
          The college has {college.totals.papers.toLocaleString("en-IN")} publications for{" "}
          {college.window.recent_from}–{college.window.recent_to} against{" "}
          {college.totals.papers_prior.toLocaleString("en-IN")} for the three years before,
          which is enough of an earlier record to compare against.
        </Callout>
      ) : null}

      {!yoy || yoy.rows.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Fewer than two publication years are on record in this scope, so there is no previous
          year to compare against.
        </p>
      ) : (
        <>
          {!pairComparable && (
            <Callout tone="caution" title="Not compared — the earlier year is not an earlier year">
              Only {priorTotal.toLocaleString("en-IN")}{" "}
              {priorTotal === 1 ? "paper is" : "papers are"} recorded for {yoy.last_year},
              against {recentTotal.toLocaleString("en-IN")} for {yoy.this_year}. That gap is the
              reach of the import rather than a change in output, so the counts below are shown
              and nothing is called up or down.
            </Callout>
          )}

          {yoy.this_year_is_partial && (
            <Callout tone="caution" title={`${yoy.this_year} is not over`}>
              {yoy.this_year} is {yoy.months_elapsed} months old and {yoy.last_year} is a full
              year, so every figure below is a part-year against a whole one. Expect the change
              column to read low until December.
            </Callout>
          )}

          <ul className="space-y-3">
            {yoy.rows.slice(0, 12).map((r) => {
              const rowComparable = pairComparable && isComparable(r.count, r.previous)
              return (
                <li key={r.key} className="min-w-0">
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <Link
                      to={drillHref({
                        label: `${r.key} · ${yoy.this_year}`,
                        filters: { ...scope, department: r.key, year: String(yoy.this_year) },
                      })}
                      className="min-w-0 truncate text-sm hover:text-accent hover:underline"
                    >
                      {r.key}
                    </Link>
                    <span className="flex shrink-0 items-baseline gap-3 text-sm tabular">
                      <span className="font-medium">{r.count.toLocaleString("en-IN")}</span>
                      {rowComparable ? (
                        <span
                          className={cn(
                            "inline-flex w-28 items-center justify-end gap-0.5 whitespace-nowrap text-xs",
                            r.change > 0 && "text-positive",
                            r.change < 0 && "text-critical",
                            !r.change && "text-fg-muted"
                          )}
                        >
                          {r.change > 0 ? (
                            <ArrowUp className="size-3" aria-hidden />
                          ) : r.change < 0 ? (
                            <ArrowDown className="size-3" aria-hidden />
                          ) : (
                            <Minus className="size-3" aria-hidden />
                          )}
                          {r.change > 0 ? "+" : ""}
                          {r.change}
                          {r.percent != null
                            ? ` (${r.percent > 0 ? "+" : ""}${r.percent}%)`
                            : ""}
                        </span>
                      ) : (
                        <span
                          className="inline-flex w-28 justify-end whitespace-nowrap text-xs text-fg-subtle"
                          title={`${r.previous} in ${yoy.last_year} is too thin a base to call a direction from.`}
                        >
                          {r.previous.toLocaleString("en-IN")} in {yoy.last_year}
                        </span>
                      )}
                    </span>
                  </div>
                  {/* Two bars on one scale: this year solid over last year
                      faint, so the comparison is a shape rather than a sum the
                      reader has to do. */}
                  <div className="space-y-0.5">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.max((r.count / max) * 100, r.count ? 1 : 0)}%` }}
                      />
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-fg-subtle"
                        style={{
                          width: `${Math.max((r.previous / max) * 100, r.previous ? 1 : 0)}%`,
                        }}
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>

          <p className="text-sm text-fg-muted">
            The faint bar under each is {yoy.last_year}.
            {yoy.rows.length > 12
              ? ` ${(yoy.rows.length - 12).toLocaleString("en-IN")} more departments are below the cut.`
              : ""}
          </p>
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* The same two questions for a head of department, counted not costed      */
/* ------------------------------------------------------------------------ */

/**
 * Whether the department's output is broad or rests on a few people.
 *
 * `/api/hod/overview` already lists every member of the department with a
 * paper count, so this needs no request of its own — and, because it is
 * derived from that payload, there is no route by which a rupee can reach it.
 * A head asks this about their own department in exactly the same meeting the
 * Principal asks it about the college.
 */
function HodConcentration({
  people,
  publications,
  facultyInDepartment,
}: {
  people: HodPerson[]
  publications: number
  facultyInDepartment: number
}) {
  const counts = people
    .map((p) => p.publications)
    .filter((n) => n > 0)
    .sort((a, b) => b - a)
  const published = counts.length
  const topTen = counts.slice(0, 10).reduce((n, c) => n + c, 0)
  const share = publications > 0 ? Math.round((topTen / publications) * 100) : 0
  const silent = facultyInDepartment - published

  return (
    <section className="min-w-0">
      <h3 className="text-lg font-semibold">How many people are carrying it</h3>
      <p className="mt-0.5 text-sm text-fg-muted">
        Output can rise because more people published, or because the same people published
        more. A total cannot tell those apart.
      </p>

      {published === 0 ? (
        <p className="mt-4 text-sm text-fg-muted">
          Nobody in the department has a publication in scope, so there is nothing to spread.
        </p>
      ) : (
        <>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.max(1, share)}%` }}
            />
          </div>
          <p className="mt-2 text-sm">
            The ten most prolific people in the department wrote{" "}
            <span className="tabular font-medium">{share}%</span> of its{" "}
            {publications.toLocaleString("en-IN")} publications
            {published <= 10
              ? ` — which is everyone who published, since only ${published} did.`
              : `, out of ${published.toLocaleString("en-IN")} people who published at all.`}
          </p>
          <p className="mt-1 text-sm text-fg-muted">
            {silent > 0
              ? `${silent.toLocaleString("en-IN")} of ${facultyInDepartment.toLocaleString("en-IN")} faculty have nothing in scope. They are listed by name under “Faculty” below.`
              : `Every one of the ${facultyInDepartment.toLocaleString("en-IN")} faculty in the department has something in scope.`}
          </p>
        </>
      )}
    </section>
  )
}

/**
 * Whether the department is going up or down, with the same refusal.
 *
 * The guard matters more here than on the college report, not less: a single
 * department is a smaller set, so one thin earlier year turns into a larger
 * and more confident-looking percentage. `by_year` is plotted as a trend
 * further up this page; this says which way the last step of it went, and
 * says nothing at all when the step before it was never filled in.
 */
function HodDirection({ byYear }: { byYear: Point[] }) {
  const withYears = byYear.filter((p) => p.key)
  const latest = withYears[withYears.length - 1]
  const previous = withYears[withYears.length - 2]

  if (!latest || !previous) {
    return null
  }

  const comparable = isComparable(latest.count, previous.count)
  const change = latest.count - previous.count
  // The server flags a part year on the college report; here the record's own
  // last year is compared against the calendar, because a department reading
  // eight months against twelve will otherwise be told it has halved.
  const now = new Date()
  const partial = Number(latest.key) >= now.getFullYear()

  return (
    <section className="min-w-0 space-y-3">
      <div>
        <h3 className="text-lg font-semibold">
          {latest.key} against {previous.key}
        </h3>
        <p className="mt-0.5 text-sm text-fg-muted">
          Counted on publication year — what the department published, not when anything was
          processed.
        </p>
      </div>

      {partial && (
        <Callout tone="caution" title={`${latest.key} is not over`}>
          {latest.key} is {now.getMonth() + 1} months old and {previous.key} is a full year, so
          this is a part-year against a whole one. Expect it to read low until December.
        </Callout>
      )}

      {!comparable ? (
        <Callout tone="caution" title="Not compared — the earlier year is not an earlier year">
          {previous.count.toLocaleString("en-IN")}{" "}
          {previous.count === 1 ? "publication is" : "publications are"} recorded for{" "}
          {previous.key}, against {latest.count.toLocaleString("en-IN")} for {latest.key}. A gap
          that size is the reach of the import rather than a change in output, so this is left
          as two counts and no direction.
        </Callout>
      ) : (
        <p className="flex items-baseline gap-2 text-sm">
          {change > 0 ? (
            <ArrowUp className="size-4 shrink-0 text-positive" aria-hidden />
          ) : change < 0 ? (
            <ArrowDown className="size-4 shrink-0 text-critical" aria-hidden />
          ) : (
            <Minus className="size-4 shrink-0 text-fg-muted" aria-hidden />
          )}
          <span>
            {change > 0 ? "Up" : change < 0 ? "Down" : "Level"}{" "}
            {change !== 0 ? (
              <span className="tabular font-medium">
                {Math.abs(change).toLocaleString("en-IN")}
              </span>
            ) : null}{" "}
            — {latest.count.toLocaleString("en-IN")} in {latest.key} against{" "}
            {previous.count.toLocaleString("en-IN")} in {previous.key}.
          </span>
        </p>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Shared pieces                                                           */
/* ------------------------------------------------------------------------ */

/** A large answer, not a small label — "fewer, larger figures" means this is
 *  the one number on the page a reader's eye should land on first. Clickable
 *  when there is somewhere for it to open; a plain figure otherwise, since a
 *  button that opens nothing is worse than no button. */
function Headline({
  label,
  value,
  hint,
  onOpen,
}: {
  label: string
  value: string
  hint?: string
  onOpen?: () => void
}) {
  const content = (
    <>
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular">{value}</p>
      {hint && <p className="mt-1 text-sm text-fg-muted">{hint}</p>}
    </>
  )
  if (!onOpen) {
    return <div className="-mx-4 rounded-lg px-4 py-4">{content}</div>
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "-mx-4 rounded-lg px-4 py-4 text-left",
        "transition-colors duration-[var(--dur-1)] ease-out hover:bg-hover"
      )}
    >
      {content}
    </button>
  )
}

/**
 * One active filter, with the way out of it attached.
 *
 * A combobox showing "2023" says what is selected only while you are looking
 * at the combobox. Every figure on this page is silently narrowed by it, and
 * the reader who scrolled past has no reminder — which is how a department's
 * 40 papers get quoted as the college's year. A chip sits with the count it
 * changed, and removing it is one click on the chip itself.
 */
function RemoveChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-sm bg-selected px-2 text-sm">
      <span className="max-w-[12rem] truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className={cn(
          "-mr-1 inline-flex size-5 items-center justify-center rounded-sm text-fg-muted",
          "transition-colors duration-[var(--dur-1)] ease-out hover:bg-hover hover:text-fg"
        )}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </span>
  )
}

function ReportsSkeleton() {
  return (
    <div className="space-y-10">
      <div className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-4 w-36" />
          </div>
        ))}
      </div>
      <SkeletonRows rows={5} rowHeight={40} />
    </div>
  )
}
