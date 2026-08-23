"use client"

import { useMemo, useState } from "react"
import { Link, useLocation } from "react-router-dom"

import { DataGap, isAbsentLabel, isMostlyMissing } from "@/components/data-gap"
import { AgeingPanel, BreadthPanel, YearOnYearPanel } from "@/components/report-cuts"

import { useUrlState } from "@/lib/url-state"
import { Download } from "lucide-react"

import { EmptyState, ErrorState, PageHeader, Section, StatStrip } from "@/components/layout/page"
import { Money, formatMoney, monthLabel } from "@/components/ticket-ui"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { API_BASE } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
import {
  MixBar,
  PipelineChart,
  RankedBars,
  type Stage,
  TrendChart,
} from "@/components/charts"

type Row = {
  key: string
  count: number
  amount: number
  label?: string
  /** Present on the people lists, so a name can open that person. */
  id?: string
}

type ReportData = {
  totals: {
    publications: number
    count_only: number
    paid_claims: number
    paid_amount: number
    awaiting_payment: number
    committed_amount: number
  }
  by_department: Row[]
  by_quartile: Row[]
  by_category: Row[]
  by_engineering: Row[]
  by_status: Row[]
  by_month: Row[]
  pipeline?: Stage[]
  years: number[]
  /** Months the college has settled in, newest first, as "2026-03". */
  payout_months?: string[]
  by_year?: Row[]
  by_type?: Row[]
  by_indexing?: Row[]
  by_designation?: Row[]
  /** Long tails, cut to what a chart can carry, with the remainder declared. */
  ageing?: { rows: { key: string; count: number; amount: number }[]; oldest_days: number | null; total: number }
  breadth?: { key: string; count: number; people: number; per_person: number; top_ten_share: number }[]
  year_on_year?: {
    this_year: number
    last_year: number
    this_year_is_partial: boolean
    months_elapsed: number
    rows: { key: string; count: number; previous: number; change: number; percent: number | null }[]
  }
  by_journal?: Capped
  top_by_publications?: Capped
  top_by_amount?: Capped
  per_paper?: {
    count: number
    mean: number
    median: number
    min: number
    max: number
  }
}

const ALL = "__all__"

/** Where a person's record lives, under whichever portal the reader is in. */
function recordBase(pathname: string): string {
  return `/${pathname.split("/")[1] || "admin"}/faculty`
}

/**
 * A breakdown that reads counts and money side by side.
 *
 * The scheme records every publication but pays only some, so "how much did we
 * publish" and "how much did we spend" are different questions. Showing one
 * without the other is what sent people to the ledger export to pivot by hand.
 */
