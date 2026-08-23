"use client"

import { useMemo, useState } from "react"

import { asNumber, useUrlState } from "@/lib/url-state"
import { Download, ExternalLink, Search } from "lucide-react"

import { MixBar, RankedBars, TrendChart } from "@/components/charts"
import { Callout } from "@/components/form/fields"
import { EmptyState, ErrorState, PageHeader, Section } from "@/components/layout/page"
import { LoadingPage, LoadingTable } from "@/components/loading"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Pager } from "@/components/ui/pagination"
import { DataTable } from "@/components/data-table"
import { JournalLink } from "@/components/journal-link"
import { PaperLink } from "@/components/paper-link"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { API_BASE } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * What a head of department needs, and nothing they should not have.
 *
 * A head is asked one set of questions — what is my department publishing,
 * where, who is carrying it, and who has published nothing this year — and
 * asked them in meetings, with a spreadsheet open. So the screen answers
 * those in that order, and every view downloads.
 *
 * No figure here is money. That is deliberate and enforced on the server:
 * remuneration is somebody's pay, and a head is not in the payment chain.
 * The ticket's stage is shown as progress ("Under review", "Completed")
 * rather than the workflow's own status, because "PAID" tells a head their
 * colleague was paid, which is not their business either.
 */

const PAGE = 50
const ALL = "__all__"

/** The server strips every money key, so a bucket is a count. */
type Bucket = { key: string; count: number }

type Person = {
  id: string
  name: string
  designation: string | null
  staff_id: string | null
  publications: number
  first_author: number
  q1: number
  active: boolean
}

type Overview = {
  department: string
  years_on_record: number[]
  year: number | null
  totals: {
    publications: number
    faculty_in_department: number
    faculty_who_published: number
    q1: number
    first_author: number
    under_review: number
  }
  by_year: Bucket[]
  by_quartile: Bucket[]
  by_type: Bucket[]
  by_journal: Bucket[]
  by_indexing: Bucket[]
  people: Person[]
}

type Publication = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  publication_year: number | null
  quartile: string | null
  snip: number | null
  indexing_level: string | null
  author_position: number | null
  total_authors: number | null
  owner_name: string
  owner_id: string
  doi: string | null
  scopus_url: string | null
  progress: string
}

