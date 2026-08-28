import { useMemo } from "react"
import { useLocation, useSearchParams } from "react-router-dom"
import { BarChart3, Download, Table2, X } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { isComparable, isMostlyMissing, MixBar, RankedBars, Trend, type Point } from "@/ui/chart"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { money, Stage, stageOf } from "@/ui/paper"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/ui/sheet"
import {
  Callout,
  EmptyState,
  ErrorState,
  InlineError,
  Skeleton,
  SkeletonRows,
} from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * Build a report, read it on screen, take it away if you want it.
 *
 * The screen and the file come out of the same `/api/reports/build` call with
 * `fmt` as the only difference, because a preview and a download built by
 * separate code paths drift, and the way anybody finds out is a meeting where
 * the printed figure and the projected one disagree. That is why the download
 * links carry the very query the page is looking at.
 *
 * What changed here is the order of those two things. The downloads used to
 * sit in the filter bar with a "Download" label in front of them, which said
 * the file was the report and the page was a receipt for it — so the honest
 * complaint was "there has to be a better way to view reports". Now the
 * figures are the page: a headline count and total for whatever is in scope,
 * a chart per breakdown, the numbers under it, and the formats tucked beside
 * the heading as the secondary thing they are.
 *
 * The one thing this screen refuses to do is add money up across a dimension
 * where a paper appears more than once. A paper spanning four subject areas
 * has its full amount counted under each, so summing the column gives 12.6
 * crore against an actual 2.8 crore of payouts. The server returns
 * `amount: null` for those totals; the charts here drop the money axis
 * entirely rather than draw a shape nobody should read, and the sentence that
 * replaces the total says why. `/api/reports/areas` supplies the other half
 * of that honesty for subject areas — subjects are only known for a paper
 * whose journal Scimago matched, so the coverage fraction is shown with them.
 */

/* ------------------------------------------------------------------------ */
/* Data — read out of reports_build() in backend/core/api.py                */
/* ------------------------------------------------------------------------ */

type BuiltRow = { key: string; count: number; amount: number }

type BuiltTable = {
  key: string
  label: string
  rows: BuiltRow[]
  row_count: number
  truncated: number
  /** One paper appears in several rows; the money total is withheld. */
  overlapping: boolean
  totals: { count: number; amount: number | null }
}

type BuildPayload = {
  tables: BuiltTable[]
  filters: { year: number | null; department: string | null; month: string | null }
  subtitle: string
  available: { key: string; label: string }[]
  years: number[]
}

/** `/api/reports/search` with `limit=1`: the count and the sum over everything
 *  that matches, which is the one figure both the page and the reader need
 *  before any breakdown makes sense. Its filters run through the same
 *  queryset as `/api/reports/build`, so the two cannot disagree. */
type ScopeTotals = { total: number; total_amount: number }

type AreaCoverage = {
  coverage: { classified: number; total: number; unclassified: number; fraction: number }
  distinct: number
}

type SearchClaim = {
  id: string
  paper_title: string
  journal_title: string | null
  owner_name: string
  owner_department: string | null
  publication_year: number | null
  status: string
  remuneration: number | null
  remuneration_is_estimate: boolean
  calc_error: string | null
}

type SearchPayload = { total: number; total_amount: number; results: SearchClaim[] }

type Measure = "count" | "amount"
type View = "bars" | "table"

/** Two breakdowns on first load, not one: a department ranking answers "who",
 *  a year trend answers "when", and between them the page is worth reading
 *  before the reader has chosen anything at all. */
const DEFAULT_DIMENSIONS = "department,year"

const FORMATS: { key: string; label: string }[] = [
  { key: "xlsx", label: "Excel" },
  { key: "csv", label: "CSV" },
  { key: "pdf", label: "PDF" },
  { key: "docx", label: "Word" },
  { key: "json", label: "JSON" },
]

/**
 * Which `/api/reports/search` parameter a row of each breakdown maps to.
 *
 * A bar with no way behind it is a figure the reader has to take on trust,
 * and these are the ones people argue about in meetings. `area` is absent on
 * purpose: subject areas live in a semicolon-separated column that no search
 * filter can express, so those rows are drawn without a link rather than
 * linked to a query that would quietly return the wrong set.
 */
