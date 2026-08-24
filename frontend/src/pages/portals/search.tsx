"use client"

import { useSearchParams } from "react-router-dom"
import { useEffect, useMemo, useState } from "react"
import { Download, Search as SearchIcon } from "lucide-react"

import { ClaimDetailFields } from "@/components/claim-detail-fields"
import { EmptyState, ErrorState, MasterDetail, PageHeader } from "@/components/layout/page"
import { Money, StatusChip, TicketProgress, monthLabel } from "@/components/ticket-ui"
import { FilterBar } from "@/components/filter-bar"
import { Combobox } from "@/components/ui/combobox"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Pager } from "@/components/ui/pagination"
import { API_BASE, type Claim } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { useIsDesktop } from "@/lib/use-media-query"
import { cn } from "@/lib/utils"

type Results = {
  total: number
  total_amount: number
  limit: number
  offset: number
  results: Claim[]
}

const ANY = "__any__"

const STATUSES = ["SUBMITTED", "CLEARED", "PAID", "REJECTED"]
const QUARTILES = ["Q1", "Q2", "Q3", "Q4"]
const CATEGORIES = [
  { value: "I", label: "I — Scopus, with SNIP" },
  { value: "II", label: "II — Scopus journal, no SNIP" },
  { value: "III", label: "III — Conference / book, no SNIP" },
  { value: "IV", label: "IV — Web of Science" },
  { value: "—", label: "Not eligible" },
]
const SORTS = [
  { value: "recent", label: "Most recent" },
  { value: "amount", label: "Highest amount" },
  { value: "year", label: "Newest publication" },
  { value: "faculty", label: "Faculty name" },
  { value: "department", label: "Department" },
]

/** One filter, rendered the same way every time. */
/**
 * One filter control, typeable.
 *
 * Was a plain select. Department alone holds thirty-one options and the only
 * way through them was to scroll — a styled listbox does not even do the
 * type-to-jump a native select gives you free, so these were worse than the
 * browser's own control.
 */
function Picker({
  id,
  label,
  value,
  onChange,
  options,
  anyLabel,
  className,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  anyLabel: string
  className?: string
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Combobox
        id={id}
        aria-label={label}
        value={value}
        onChange={onChange}
        className="w-full min-w-[11rem]"
        searchPlaceholder={`Filter ${label.toLowerCase()}…`}
        options={[{ value: ANY, label: anyLabel }, ...options]}
      />
    </div>
  )
}

/**
 * Ask the whole college a question.
 *
 * The oversight portals could list a pipeline but not interrogate it — "which
 * Q1 Engineering papers in ECE went unpaid last year" meant exporting the
 * ledger and pivoting it. Totals are for the whole matched set, not the page,
 * so the answer is the number on screen.
 */