function Breakdown({
  title,
  rows,
  showAmount = true,
  empty = "Nothing recorded yet",
  onPick,
  linkFor,
  actionHint,
}: {
  title: string
  rows: Row[]
  showAmount?: boolean
  empty?: string
  /** Clicking a row narrows the page to it. */
  onPick?: (row: Row) => void
  /** Clicking a row opens something of its own. */
  linkFor?: (row: Row) => string | null
  actionHint?: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  const interactive = !!onPick || !!linkFor
  return (
    <Section title={title} description={interactive ? actionHint : undefined}>
      <div className="overflow-hidden surface-card">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const to = linkFor?.(r) || null
              const label = r.label || r.key
              // A row that navigates and a row that does nothing must not look
              // the same, so only the actionable ones carry the affordance.
              const inner = (
                <>
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={cn(
                      "min-w-0 truncate text-sm",
                      to || onPick ? "text-primary" : "text-foreground"
                    )}
                    title={label}
                  >
                    {label}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-3 text-sm tabular-nums">
                    <span className="font-medium">{r.count}</span>
                    {showAmount ? (
                      <span className="w-24 text-right text-muted-foreground">
                        <Money value={r.amount} />
                      </span>
                    ) : null}
                  </span>
                </div>
                {/* Proportion at a glance — the ranking matters more than the bar. */}
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/60"
                    style={{ width: `${Math.round((r.count / max) * 100)}%` }}
                  />
                </div>
                </>
              )
              if (to) {
                return (
                  <li key={r.key}>
                    <Link
                      to={to}
                      className="interactive block px-4 py-2.5 hover:bg-accent/40"
                    >
                      {inner}
                    </Link>
                  </li>
                )
              }
              if (onPick) {
                return (
                  <li key={r.key}>
                    <button
                      type="button"
                      onClick={() => onPick(r)}
                      className="interactive block w-full px-4 py-2.5 text-left hover:bg-accent/40"
                    >
                      {inner}
                    </button>
                  </li>
                )
              }
              return (
                <li key={r.key} className="px-4 py-2.5">
                  {inner}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Section>
  )
}

/** A top-N slice that knows what it left out. */
type Capped = {
  rows: Row[]
  hidden: number
  hidden_count: number
  hidden_amount: number
}

/** What a cut-off list is not showing, said plainly under it. */
function HiddenTail({ cap, unit }: { cap?: Capped; unit: "count" | "money" }) {
  if (!cap?.hidden) return null
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {cap.hidden.toLocaleString()} more not shown
      {unit === "count"
        ? ` · ${cap.hidden_count.toLocaleString()} publications between them`
        : ` · ${formatMoney(cap.hidden_amount)} between them`}
    </p>
  )
}

/** "2026-03" reads as a code; "March 2026" reads as a month. */
export function ReportsPage() {
  const { pathname } = useLocation()
  const base = recordBase(pathname)
  const queryBase = `/${pathname.split("/")[1] || "admin"}/query`
  const journalBase = `/${pathname.split("/")[1] || "admin"}/journal`
  // A report nobody can send is a report somebody screenshots.
  const [state, setState] = useUrlState({
    year: ALL,
    department: ALL,
    month: ALL,
  })
  const { year, department, month } = state
  const setYear = (v: string) => setState({ year: v })
  const setDepartment = (v: string) => setState({ department: v })
  const setMonth = (v: string) => setState({ month: v })

  const query = useMemo(() => {
    const qs = new URLSearchParams()
    if (year !== ALL) qs.set("year", year)
    if (department !== ALL) qs.set("department", department)
    if (month !== ALL) qs.set("month", month)
    const s = qs.toString()
    return s ? `?${s}` : ""
  }, [year, department, month])

  const { data, isLoading: loading, isError, refetch } = useApiQuery<ReportData>(
    ["reports", year, department, month],
    `/api/reports${query}`
  )
  const { data: departments = [] } = useApiQuery<string[]>(
    ["meta", "departments"],
    "/api/meta/departments"
  )

  const t = data?.totals

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="Publication output and payouts across the college"
        actions={
          <div className="flex gap-2">
            <Button asChild variant="secondary">
              <a href={`${API_BASE}/api/reports/export${query}`}>
                <Download className="size-4" />
                CSV
              </a>
            </Button>
            <Button asChild variant="secondary">
              {/* A real workbook — the office re-imported the CSV into Excel
                  by hand every month, mangling ISSNs into dates on the way. */}
              <a
                href={`${API_BASE}/api/reports/export${query}${query ? "&" : "?"}fmt=xlsx`}
              >
                <Download className="size-4" />
                Excel
              </a>
            </Button>
          </div>
        }
      />


      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="rep-month" className="text-xs">
            Payout month
          </Label>
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger id="rep-month" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All months</SelectItem>
              {/* Only months the college actually settled in: a full calendar
                  would be mostly empty options. */}
              {(data?.payout_months || []).map((m) => (
                <SelectItem key={m} value={m}>
                  {monthLabel(m, "long")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="rep-year" className="text-xs">
            Publication year
          </Label>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger id="rep-year" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All years</SelectItem>
              {(data?.years || []).map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rep-dept" className="text-xs">
            Department
          </Label>
          <Select value={department} onValueChange={setDepartment}>
            <SelectTrigger id="rep-dept" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-20 w-full rounded-[var(--radius)]" />
          <Skeleton className="h-64 w-full rounded-[var(--radius)]" />
        </div>
      ) : isError ? (
        <ErrorState
          title="Could not load reports"
          description="The server did not respond."
          onRetry={() => refetch()}
        />
      ) : !data ? (
        <EmptyState title="No report data" description="Nothing has been filed yet." />
      ) : (
        <>
          <Section title="Totals">
            <StatStrip
              items={[
                { label: "Publications", value: t?.publications ?? 0 },
                { label: "Count only", value: t?.count_only ?? 0 },
                { label: "Paid claims", value: t?.paid_claims ?? 0 },
                { label: "Awaiting payment", value: t?.awaiting_payment ?? 0 },
              ]}
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {[
                { label: "Paid to date", value: t?.paid_amount ?? 0, tone: "success" },
                { label: "Cleared, not yet paid", value: t?.committed_amount ?? 0, tone: "warning" },
              ].map((card) => (
                <div
                  key={card.label}
                  className={cn(
                    "rounded-[var(--radius)] border px-5 py-4",
                    card.tone === "success"
                      ? "border-success/25 bg-surface-success/40"
                      : "border-warning/30 bg-surface-warning/40"
                  )}
                >
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {card.label}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                    <Money value={card.value} />
                  </p>
                </div>
              ))}
            </div>
          </Section>


          {data.per_paper?.count ? (
            <Section
              title="What one paper is worth"
              description="Across every settled payment in this view"
            >
              <StatStrip
                items={[
                  { label: "Median", value: formatMoney(data.per_paper.median) },
                  { label: "Mean", value: formatMoney(data.per_paper.mean) },
                  { label: "Largest", value: formatMoney(data.per_paper.max) },
                  { label: "Smallest", value: formatMoney(data.per_paper.min) },
                ]}
              />
              {/* The scheme pays a Q1 paper many times what it pays a Q4 one,
                  so the mean sits above almost every actual payment. Saying so
                  is cheaper than watching somebody budget on it. */}
              <p className="mt-2 text-xs text-muted-foreground">
                The median is the typical claim. A few large payments pull the mean
                well above it, so the mean describes the total, not a paper.
              </p>
            </Section>
          ) : null}
          {/* The shapes first -- a reader looking for trend, concentration or a
              queue should not have to reconstruct it from a list. The lists stay
              underneath, because a specific number is a different question and
              a chart is a poor way to answer it. */}
          <Section title="Trend">
            <div className="grid gap-6">
              <TrendChart
                title="Paid by month"
                caption={`${data.by_month.length} months of settled payments`}
                data={data.by_month}
              />
              {data.by_year?.length ? (
                <TrendChart
                  title="Publications by year"
                  caption="How many papers, by the year they were published"
                  data={data.by_year}
                  unit="year"
                  // Counting papers, not rupees: the heading promises
                  // publications and the axis has to agree with it.
                  measure="count"
                />
              ) : null}
            </div>
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <RankedBars
              title="Where the money goes"
              caption="Departments by amount paid, largest first — open one"
              data={data.by_department}
              linkFor={(d) => `${queryBase}?department=${encodeURIComponent(d.key)}`}
            />
            <MixBar
              title="By journal quartile"
              dimension="Quartile"
              caption="Share of spend by where the journal ranks"
              data={data.by_quartile}
            />
            {data.pipeline?.length ? (
              <PipelineChart
                title="Pipeline"
                caption="Where claims are sitting right now"
                stages={data.pipeline}
              />
            ) : null}
            <RankedBars
              title="Publication volume"
              caption="Departments by number of publications, largest first — open one"
              data={data.by_department}
              unit="count"
              itemNoun="publication"
              linkFor={(d) => `${queryBase}?department=${encodeURIComponent(d.key)}`}
            />
            {data.by_type?.length ? (
              <RankedBars
                title="Kind of publication"
                dimension="Kind"
                itemNoun="paper"
                caption="Journal articles, conference proceedings, book chapters"
                data={data.by_type}
                unit="count"
                linkFor={(d) => `${queryBase}?publication_type=${encodeURIComponent(d.key)}`}
              />
            ) : null}
            {data.by_indexing?.length ? (
              <div>
                <RankedBars
                  title="Where the journals are indexed"
                  dimension="Index"
                  itemNoun="paper"
                  caption="A journal is often listed in several places, so a paper counts under each"
                  data={data.by_indexing}
                  unit="count"
                  linkFor={(d) => `${queryBase}?indexing=${encodeURIComponent(d.key)}`}
                />
              </div>
            ) : null}
            {/* Drawn only while it says something. The ERP import never
                carried the category, so on historical data this is one slice
                reading "99.8% Not calculated" -- a gap in the records, not a
                finding, and it is more useful stated as one. */}
            {data.by_category?.length ? (
              isMostlyMissing(data.by_category) ? (
                <DataGap
                  title="Remuneration category"
                  rows={data.by_category}
                  what="The rate band the policy applied"
                  why="The ERP import did not carry this field, so it is only recorded on claims filed since."
                />
              ) : (
                <MixBar
                  title="By remuneration category"
                  caption="Share of spend by the rate the policy applied"
                  data={data.by_category}
                  dimension="Category"
                />
              )
            ) : null}
            {data.by_engineering?.length ? (
              <MixBar
                title="Engineering / Non-Engineering"
                caption="The classification the policy pays on"
                data={data.by_engineering}
                dimension="Classification"
              />
            ) : null}
            {data.by_designation?.length ? (
              <RankedBars
                title="By designation"
                dimension="Designation"
                itemNoun="publication"
                linkFor={(d) => `${queryBase}?designation=${encodeURIComponent(d.key)}`}
                caption="Who is publishing, by grade"
                data={data.by_designation}
                unit="count"
              />
            ) : null}
          </div>

          {/* How it is going, as opposed to how much there is. These three
              answer the questions a review meeting opens with, and none of
              them could be read off the page before. */}
          <Section
            title="How it is going"
            description="Whether anything is stuck, who is carrying the output, and which way it is moving"
          >
            <div className="grid gap-6 lg:grid-cols-2">
              {data.ageing ? (
                <AgeingPanel
                  rows={data.ageing.rows}
                  total={data.ageing.total}
                  oldestDays={data.ageing.oldest_days}
                  queryBase={queryBase}
                />
              ) : null}
              {data.breadth?.length ? <BreadthPanel rows={data.breadth} /> : null}
              {data.year_on_year?.rows?.length ? (
                <div className="lg:col-span-2">
                  <YearOnYearPanel data={data.year_on_year} queryBase={queryBase} />
                </div>
              ) : null}
            </div>
          </Section>

          {data.by_journal?.rows?.length ? (
            <Section
              title="Journals and people"
              description="The long tails, cut to what a chart can carry"
            >
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <RankedBars
                    title="Most-used journals"
                    caption="By number of publications — open one for its record"
                    data={data.by_journal.rows}
                    unit="count"
                    dimension="Journal"
                    itemNoun="paper"
                    linkFor={(d) => `${journalBase}?title=${encodeURIComponent(d.key)}`}
                  />
                  <HiddenTail cap={data.by_journal} unit="count" />
                </div>
                <div>
                  <RankedBars
                    title="Most published"
                    dimension="Person"
                    itemNoun="paper"
                    linkFor={(d) => (d.id ? `${base}/${d.id}` : null)}
                    caption="Faculty by number of publications"
                    data={data.top_by_publications?.rows || []}
                    unit="count"
                  />
                  <HiddenTail cap={data.top_by_publications} unit="count" />
                </div>
                <div className="lg:col-span-2">
                  <RankedBars
                    title="Most paid"
                    dimension="Person"
                    linkFor={(d) => (d.id ? `${base}/${d.id}` : null)}
                    caption="Faculty by amount received, largest first"
                    data={data.top_by_amount?.rows || []}
                  />
                  <HiddenTail cap={data.top_by_amount} unit="money" />
                </div>
              </div>
            </Section>
          ) : null}

          {/* The charts above rank people; these open them. A name in a report
              is the start of a question, not the end of one. */}
          <Section
            title="Open a person"
            description="Every name here opens that person's full record"
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <Breakdown
                title="Most published"
                rows={data.top_by_publications?.rows || []}
                linkFor={(r) => (r.id ? `${base}/${r.id}` : null)}
                actionHint="Click a name for their publications, quartile mix and history"
              />
              <Breakdown
                title="Most paid"
                rows={data.top_by_amount?.rows || []}
                linkFor={(r) => (r.id ? `${base}/${r.id}` : null)}
                actionHint="Click a name for everything they have been paid"
              />
            </div>
          </Section>

          <Section
            title="Who is publishing"
            description="Exact numbers, where a chart only shows the shape"
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <Breakdown
                title="By department"
                rows={data.by_department}
                // Narrows this page rather than leaving it: every other figure
                // here then re-reads for that department, which is more than a
                // link to the query screen would give.
                onPick={(r) => setDepartment(r.key)}
                actionHint="Click a department to narrow this whole page to it"
              />
              <Breakdown
                title="By designation"
                rows={data.by_designation || []}
                linkFor={(r) => `${queryBase}?designation=${encodeURIComponent(r.key)}`}
                actionHint="Click a grade to see who published at it"
              />
            </div>
          </Section>

          <Section
            title="Where it is published"
            description="The journals and the indexes behind the figures above"
          >
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Each row opens the claims behind it, carrying the filter
                  through. A total nobody can open is a total nobody can
                  check. */}
              <Breakdown
                title="Most-used journals"
                rows={data.by_journal?.rows || []}
                // The journal's own record, not a text search for its name:
                // the record carries its ranking, its SNIP and everyone at
                // the college who publishes there, and a search for "Nature"
                // also matches every paper with the word in its title.
                linkFor={(r) => `${journalBase}?title=${encodeURIComponent(r.key)}`}
                actionHint="Click a journal for its ranking and who publishes there"
              />
              <Breakdown
                title="By indexing"
                rows={data.by_indexing || []}
                linkFor={(r) => `${queryBase}?indexing=${encodeURIComponent(r.key)}`}
                actionHint="Click an index to see what is listed there"
              />
              <Breakdown
                title="By quartile"
                rows={data.by_quartile}
                linkFor={(r) =>
                  /^Q[1-4]$/i.test(r.key)
                    ? `${queryBase}?quartile=${encodeURIComponent(r.key)}`
                    : null
                }
                actionHint="Click Q1–Q4 to see those papers"
              />
              <Breakdown
                title="By kind of publication"
                rows={data.by_type || []}
                linkFor={(r) => `${queryBase}?publication_type=${encodeURIComponent(r.key)}`}
                actionHint="Click a kind to list them"
              />
            </div>
          </Section>

          <Section
            title="When, and what it cost"
            description="The remaining figures, as lists"
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <Breakdown
                title="By year of publication"
                rows={data.by_year || []}
                // "Not stated" is not a year, and asking the server for one
                // would quietly return everything.
                linkFor={(r) => (/^\d{4}$/.test(r.key) ? `${queryBase}?year=${r.key}` : null)}
                actionHint="Click a year to list its publications"
              />
              <Breakdown
                title="By remuneration category"
                rows={data.by_category}
                linkFor={(r) =>
                  isAbsentLabel(r.key)
                    ? null
                    : `${queryBase}?category=${encodeURIComponent(r.key)}`
                }
                actionHint="Click a band to list what was paid at it"
              />
              <Breakdown
                title="Engineering / Non-Engineering"
                rows={data.by_engineering}
                showAmount={false}
                linkFor={(r) =>
                  isAbsentLabel(r.key)
                    ? null
                    : `${queryBase}?engineering_class=${encodeURIComponent(r.key)}`
                }
                actionHint="Click a class to list its publications"
              />
              <Breakdown
                title="By status"
                rows={data.by_status}
                showAmount={false}
                linkFor={(r) => `${queryBase}?status=${encodeURIComponent(r.key)}`}
                actionHint="Click a stage to see what is sitting at it"
              />
              <Breakdown
                title="Paid by month"
                rows={data.by_month}
                empty="No payments recorded yet"
                // The buckets are keyed "2026-08", which is what the filter
                // takes, while the row shows the month in words.
                linkFor={(r) => (/^\d{4}-\d{2}$/.test(r.key) ? `${queryBase}?month=${r.key}` : null)}
                actionHint="Click a month to list what was settled in it"
              />
            </div>
          </Section>
          {/* Last, deliberately: a file to take away is the end of a
              reading, not the start of one. */}
          <Section
            title="Accreditation pack"
            description="The NAAC and NIRF tables, in the columns those frameworks ask for"
          >
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild variant="secondary">
                <a
                  href={`${API_BASE}/api/reports/pack?fmt=xlsx${
                    year !== ALL ? `&year=${year}` : ""
                  }`}
                >
                  <Download className="size-4" />
                  {year === ALL ? "Download (all years)" : `Download ${year}`}
                </a>
              </Button>
              <p className="text-xs text-muted-foreground">
                NAAC 3.4.3 one row per teacher per paper, NIRF publication counts by year,
                department and faculty summaries, and a Notes sheet saying what each figure
                counts. Citation-based NIRF metrics are not included — no citation data is
                held here, and they have to come from Scopus directly.
              </p>
            </div>
          </Section>
        </>
      )}
    </div>
  )
}