const PROGRESS_TONE: Record<string, string> = {
  Completed: "bg-success/15 text-success",
  Approved: "bg-primary/15 text-primary",
  "Under review": "bg-warning/15 text-warning-foreground",
  "Sent back": "bg-destructive/15 text-destructive",
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function HodOverviewPage() {
  const [year, setYear] = useState(ALL)
  const query = year === ALL ? "" : `?year=${year}`
  const { data, isLoading, isError, refetch } = useApiQuery<Overview>(
    ["hod-overview", year],
    `/api/hod/overview${query}`
  )

  const silent = useMemo(
    () => (data?.people || []).filter((p) => p.active && p.publications === 0),
    [data]
  )

  if (isError) return <ErrorState onRetry={() => refetch()} />
  // A white screen for as long as the query takes reads as a broken page.
  if (isLoading || !data) return <LoadingPage />

  const t = data.totals
  const published = t.faculty_who_published
  const share = t.faculty_in_department
    ? Math.round((published / t.faculty_in_department) * 100)
    : 0

  return (
    <div className="space-y-6">
      <PageHeader
        title={data.department}
        subtitle="What your department has published"
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All years</SelectItem>
                {data.years_on_record.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button asChild variant="secondary">
              <a href={`${API_BASE}/api/hod/export?fmt=xlsx${year === ALL ? "" : `&year=${year}`}`}>
                <Download className="size-4" />
                Excel
              </a>
            </Button>
            <Button asChild variant="ghost">
              <a href={`${API_BASE}/api/hod/export?fmt=csv${year === ALL ? "" : `&year=${year}`}`}>
                CSV
              </a>
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Publications" value={String(t.publications)} />
        <Stat
          label="Q1 papers"
          value={String(t.q1)}
          hint={t.publications ? `${Math.round((t.q1 / t.publications) * 100)}% of output` : undefined}
        />
        <Stat
          label="First-author papers"
          value={String(t.first_author)}
          hint="Where a member of your department led"
        />
        <Stat
          label="Staff who published"
          value={`${published} of ${t.faculty_in_department}`}
          hint={`${share}% of the department`}
        />
      </div>

      {t.under_review ? (
        <Callout tone="info" title={`${t.under_review} still going through`}>
          Filed and not yet finished. They will appear in the totals above once they
          complete.
        </Callout>
      ) : null}

      {data.by_year.length > 1 ? (
        <TrendChart
          title="Publications by year"
          caption="By year of publication"
          data={data.by_year}
          unit="year"
          measure="count"
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <RankedBars
          title="Where the department publishes"
          dimension="Quartile"
          caption="By journal quartile"
          data={data.by_quartile}
          unit="count"
        itemNoun="publication"
        />
        <MixBar
          title="Quartile mix"
          dimension="Quartile"
          caption="Share of the department's output"
          data={data.by_quartile}
          measure="count"
        />
        {data.by_indexing.length ? (
          <RankedBars
            title="Where the journals are indexed"
            dimension="Index"
            caption="A journal is often listed in several places, so a paper counts under each"
            data={data.by_indexing}
            unit="count"
          itemNoun="publication"
          />
        ) : null}
        {data.by_type.length ? (
          <RankedBars
            title="Kind of publication"
            dimension="Kind"
            caption="Journal articles, conference proceedings, book chapters"
            data={data.by_type}
            unit="count"
          itemNoun="publication"
          />
        ) : null}
      </div>

      {data.by_journal.length ? (
        <RankedBars
          title="Most-used journals"
          dimension="Journal"
          caption="Where your department publishes most often"
          data={data.by_journal}
          unit="count"
        itemNoun="publication"
        />
      ) : null}

      <Section
        title="Your staff"
        description="Everybody in the department, most published first"
      >
        <DataTable
          rows={[...data.people].sort((a, b) => b.publications - a.publications)}
          getKey={(p) => p.id}
          minWidth="44rem"
          maxHeight="34rem"
          empty="Nobody on record in this department"
          columns={[
            {
              key: "name",
              header: "Name",
              className: "font-medium",
              cell: (p) => (
                <span className={cn(!p.active && "opacity-60")}>
                  {p.name}
                  {!p.active ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">(left)</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: "designation",
              header: "Designation",
              className: "text-muted-foreground",
              cell: (p) => p.designation || "—",
            },
            { key: "pubs", header: "Publications", align: "right", cell: (p) => p.publications },
            { key: "first", header: "First author", align: "right", cell: (p) => p.first_author },
            { key: "q1", header: "Q1", align: "right", cell: (p) => p.q1 },
          ]}
        />
        {silent.length ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {silent.length} member{silent.length === 1 ? " has" : "s have"} nothing filed
            {year === ALL ? " at all" : ` for ${year}`} — often the most useful line on
            this page.
          </p>
        ) : null}
      </Section>
    </div>
  )
}

export function HodPublicationsPage() {
  const [state, setState] = useUrlState({
    q: "",
    year: ALL,
    quartile: ALL,
    sort: "recent",
    offset: "0",
  })
  const { year, quartile, sort } = state
  const term = state.q
  const offset = asNumber(state.offset, 0)
  const [q, setQ] = useState(state.q)
  const setYear = (v: string) => setState({ year: v })
  const setQuartile = (v: string) => setState({ quartile: v })
  const setSort = (v: string) => setState({ sort: v })
  const setTerm = (v: string) => setState({ q: v })
  const setOffset = (v: number) => setState({ offset: String(v) })

  const { data: overview } = useApiQuery<Overview>(["hod-overview", ALL], "/api/hod/overview")

  const query = useMemo(() => {
    const p = new URLSearchParams({ sort, limit: String(PAGE), offset: String(offset) })
    if (term.trim()) p.set("q", term.trim())
    if (year !== ALL) p.set("year", year)
    if (quartile !== ALL) p.set("quartile", quartile)
    return p.toString()
  }, [term, year, quartile, sort, offset])

  const { data, isLoading, isError, refetch } = useApiQuery<{
    total: number
    department: string
    results: Publication[]
  }>(["hod-publications", query], `/api/hod/publications?${query}`)

  const filtersActive = !!(term || year !== ALL || quartile !== ALL)
  const clearFilters = () => {
    setQ("")
    setState({ q: "", year: ALL, quartile: ALL, offset: "0" })
  }

  const exportQuery = query.replace(/&?(limit|offset|sort)=[^&]*/g, "").replace(/^&/, "")

  return (
    <div className="space-y-5">
      <PageHeader
        title="Publications"
        subtitle={data?.department ? `Everything filed from ${data.department}` : undefined}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="secondary">
              <a href={`${API_BASE}/api/hod/export?fmt=xlsx&${exportQuery}`}>
                <Download className="size-4" />
                Excel
              </a>
            </Button>
            <Button asChild variant="ghost">
              <a href={`${API_BASE}/api/hod/export?fmt=csv&${exportQuery}`}>CSV</a>
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setTerm(q)
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="hod-q" className="text-xs">
              Search
            </Label>
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="hod-q"
                className="pl-9"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Title, journal, person"
              />
            </div>
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        <div className="space-y-1.5">
          <Label htmlFor="hod-year" className="text-xs">
            Year
          </Label>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger id="hod-year" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All years</SelectItem>
              {(overview?.years_on_record || []).map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="hod-quartile" className="text-xs">
            Quartile
          </Label>
          <Select value={quartile} onValueChange={setQuartile}>
            <SelectTrigger id="hod-quartile" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any</SelectItem>
              {["Q1", "Q2", "Q3", "Q4"].map((qt) => (
                <SelectItem key={qt} value={qt}>
                  {qt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="hod-sort" className="text-xs">
            Sort
          </Label>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger id="hod-sort" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Most recent</SelectItem>
              <SelectItem value="year">Year of publication</SelectItem>
              <SelectItem value="person">Person</SelectItem>
              <SelectItem value="journal">Journal</SelectItem>
              <SelectItem value="title">Title</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <LoadingTable rows={8} columns={7} caption="Loading publications…" />
      ) : !data || data.results.length === 0 ? (
        <EmptyState
          title="Nothing matches those filters"
          description={
            filtersActive
              ? "Nothing in your department matches all of them at once."
              : "Your department has nothing filed yet."
          }
          // A dead end is the one thing an empty screen must not be: the
          // reader filtered their way here and needs the way back.
          action={
            filtersActive ? (
              <Button variant="secondary" onClick={clearFilters}>
                Clear the filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {data.total.toLocaleString()} publication{data.total === 1 ? "" : "s"}
          </p>
          <DataTable
            rows={data.results}
            getKey={(p) => p.id}
            minWidth="62rem"
            maxHeight="40rem"
            empty="Nothing published yet"
            columns={[
              {
                key: "paper",
                header: "Paper",
                className: "max-w-[24rem]",
                cell: (p) => (
                  <>
                    <span className="block truncate font-medium">{p.paper_title}</span>
                    {/* The DOI leads, because it resolves for anybody. The
                        Scopus link needs a subscription the reader may not
                        have, and lands them on Scopus's front page if not. */}
                    <PaperLink doi={p.doi} scopusUrl={p.scopus_url} compact className="mt-0.5 block" />
                  </>
                ),
              },
              { key: "person", header: "Person", cell: (p) => p.owner_name },
              {
                key: "journal",
                header: "Journal",
                className: "max-w-[14rem]",
                cell: (p) => <JournalLink title={p.journal_title} portal="/hod" />,
              },
              {
                key: "year",
                header: "Year",
                align: "right",
                cell: (p) => p.publication_year || "—",
              },
              { key: "quartile", header: "Quartile", cell: (p) => p.quartile || "—" },
              {
                key: "authorship",
                header: "Authorship",
                className: "whitespace-nowrap text-muted-foreground",
                cell: (p) =>
                  p.author_position && p.total_authors
                    ? `${p.author_position} of ${p.total_authors}`
                    : "—",
              },
              {
                key: "progress",
                header: "Progress",
                cell: (p) => (
                  <span
                    className={cn(
                      "whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
                      PROGRESS_TONE[p.progress] || "bg-muted text-muted-foreground"
                    )}
                  >
                    {p.progress}
                  </span>
                ),
              },
            ]}
          />
          <Pager total={data.total} limit={PAGE} offset={offset} onOffsetChange={setOffset} />
        </>
      )}
    </div>
  )
}