export function SearchPage() {
  const isDesktop = useIsDesktop()
  // Seeded from the address bar, so a figure in the reports can link straight
  // into the rows behind it. A total nobody can open is a total nobody can
  // check.
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get("q") || "")
  const [debouncedQ, setDebouncedQ] = useState(params.get("q") || "")
  const [department, setDepartment] = useState(params.get("department") || ANY)
  const [status, setStatus] = useState(params.get("status") || ANY)
  const [quartile, setQuartile] = useState(params.get("quartile") || ANY)
  const [category, setCategory] = useState(params.get("category") || ANY)
  const [engineering, setEngineering] = useState(params.get("engineering_class") || ANY)
  const [year, setYear] = useState(params.get("year") || "")
  const [sort, setSort] = useState("recent")
  // Narrowing to one person or one journal arrives by link only -- there is no
  // dropdown for "this author", because you get here by clicking their name.
  // Both stay visible as a chip so the totals below are never a mystery.
  const [owner, setOwner] = useState(params.get("owner") || "")
  const [ownerName] = useState(params.get("owner_name") || "")
  const [journal, setJournal] = useState(params.get("journal") || "")
  const [designation, setDesignation] = useState(params.get("designation") || "")
  const [kind, setKind] = useState(params.get("publication_type") || "")
  const [month, setMonth] = useState(params.get("month") || "")
  const [indexing, setIndexing] = useState(params.get("indexing") || "")

  const [selected, setSelected] = useState<Claim | null>(null)
  const [offset, setOffset] = useState(0)
  const PAGE = 50

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q)
      setOffset(0)
    }, 300)
    return () => clearTimeout(t)
  }, [q])

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (debouncedQ.trim()) p.set("q", debouncedQ.trim())
    if (department !== ANY) p.set("department", department)
    if (status !== ANY) p.set("status", status)
    if (quartile !== ANY) p.set("quartile", quartile)
    if (category !== ANY) p.set("category", category)
    if (engineering !== ANY) p.set("engineering_class", engineering)
    if (year.trim()) p.set("year", year.trim())
    if (owner) p.set("owner", owner)
    if (journal) p.set("journal", journal)
    if (designation) p.set("designation", designation)
    if (kind) p.set("publication_type", kind)
    if (month) p.set("month", month)
    if (indexing) p.set("indexing", indexing)
    p.set("sort", sort)
    p.set("limit", String(PAGE))
    p.set("offset", String(offset))
    return p.toString()
  }, [debouncedQ, department, status, quartile, category, engineering, year, owner, journal, designation, kind, month, indexing, sort, offset])

  const { data, isLoading: loading, isError, refetch } = useApiQuery<Results>(
    ["search", query],
    `/api/reports/search?${query}`
  )
  const { data: departments = [] } = useApiQuery<string[]>(
    ["meta", "departments"],
    "/api/meta/departments"
  )


  // Filters that arrive only by link. Kept as data so a new one is a row
  // here rather than another copy of the chip markup.
  const linkFilters = [
    { label: "Author", value: ownerName || "one person", on: !!owner, clear: () => setOwner("") },
    { label: "Journal", value: journal, on: !!journal, clear: () => setJournal("") },
    { label: "Designation", value: designation, on: !!designation, clear: () => setDesignation("") },
    { label: "Kind", value: kind, on: !!kind, clear: () => setKind("") },
    { label: "Indexed in", value: indexing, on: !!indexing, clear: () => setIndexing("") },
    { label: "Paid in", value: monthLabel(month), on: !!month, clear: () => setMonth("") },
  ].filter((f) => f.on)

  function reset() {
    setQ("")
    setDebouncedQ("")
    setDepartment(ANY)
    setStatus(ANY)
    setQuartile(ANY)
    setCategory(ANY)
    setEngineering(ANY)
    setYear("")
    setOwner("")
    setJournal("")
    setDesignation("")
    setKind("")
    setMonth("")
    setIndexing("")
    setSort("recent")
    setOffset(0)
  }

  // Every filter except the search box, as data — so the panel and the chips
  // are two views of one list rather than two lists to keep in step.
  const pickers = [
    {
      id: "s-dept",
      label: "Department",
      value: department,
      set: setDepartment,
      anyLabel: "Any department",
      options: departments.map((d) => ({ value: d, label: d })),
    },
    {
      id: "s-status",
      label: "Status",
      value: status,
      set: setStatus,
      anyLabel: "Any status",
      options: STATUSES.map((x) => ({ value: x, label: x })),
    },
    {
      id: "s-quartile",
      label: "Quartile",
      value: quartile,
      set: setQuartile,
      anyLabel: "Any quartile",
      options: QUARTILES.map((x) => ({ value: x, label: x })),
    },
    {
      id: "s-category",
      label: "Rate band",
      value: category,
      set: setCategory,
      anyLabel: "Any band",
      options: CATEGORIES,
    },
    {
      id: "s-eng",
      label: "Classification",
      value: engineering,
      set: setEngineering,
      anyLabel: "Any",
      options: [
        { value: "Engineering", label: "Engineering" },
        { value: "Non-Engineering", label: "Non-Engineering" },
      ],
    },
  ]

  const activeFilters = [
    ...pickers
      .filter((f) => f.value !== ANY)
      .map((f) => ({
        label: f.label,
        value: f.options.find((o) => o.value === f.value)?.label || f.value,
        onClear: () => {
          f.set(ANY)
          setOffset(0)
        },
      })),
    ...(year.trim()
      ? [
          {
            label: "Year",
            value: year.trim(),
            onClear: () => {
              setYear("")
              setOffset(0)
            },
          },
        ]
      : []),
    ...linkFilters.map((f) => ({
      label: f.label,
      value: f.value,
      onClear: () => {
        f.clear()
        setOffset(0)
      },
    })),
  ]

  const listPanel = (
    <div className="space-y-3">
      {/* The box people actually use, at full width and on its own. */}
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          className="h-11 pl-9 text-base"
          placeholder="Title, journal, DOI, ISSN, ticket, faculty, staff ID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search publications"
        />
      </div>

      {/* Folded, with a count — the same control every other screen uses. */}
      <FilterBar active={activeFilters} onClear={reset}>
        {pickers.map((f) => (
          <Picker
            key={f.id}
            id={f.id}
            label={f.label}
            value={f.value}
            onChange={(v) => {
              f.set(v)
              setOffset(0)
            }}
            anyLabel={f.anyLabel}
            options={f.options}
          />
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="s-year" className="text-xs">
            Publication year
          </Label>
          <Input
            id="s-year"
            inputMode="numeric"
            placeholder="Any"
            className="w-28 tabular-nums"
            value={year}
            onChange={(e) => {
              setYear(e.target.value.replace(/\D/g, "").slice(0, 4))
              setOffset(0)
            }}
          />
        </div>
        <Picker
          id="s-sort"
          label="Sort by"
          value={sort}
          onChange={(v) => {
            setSort(v)
            setOffset(0)
          }}
          anyLabel="Most recent"
          options={SORTS}
        />
      </FilterBar>

      {/* Totals for the whole match, not the page — otherwise the number on
          screen answers a different question than the one asked. */}
      <div className="flex items-baseline justify-between gap-3 rounded-[var(--radius)] border border-border/80 bg-muted/40 px-4 py-2.5">
        <span className="text-sm text-muted-foreground">
          {loading ? "Searching…" : `${data?.total ?? 0} publication${data?.total === 1 ? "" : "s"}`}
        </span>
        <span className="flex items-center gap-3">
          <span className="text-sm font-semibold tabular-nums">
            <Money value={data?.total_amount ?? 0} />
          </span>
          {/* Exactly the rows being read, as a file. People were going to the
              reports page and rebuilding the filter in Excel to get this. */}
          {data?.total ? (
            <Button asChild variant="ghost" size="xs">
              <a href={`${API_BASE}/api/reports/search/export?${query}&fmt=xlsx`}>
                <Download className="size-3.5" />
                Excel
              </a>
            </Button>
          ) : null}
        </span>
      </div>

      <div className="overflow-hidden surface-card">
        {loading ? (
          <div className="space-y-px p-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-[calc(var(--radius)-2px)]" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            title="Search failed"
            description="The server did not respond."
            onRetry={() => refetch()}
            className="rounded-none border-0"
          />
        ) : !data?.results.length ? (
          <EmptyState
            title="No matches"
            description="Nothing matches those filters. Try widening them."
            className="rounded-none border-0"
          />
        ) : (
          data.results.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c)}
              className={cn(
                "flex w-full flex-col gap-1.5 border-b border-border px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/50",
                selected?.id === c.id && "bg-muted/40"
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {c.ticket_number || "—"}
                </span>
                <StatusChip status={c.status} contest={c.contest_forward} />
              </span>
              <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                {c.paper_title || "Untitled"}
              </span>
              <TicketProgress status={c.status} />
              <span className="flex items-baseline justify-between gap-2">
                <span className="line-clamp-1 min-w-0 text-xs text-muted-foreground">
                  {c.owner_name}
                  {c.owner_department ? ` · ${c.owner_department}` : ""}
                  {c.publication_year ? ` · ${c.publication_year}` : ""}
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums">
                  <Money value={c.remuneration} />
                </span>
              </span>
            </button>
          ))
        )}
      </div>

      {data ? (
        <Pager
          total={data.total}
          limit={data.limit ?? PAGE}
          offset={data.offset ?? offset}
          onOffsetChange={setOffset}
        />
      ) : null}
    </div>
  )

  const detailPanel = selected ? (
    <div className="sticky top-20 max-h-[calc(100vh-5.5rem)] overflow-y-auto surface-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="font-mono text-sm text-muted-foreground">
          {selected.ticket_number || "—"}
        </span>
        <StatusChip status={selected.status} contest={selected.contest_forward} />
      </div>
      <ClaimDetailFields claim={selected} showOwner />
    </div>
  ) : (
    // Compact: nothing is selected, so this is a hint, not a panel. It used to
    // be a half-screen dashed box competing with the results for attention.
    <p className="px-4 py-6 text-sm text-muted-foreground">
      Pick a result to see the full record.
    </p>
  )

  return (
    <div>
      <PageHeader title="Query" subtitle="Search every publication across the college" />
      {isDesktop ? (
        <MasterDetail list={listPanel} detail={detailPanel} listWidth="wide" />
      ) : (
        <div className="space-y-4">
          {listPanel}
          {selected ? detailPanel : null}
        </div>
      )}
    </div>
  )
}
