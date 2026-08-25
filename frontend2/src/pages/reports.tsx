import { useMemo } from "react"
import { useLocation, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Download } from "lucide-react"

import { useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { RankedBars, MixBar, Trend, Distribution, type Point } from "@/ui/chart"
import { money, Stage, stageOf } from "@/ui/paper"
import {
  Callout,
  EmptyState,
  ErrorState,
  Skeleton,
  SkeletonRows,
} from "@/ui/state"
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/ui/sheet"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

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
  years: number[]
  payout_months: string[]
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
}

type SearchPayload = {
  total: number
  total_amount: number
  results: SearchClaim[]
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

  const drillKey = searchParams.get("sheet") ?? ""
  const drillQuery = useQuery({
    queryKey: ["reports-drill", drillKey],
    queryFn: () => fetchCollegeDrill(drill as Drill),
    enabled: !!drill,
  })

  const exportParams = new URLSearchParams(scope)
  exportParams.set("fmt", "xlsx")

  const filtered = Boolean(year) || Boolean(department) || Boolean(month)

  return (
    <div className="page space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Reports</PageTitle>
          <Sub className="mt-1">What the scheme has paid, what it has produced, and what is still open.</Sub>
        </div>
        <Button kind="default" size="sm" asChild>
          <a href={`/api/reports/export?${exportParams.toString()}`}>
            <Download />
            Export
          </a>
        </Button>
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
                  statuses: ["CLEARED", "PRINCIPAL_APPROVED", "RESEARCH_APPROVED", "FINANCE_APPROVED"],
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

          <MixBar
            title="Quartile mix"
            dimension="Quartile"
            points={data.by_quartile.map((p) => ({
              ...p,
              to: drillHref({ label: p.label ?? p.key, filters: { ...scope, quartile: p.key } }),
            }))}
          />

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
          </section>

          <section className="space-y-10">
            <SectionTitle>What is waiting</SectionTitle>
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

/** What a head of department sees: departmental output, by year, quartile,
 *  journal and person — never a rupee, by any route, because this branch
 *  never asks `/api/reports` for anything. Every point handed to a chart has
 *  had its `amount` stripped as well as its axis hidden: `Figure` (inside
 *  `@/ui/chart`) still lists whatever `amount` it is given in its own "show
 *  the numbers" table regardless of which axis it was told to draw, so
 *  hiding the axis alone would have let money back in through that table. */
function HodReports() {
  const [searchParams, setSearchParams] = useSearchParams()
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

  const exportParams = new URLSearchParams()
  if (year) exportParams.set("year", year)
  exportParams.set("fmt", "xlsx")

  const filtered = Boolean(year)

  return (
    <div className="page space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>{data ? `${data.department} — publications` : "Reports"}</PageTitle>
          <Sub className="mt-1">What the department has produced, and by whom.</Sub>
        </div>
        <Button kind="default" size="sm" asChild>
          <a href={`/api/hod/export?${exportParams.toString()}`}>
            <Download />
            Export
          </a>
        </Button>
      </header>

      <Callout tone="info" title="Payment figures are not shown for this role">
        As a head of department you can see what the department has published, not what anybody
        has been paid for it.
      </Callout>

      <Combobox
        value={year}
        onChange={setYear}
        options={yearOptions}
        placeholder="All years"
        aria-label="Filter by publication year"
        className="w-32"
      />

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
            points={data.by_year.map((p) => ({
              ...p,
              to: drillHref({ label: `Published in ${p.key}`, filters: { year: p.key } }),
            }))}
          />

          <MixBar
            title="Quartile mix"
            dimension="Quartile"
            points={data.by_quartile.map((p) => ({
              ...p,
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
              points={data.by_journal.map((p) => ({
                ...p,
                to: drillHref({
                  label: p.label ?? p.key,
                  filters: { ...(year ? { year } : {}), q: p.key },
                }),
              }))}
            />
            <RankedBars title="By type" dimension="Type" points={data.by_type} />
            <RankedBars
              title="By indexing"
              dimension="Index"
              caption="A paper indexed in more than one place is counted under each, so this can add up to more than the total."
              points={data.by_indexing}
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