const DRILL_PARAM: Record<string, string> = {
  year: "year",
  department: "department",
  quartile: "quartile",
  journal: "journal",
  type: "publication_type",
  indexing: "indexing",
  designation: "designation",
  status: "status",
  engineering: "engineering_class",
  category: "category",
  person: "q",
}

/** The server folds every spelling of "blank" into one row. Only two search
 *  filters know how to ask for that row back, so the rest are left unlinked
 *  rather than opening an empty sheet. */
const BLANK_LABELS = new Set(["Not recorded", "Not stated"])
const BLANK_FILTERABLE = new Set(["designation", "type"])

/** What a bar opens. `filters` carries the page's own year and department as
 *  well as the clicked row, or the sheet would answer a wider question than
 *  the chart asked — clicking "CSE" on a report narrowed to 2024 would list
 *  every CSE paper ever filed under a heading that says 2024. `note` says
 *  which narrowing is in force, since the sheet covers the filter bar. */
type Drill = { label: string; note?: string; filters: Record<string, string> }

/**
 * Why a dimension is empty, where the answer is known and actionable.
 *
 * `@/ui/chart` refuses to draw a breakdown that is almost all "not recorded"
 * and says how much of it is missing; it cannot say *why*, because that is a
 * fact about this college's import rather than about charts. Without the why,
 * the reader is told a field is blank and has nowhere to go with it.
 *
 * Verified on the live database: `remuneration_category` is set on 19 of
 * 3,227 filed claims, and `base_amount`, `qf_amount` and `author_point` are
 * set on the same 19.
 */
const GAP_WHY: Record<string, string> = {
  category:
    "Almost every claim on this record was created by the ERP rebuild, which writes rows " +
    "straight in at Paid carrying none of the working — no base amount, no quality factor, " +
    "no author point, and therefore no category. The handful that have one were filed " +
    "through this system and priced by it.",
}

/**
 * Whether the year breakdown is really a picture of the import's reach.
 *
 * The default report opens on department and year, and the year trend drawn
 * straight off this record is a hockey stick: one paper in 2019, 140 in 2023,
 * then better than a thousand a year. Read as output that is what it looks
 * like — a college that started publishing in 2024. It is not. It is the year
 * the import stops reaching back, and the same `isComparable` test the trends
 * service uses is what tells the two apart.
 *
 * Only ever a sentence. The counts are real and the chart is the right shape
 * for them; what is wrong is the conclusion a reader draws from the left-hand
 * end, and that is fixed with words rather than by hiding the years.
 */
function importReachNote(points: Point[]): string | null {
  const years = points
    .filter((p) => /^\d{4}$/.test(p.key))
    .sort((a, b) => Number(a.key) - Number(b.key))
  if (years.length < 4) return null
  const recent = years.slice(-3)
  const prior = years.slice(-6, -3)
  if (prior.length === 0) return null
  const sum = (rows: Point[]) => rows.reduce((n, r) => n + r.count, 0)
  const recentTotal = sum(recent)
  const priorTotal = sum(prior)
  if (isComparable(recentTotal, priorTotal)) return null
  return (
    `${priorTotal.toLocaleString("en-IN")} publications are recorded for ` +
    `${prior[0].key}–${prior[prior.length - 1].key} against ` +
    `${recentTotal.toLocaleString("en-IN")} for ${recent[0].key}–${recent[recent.length - 1].key}. ` +
    "The climb on the left of this chart is where the import stops reaching back, not where " +
    "the college started publishing, so the early years are not a baseline to measure growth " +
    "against."
  )
}

/** Which shape reads this dimension best. Years are a line because a year is
 *  a position on an axis; a handful of quartiles or stages are one bar
 *  because the question is what the whole is made of; everything else is a
 *  ranking, because that is what "top departments" means. */
function shapeOf(key: string): "trend" | "mix" | "ranked" {
  if (key === "year") return "trend"
  if (key === "quartile" || key === "status" || key === "engineering") return "mix"
  return "ranked"
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function ReportBuilder() {
  const { me } = useAuth()
  const allowed = can(me?.role).viewReports

  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()

  const dimensions = searchParams.get("dimensions") || DEFAULT_DIMENSIONS
  const year = searchParams.get("year") ?? ""
  const department = searchParams.get("department") ?? ""
  const measure: Measure = searchParams.get("measure") === "amount" ? "amount" : "count"
  const view: View = searchParams.get("view") === "table" ? "table" : "bars"

  const chosen = useMemo(() => dimensions.split(",").filter(Boolean), [dimensions])
  const drill = useMemo<Drill | null>(() => {
    const raw = searchParams.get("sheet")
    if (!raw) return null
    try {
      return JSON.parse(raw) as Drill
    } catch {
      return null
    }
  }, [searchParams])

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      // Changing what is on screen closes whatever was opened on top of the
      // old figures — the rows behind a bar that no longer exists are not an
      // answer to anything.
      if (key !== "sheet") next.delete("sheet")
      return next
    })
  }

  function clearFilters() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete("year")
      next.delete("department")
      next.delete("sheet")
      return next
    })
  }

  function toggleDimension(key: string) {
    const next = chosen.includes(key) ? chosen.filter((d) => d !== key) : [...chosen, key]
    // Never zero: the server refuses an empty breakdown, and a screen that
    // lets you reach a state the server rejects is a screen that breaks.
    setParam("dimensions", next.length ? next.join(",") : key)
  }

  /** A link that stays on this page: the report underneath is not re-fetched,
   *  not re-mounted and not scrolled, so closing the sheet returns the reader
   *  to the figure they clicked rather than to the top of a rebuilt page. */
  function drillHref(d: Drill): string {
    const next = new URLSearchParams(searchParams)
    next.set("sheet", JSON.stringify(d))
    return `${location.pathname}?${next.toString()}`
  }

  const query = new URLSearchParams({ dimensions, limit: "100" })
  if (year) query.set("year", year)
  if (department) query.set("department", department)

  const { data, isLoading, isError, error, refetch } = useApi<BuildPayload>(
    ["reports", "build", dimensions, year, department],
    `/api/reports/build?${query.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const scopeQuery = new URLSearchParams({ limit: "1" })
  if (year) scopeQuery.set("year", year)
  if (department) scopeQuery.set("department", department)
  const scope = useApi<ScopeTotals>(
    ["reports", "scope", year, department],
    `/api/reports/search?${scopeQuery.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments", {
    enabled: allowed,
  })

  // Only when a subject-area breakdown is on screen, because the denominator
  // it supplies is only about that breakdown — and it costs a full pass over
  // the claims to compute.
  const wantsAreas = allowed && chosen.includes("area")
  const areaQuery = new URLSearchParams({ limit: "1" })
  if (year) areaQuery.set("year", year)
  if (department) areaQuery.set("department", department)
  const areas = useApi<AreaCoverage>(
    ["reports", "areas", "coverage", year, department],
    `/api/reports/areas?${areaQuery.toString()}`,
    { enabled: wantsAreas, placeholderData: (prev) => prev }
  )

  const drillKey = searchParams.get("sheet") ?? ""
  const drillParams = new URLSearchParams({ ...drill?.filters, limit: "200" })
  const drillQuery = useApi<SearchPayload>(
    ["reports", "build-drill", drillKey],
    `/api/reports/search?${drillParams.toString()}`,
    { enabled: !!drill }
  )

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="Reports are college-wide. A head of department sees their own department's publications instead."
        />
      </div>
    )
  }

  // The download carries the same filters and the same breakdowns as the
  // screen, because it is literally the same request with a format on it.
  const downloadQuery = new URLSearchParams(query)
  downloadQuery.delete("limit")

  const yearOptions: ComboboxOption[] = [
    { value: "", label: "All years on record" },
    ...(data?.years ?? []).map((y) => ({ value: String(y), label: String(y) })),
  ]
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "Every department" },
    ...(departments.data ?? []).map((d) => ({ value: d, label: d })),
  ]

  const filtered = Boolean(year) || Boolean(department)
  const nothingMatches = Boolean(data) && (data?.tables ?? []).every((t) => t.rows.length === 0)
  const coverage = areas.data?.coverage

  const scopeFilters: Record<string, string> = {}
  if (year) scopeFilters.year = year
  if (department) scopeFilters.department = department
  const scopeNote = filtered
    ? `Within ${[year, department].filter(Boolean).join(" · ")}`
    : undefined

  return (
    <div className="page space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <PageTitle>Build a report</PageTitle>
          <Sub className="mt-1">
            Choose what to break the figures down by. The report is on this page; the file is
            the same thing in an envelope.
          </Sub>
        </div>

        {/* Secondary by placement and by weight: the report is already on
            screen, so these are for taking it somewhere else. */}
        <div className="min-w-0">
          <ColumnLabel className="mb-1 block">Also download as</ColumnLabel>
          <div className="flex flex-wrap gap-1">
            {FORMATS.map((fmt) => (
              <Button key={fmt.key} kind="quiet" size="sm" asChild>
                <a href={`/api/reports/build?${downloadQuery.toString()}&fmt=${fmt.key}`} download>
                  {fmt.key === "xlsx" && <Download />}
                  {fmt.label}
                </a>
              </Button>
            ))}
          </div>
        </div>
      </header>

      {/* ---- what to break it down by ---- */}
      <section className="space-y-2">
        <ColumnLabel className="block">Break down by</ColumnLabel>
        {data ? (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Break down by">
            {data.available.map((d) => (
              <Chip
                key={d.key}
                active={chosen.includes(d.key)}
                onClick={() => toggleDimension(d.key)}
              >
                {d.label}
              </Chip>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {[6, 8, 5, 7, 6, 9].map((w, i) => (
              <Skeleton key={i} className="h-7" style={{ width: `${w}rem` }} />
            ))}
          </div>
        )}
      </section>

      {/* ---- filters and presentation ---- */}
      <div className="flex flex-wrap items-end gap-3 border-y border-line py-3">
        <div>
          <ColumnLabel className="mb-1 block">Publication year</ColumnLabel>
          <Combobox
            value={year}
            onChange={(v) => setParam("year", v)}
            options={yearOptions}
            aria-label="Publication year"
            className="w-44"
          />
        </div>
        <div>
          <ColumnLabel className="mb-1 block">Department</ColumnLabel>
          <Combobox
            value={department}
            onChange={(v) => setParam("department", v)}
            options={departmentOptions}
            placeholder={departments.isLoading ? "Loading…" : "Every department"}
            disabled={departments.isLoading}
            aria-label="Department"
            className="w-52"
          />
        </div>
        <div>
          <ColumnLabel className="mb-1 block">Measure</ColumnLabel>
          <div className="flex gap-1">
            <Chip active={measure === "count"} onClick={() => setParam("measure", "count")}>
              Publications
            </Chip>
            <Chip active={measure === "amount"} onClick={() => setParam("measure", "amount")}>
              Amount
            </Chip>
          </div>
        </div>
        <div>
          <ColumnLabel className="mb-1 block">As</ColumnLabel>
          <div className="flex gap-1">
            <Chip active={view === "bars"} onClick={() => setParam("view", "bars")}>
              <BarChart3 className="size-3.5" aria-hidden />
              Chart
            </Chip>
            <Chip active={view === "table"} onClick={() => setParam("view", "table")}>
              <Table2 className="size-3.5" aria-hidden />
              Table
            </Chip>
          </div>
        </div>
      </div>

      {/* ---- what is currently narrowing the figures, and how to undo it ---- */}
      {filtered && (
        <div className="flex flex-wrap items-center gap-2">
          <Meta>Narrowed to</Meta>
          {year && (
            <RemoveChip label={`Year ${year}`} onRemove={() => setParam("year", "")} />
          )}
          {department && (
            <RemoveChip label={department} onRemove={() => setParam("department", "")} />
          )}
          <Button kind="quiet" size="sm" onClick={clearFilters}>
            Clear all
          </Button>
        </div>
      )}

      {/* ---- the answer, before any breakdown of it ---- */}
      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
        <Headline
          label="Publications in scope"
          value={scope.data ? scope.data.total.toLocaleString("en-IN") : "—"}
          hint={
            filtered
              ? "Everything matching the filters above, excluding drafts"
              : "Everything filed and past draft, all years, every department"
          }
          loading={scope.isLoading && !scope.data}
        />
        <Headline
          label="Paid and committed"
          value={scope.data ? money(scope.data.total_amount) : "—"}
          hint="Every claim in scope, settled or still travelling. Each paper counted once."
          loading={scope.isLoading && !scope.data}
        />
      </section>

      {scope.isError && (
        <InlineError
          message="Could not total the publications in scope. The breakdowns below are unaffected."
          onRetry={() => scope.refetch()}
        />
      )}

      {data?.subtitle && <Meta className="block">{data.subtitle}</Meta>}

      {isLoading && !data ? (
        <BuilderSkeleton />
      ) : isError ? (
        <ErrorState
          title="Could not build that report"
          message={
            error?.status === 403
              ? "Not allowed. Reports are open to the office, the Principal, the Director and Finance."
              : error?.message || "The server did not answer. Nothing has been lost."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : nothingMatches ? (
        <EmptyState
          title={filtered ? "Nothing matches these filters" : "Nothing recorded yet"}
          message={
            filtered
              ? "No publication falls under this year and department. Widen one of them and the figures come back."
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
        <div className="space-y-10">
          {(data?.tables ?? []).map((table) => (
            <Breakdown
              key={table.key}
              table={table}
              measure={measure}
              view={view}
              coverage={table.key === "area" ? coverage : undefined}
              scopeFilters={scopeFilters}
              scopeNote={scopeNote}
              drillHref={drillHref}
            />
          ))}
        </div>
      )}

      <Sheet open={!!drill} onOpenChange={(open) => !open && setParam("sheet", "")}>
        <SheetContent>
          {drill && (
            <>
              <SheetHeader>
                <SheetTitle>{drill.label}</SheetTitle>
                <SheetDescription>
                  {drillQuery.data
                    ? `${drillQuery.data.total.toLocaleString("en-IN")} publication${
                        drillQuery.data.total === 1 ? "" : "s"
                      } · ${money(drillQuery.data.total_amount)}`
                    : "Loading…"}
                  {drill.note ? ` · ${drill.note}` : ""}
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
                  <>
                    <ul className="divide-y divide-line">
                      {drillQuery.data.results.map((c) => (
                        <ClaimRow key={c.id} claim={c} />
                      ))}
                    </ul>
                    {drillQuery.data.results.length < drillQuery.data.total && (
                      <p className="mt-3 text-sm text-fg-muted">
                        Showing the first{" "}
                        {drillQuery.data.results.length.toLocaleString("en-IN")} of{" "}
                        {drillQuery.data.total.toLocaleString("en-IN")}. Narrow a filter above,
                        or download, to see the rest.
                      </p>
                    )}
                  </>
                ) : (
                  <EmptyState
                    title="Nothing matches"
                    message="No publication falls under this row once the filters above are applied too."
                  />
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
/* One breakdown                                                             */
/* ------------------------------------------------------------------------ */

function Breakdown({
  table,
  measure,
  view,
  coverage,
  scopeFilters,
  scopeNote,
  drillHref,
}: {
  table: BuiltTable
  measure: Measure
  view: View
  coverage?: AreaCoverage["coverage"]
  scopeFilters: Record<string, string>
  scopeNote?: string
  drillHref: (d: Drill) => string
}) {
  // Money is not a quantity on an overlapping dimension, so the chart is not
  // offered the choice. Drawing 12.6 crore of subject-area "spend" against
  // 2.8 crore of actual payouts is a picture of an error, and a caption under
  // it does not undo the shape the eye already took in.
  const drawn: Measure = table.overlapping ? "count" : measure
  const unit = drawn === "amount" ? "money" : "count"

  const points = table.rows.map((r) => {
    const param = DRILL_PARAM[table.key]
    const blank = BLANK_LABELS.has(r.key)
    const linkable = Boolean(param) && (!blank || BLANK_FILTERABLE.has(table.key))
    // The status column stores the raw enum, so "PRINCIPAL_APPROVED" is what
    // a bar would be labelled without this.
    const label = table.key === "status" ? stageOf(r.key).label : r.key
    return {
      key: r.key,
      label,
      count: r.count,
      // Withheld on an overlapping dimension so the numbers table under the
      // chart cannot offer a money column somebody would then add up.
      amount: table.overlapping ? undefined : r.amount,
      // The row's own value wins over the page filter of the same name, which
      // is what "click the 2023 bar on a report already narrowed to 2023"
      // should mean and also what it should mean when they differ.
      to: linkable
        ? drillHref({
            label,
            note: scopeNote,
            filters: { ...scopeFilters, [param]: r.key },
          })
        : undefined,
    }
  })

  const shape = shapeOf(table.key)
  const gap = isMostlyMissing(points)
  const reach = table.key === "year" ? importReachNote(points) : null
  const countWord = table.overlapping ? "appearances" : "publications"
  // The chart's own heading names the quantity, because the measure toggle is
  // at the top of a long page and a reader who has scrolled past it otherwise
  // has no way to tell rupees from papers.
  const chartTitle = table.overlapping
    ? "Publications, counted once per row"
    : drawn === "amount"
      ? "Amount paid"
      : "Publications"

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <SectionTitle>{table.label}</SectionTitle>
        <Meta className="tabular">
          {table.row_count.toLocaleString("en-IN")} rows ·{" "}
          {table.totals.count.toLocaleString("en-IN")} {countWord}
          {!table.overlapping && table.totals.amount != null
            ? ` · ${money(table.totals.amount)}`
            : ""}
        </Meta>
      </div>

      {table.overlapping && (
        <Callout tone="caution" title="Counts only — one paper can sit in several rows here">
          A paper spanning several {table.label.toLowerCase()}s is counted under each, so these
          rows add to more than the number of papers and the amounts cannot be added at all —
          the same rupee would be counted once per row. The chart therefore draws counts
          whichever measure is selected. Each row's own amount is real and is in the table view
          and the download; what does not exist, on screen or in the file, is a total.
        </Callout>
      )}

      {coverage && (
        <Callout tone="info" title="This describes the papers we could classify, not all of them">
          Subject areas come from the journal, and only{" "}
          {coverage.classified.toLocaleString("en-IN")} of{" "}
          {coverage.total.toLocaleString("en-IN")} publications in scope (
          {Math.round(coverage.fraction * 100)}%) sit in a journal we could match. The other{" "}
          {coverage.unclassified.toLocaleString("en-IN")} are absent from every row below rather
          than spread across them.
        </Callout>
      )}

      {reach && (
        <Callout tone="caution" title="The early years are the edge of the import, not a baseline">
          {reach}
        </Callout>
      )}

      {/* The chart shells refuse a near-empty dimension on their own, but the
          table view goes round them — and a table whose first row is "Not
          recorded 3,208" still invites a reader to compare the four rows under
          it as though they were a breakdown of the whole. Same sentence, said
          in the one view that would not otherwise get it. */}
      {gap && view === "table" && (
        <Callout tone="caution" title="Almost nothing in scope has this recorded">
          These rows are real, but they describe a small remainder rather than the publications
          in scope, and the total below is mostly one row. {GAP_WHY[table.key] ?? ""}
        </Callout>
      )}

      {table.truncated > 0 && (
        <Meta className="block">
          The {table.rows.length.toLocaleString("en-IN")} largest are shown.{" "}
          {table.truncated.toLocaleString("en-IN")} smaller rows are in the download.
        </Meta>
      )}

      {table.rows.length === 0 ? (
        <p className="border-y border-line py-10 text-center text-sm text-fg-muted">
          No publication in scope has a {table.label.toLowerCase()} recorded.
        </p>
      ) : view === "table" ? (
        <Rows table={table} />
      ) : shape === "trend" ? (
        <Trend
          title={chartTitle}
          dimension={table.label}
          unit={unit}
          points={points}
          gapWhy={GAP_WHY[table.key]}
        />
      ) : shape === "mix" ? (
        <MixBar
          title={chartTitle}
          dimension={table.label}
          unit={unit}
          points={points}
          gapWhy={GAP_WHY[table.key]}
        />
      ) : (
        <RankedBars
          title={chartTitle}
          dimension={table.label}
          unit={unit}
          points={points}
          limit={12}
          gapWhy={GAP_WHY[table.key]}
        />
      )}
    </section>
  )
}

/** Every chart is also a table, because a bar cannot be read to the rupee. */
function Rows({ table }: { table: BuiltTable }) {
  return (
    <TableScroller minWidth="34rem" maxHeight="min(32rem, 60vh)">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className={stickyHeadCell}>
              <ColumnLabel>{table.label}</ColumnLabel>
            </th>
            <th scope="col" className={cn(stickyHeadCell, "w-32 text-right")}>
              <ColumnLabel>Publications</ColumnLabel>
            </th>
            <th scope="col" className={cn(stickyHeadCell, "w-40 text-right")}>
              <ColumnLabel>Amount</ColumnLabel>
            </th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.key} className="row border-b border-line last:border-b-0">
              <td className="px-3 py-2 align-middle">{r.key}</td>
              <td className="px-3 py-2 text-right align-middle tabular">
                {r.count.toLocaleString("en-IN")}
              </td>
              <td className="px-3 py-2 text-right align-middle tabular">{money(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-edge font-medium">
            <td className="px-3 py-2 align-middle">
              {table.overlapping ? "Total appearances" : "Total"}
            </td>
            <td className="px-3 py-2 text-right align-middle tabular">
              {table.totals.count.toLocaleString("en-IN")}
            </td>
            {/* Never an empty cell here: a blank reads as a bug, and a number
                would be a lie. The sentence is the honest third option. */}
            <td className="px-3 py-2 text-right align-middle">
              {table.overlapping || table.totals.amount == null ? (
                <span className="text-sm font-normal text-fg-muted">
                  Not summable — a paper counts under every row it belongs to
                </span>
              ) : (
                <span className="tabular">{money(table.totals.amount)}</span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </TableScroller>
  )
}

/* ------------------------------------------------------------------------ */
/* Small pieces                                                              */
/* ------------------------------------------------------------------------ */

/** One row inside the drill-down sheet: the paper, who filed it, what it was
 *  worth and where in the chain it sits. */
function ClaimRow({ claim: c }: { claim: SearchClaim }) {
  return (
    <li className="row">
      <a href={`/papers/${c.id}`} className="block px-1 py-3">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base">{c.paper_title || "Untitled"}</span>
            <Meta className="mt-0.5 block truncate">
              {[c.owner_name, c.owner_department, c.journal_title, c.publication_year]
                .filter(Boolean)
                .join(" · ")}
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

/** The figure a reader's eye should land on first, with the sentence that
 *  says what it counts — a bare number at this size gets quoted, and a
 *  quoted number with no scope on it is how a meeting goes wrong. */
function Headline({
  label,
  value,
  hint,
  loading,
}: {
  label: string
  value: string
  hint: string
  loading?: boolean
}) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      {loading ? (
        <Skeleton className="mt-1 h-9 w-32" />
      ) : (
        <p className="mt-1 text-3xl font-semibold tabular">{value}</p>
      )}
      <p className="mt-1 text-sm text-fg-muted">{hint}</p>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-sm",
        "transition-colors duration-[var(--dur-1)] ease-out",
        active ? "bg-selected font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      )}
    >
      {children}
    </button>
  )
}

/** An active filter, with the way out of it attached. A filter you can set
 *  from one control and can only unset by finding that same control again is
 *  how a reader ends up believing the college published forty papers. */
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

function BuilderSkeleton() {
  return (
    <div className="space-y-10">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <SkeletonRows rows={6} rowHeight={28} />
        </div>
      ))}
    </div>
  )
}
