import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  Download,
  FileSearch,
  Search,
  SearchX,
  SlidersHorizontal,
  X,
} from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { useApi } from "@/lib/query"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input, NumberInput } from "@/ui/field"
import { Table, type Column } from "@/ui/table"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, Sub } from "@/ui/text"
import { money, Stage, stageOf } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/ui/sheet"

/**
 * Query the whole pipeline, across every department — the screen the old
 * app answered with seven always-open dropdowns sitting above the one thing
 * anybody opened it for. Results lead here; every filter beyond the search
 * box folds into one sheet, and whichever ones are active surface as chips
 * so a glance says what is being asked, not just what came back.
 *
 * The one rule that is not a matter of taste: a head of department calls a
 * different, department-scoped endpoint that carries no rupee figure at
 * all, by any route. Getting that branch wrong here does not just look bad
 * — `/api/reports/search` refuses an HOD outright (403), so the wrong
 * branch is also simply broken for them, not merely indiscreet.
 */
export function Publications() {
  const { me, loading } = useAuth()

  if (loading || !me) {
    return (
      <div className="page space-y-6">
        <SkeletonRows rows={8} rowHeight={44} />
      </div>
    )
  }

  return me.role === "HOD" ? <HodQuery department={me.department ?? null} /> : <GeneralQuery />
}

const PAGE_SIZE = 20

/* ------------------------------------------------------------------------ */
/* The full, college-wide query — everyone but an HOD                       */
/* ------------------------------------------------------------------------ */

type SearchRow = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  publication_year: number | null
  status: string
  owner_name: string
  owner_department: string | null
  quartile: string | null
  remuneration: number | null
  remuneration_is_estimate: boolean
  calc_error: string | null
}

type SearchPayload = {
  total: number
  total_amount: number
  limit: number
  offset: number
  results: SearchRow[]
}

// Every filter `/api/reports/search` actually reads (`backend/core/api.py`,
// `search_claims`) — `owner` and `journal` are deliberately not offered here
// even though the endpoint accepts them: both are exact-match drill-downs a
// linked chart passes in (a person's id, a journal's exact title), with no
// sensible thing to type into a box for either. A URL arriving with either
// set still works — this screen just never writes them itself.
const GENERAL_FILTER_KEYS = [
  "department",
  "status",
  "quartile",
  "category",
  "engineering_class",
  "indexing",
  "year_from",
  "year_to",
  "min_amount",
  "designation",
  "publication_type",
  "month",
] as const
type GeneralFilterKey = (typeof GENERAL_FILTER_KEYS)[number]
type GeneralFilters = Record<GeneralFilterKey, string>

function emptyGeneralFilters(): GeneralFilters {
  return Object.fromEntries(GENERAL_FILTER_KEYS.map((k) => [k, ""])) as GeneralFilters
}

function readGeneralFilters(sp: URLSearchParams): GeneralFilters {
  return Object.fromEntries(GENERAL_FILTER_KEYS.map((k) => [k, sp.get(k) ?? ""])) as GeneralFilters
}

const STATUS_OPTIONS: ComboboxOption[] = [
  { value: "", label: "Any status" },
  { value: "SUBMITTED", label: "Filed" },
  { value: "CLEARED", label: "Checked" },
  { value: "PRINCIPAL_APPROVED", label: "Approved" },
  { value: "DIRECTOR_APPROVED", label: "Authorised" },
  { value: "PAID", label: "Paid" },
  { value: "REJECTED", label: "Sent back" },
  { value: "HOD_APPROVED", label: "Filed (legacy chain)" },
  { value: "RESEARCH_APPROVED", label: "Checked (legacy chain)" },
  { value: "FINANCE_APPROVED", label: "Approved (legacy chain)" },
]

const QUARTILE_OPTIONS: ComboboxOption[] = [
  { value: "", label: "Any quartile" },
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
  { value: "NO_SNIP", label: "No SNIP" },
]

const GENERAL_SORT_OPTIONS: ComboboxOption[] = [
  { value: "recent", label: "Most recently updated" },
  { value: "amount", label: "Amount" },
  { value: "year", label: "Publication year" },
  { value: "faculty", label: "Faculty name" },
  { value: "department", label: "Department" },
]

function optionLabel(options: ComboboxOption[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value
}

function GeneralQuery() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { me } = useAuth()
  const seeMoney = can(me?.role).seeMoney

  const q = searchParams.get("q") ?? ""
  const sort = searchParams.get("sort") ?? "recent"
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)
  const filters = readGeneralFilters(searchParams)

  const [searchDraft, setSearchDraft] = useState(q)
  useEffect(() => setSearchDraft(q), [q])
  useEffect(() => {
    if (searchDraft === q) return
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (searchDraft) next.set("q", searchDraft)
          else next.delete("q")
          next.delete("page")
          return next
        },
        { replace: true }
      )
    }, 250)
    return () => clearTimeout(t)
  }, [searchDraft, q, setSearchParams])

  const [sheetOpen, setSheetOpen] = useState(false)
  const [draft, setDraft] = useState<GeneralFilters>(filters)
  // The sheet's own copy is refreshed from the URL each time it opens, so a
  // filter someone removed via its chip (URL changed while the sheet was
  // shut) doesn't reappear the next time the sheet is opened.
  useEffect(() => {
    if (sheetOpen) setDraft(readGeneralFilters(searchParams))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen])

  function applyDraft() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const key of GENERAL_FILTER_KEYS) {
        if (draft[key]) next.set(key, draft[key])
        else next.delete(key)
      }
      next.delete("page")
      return next
    })
    setSheetOpen(false)
  }

  function clearAll() {
    setSearchDraft("")
    setDraft(emptyGeneralFilters())
    setSearchParams(new URLSearchParams())
    setSheetOpen(false)
  }

  function removeFilter(key: GeneralFilterKey) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete(key)
      next.delete("page")
      return next
    })
  }

  function setSort(next: string) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next && next !== "recent") params.set("sort", next)
      else params.delete("sort")
      params.delete("page")
      return params
    })
  }

  function goToPage(next: number) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next > 0) params.set("page", String(next))
      else params.delete("page")
      return params
    })
  }

  const queryParams = new URLSearchParams()
  if (q) queryParams.set("q", q)
  for (const key of GENERAL_FILTER_KEYS) if (filters[key]) queryParams.set(key, filters[key])
  if (sort !== "recent") queryParams.set("sort", sort)
  queryParams.set("limit", String(PAGE_SIZE))
  queryParams.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<SearchPayload>(
    ["reports-search", queryParams.toString()],
    `/api/reports/search?${queryParams.toString()}`,
    { placeholderData: (prev) => prev }
  )

  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) goToPage(maxPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const activeKeys = GENERAL_FILTER_KEYS.filter((k) => filters[k])
  const filtered = Boolean(q) || activeKeys.length > 0

  const exportParams = new URLSearchParams(queryParams)
  exportParams.delete("limit")
  exportParams.delete("offset")
  exportParams.set("fmt", "xlsx")

  const columns: Column<SearchRow>[] = [
    {
      key: "paper",
      header: "Paper",
      className: "max-w-[20rem]",
      cell: (r) => (
        <span className="block">
          <span className="block truncate text-base">{r.paper_title || "Untitled"}</span>
          <Meta className="mt-0.5 block truncate">{r.ticket_number || "—"}</Meta>
        </span>
      ),
    },
    {
      key: "faculty",
      header: "Faculty",
      className: "max-w-[14rem]",
      cell: (r) => (
        <span className="block truncate text-sm">
          {r.owner_name}
          {r.owner_department && <Meta className="ml-1.5">{r.owner_department}</Meta>}
        </span>
      ),
    },
    {
      key: "journal",
      header: "Journal",
      className: "max-w-[13rem]",
      cell: (r) => <span className="line-clamp-2 text-sm text-fg-muted">{r.journal_title || "—"}</span>,
    },
    { key: "year", header: "Year", className: "w-16", cell: (r) => <span className="tabular">{r.publication_year ?? "—"}</span> },
    { key: "quartile", header: "Quartile", className: "w-20", cell: (r) => <span className="text-sm">{r.quartile || "—"}</span> },
    { key: "stage", header: "Stage", className: "w-32", cell: (r) => <Stage stage={stageOf(r.status)} /> },
    ...(seeMoney
      ? [
          {
            key: "amount",
            header: "Amount",
            align: "right" as const,
            cell: (r: SearchRow) => <AmountCell row={r} />,
          },
        ]
      : []),
  ]

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Publications</PageTitle>
          <Sub className="mt-1">
            Every publication across the college that this account may see, queried directly.
          </Sub>
        </div>
        <Button kind="default" asChild>
          <a href={`/api/reports/search/export?${exportParams.toString()}`} target="_blank" rel="noreferrer">
            <Download />
            Export
          </a>
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title, ticket, DOI, ISSN, faculty…"
            aria-label="Search publications"
            className="pl-8"
          />
        </div>

        <Combobox
          value={sort}
          onChange={setSort}
          options={GENERAL_SORT_OPTIONS}
          aria-label="Sort by"
          className="w-52"
        />

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button kind="default">
              <SlidersHorizontal />
              Filters
              {activeKeys.length > 0 && <span className="tabular">{activeKeys.length}</span>}
            </Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <SheetBody className="space-y-4">
              <DepartmentField value={draft.department} onChange={(v) => setDraft((d) => ({ ...d, department: v }))} />
              <LabeledCombobox
                label="Status"
                value={draft.status}
                onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                options={STATUS_OPTIONS}
              />
              <LabeledCombobox
                label="Quartile"
                value={draft.quartile}
                onChange={(v) => setDraft((d) => ({ ...d, quartile: v }))}
                options={QUARTILE_OPTIONS}
              />
              <LabeledInput
                label="Category"
                value={draft.category}
                onChange={(v) => setDraft((d) => ({ ...d, category: v }))}
                placeholder="e.g. I"
              />
              <LabeledInput
                label="Engineering class"
                value={draft.engineering_class}
                onChange={(v) => setDraft((d) => ({ ...d, engineering_class: v }))}
                placeholder="e.g. Engineering"
              />
              <LabeledInput
                label="Indexing"
                value={draft.indexing}
                onChange={(v) => setDraft((d) => ({ ...d, indexing: v }))}
                placeholder="e.g. Scopus"
              />
              <LabeledInput
                label="Publication type"
                value={draft.publication_type}
                onChange={(v) => setDraft((d) => ({ ...d, publication_type: v }))}
                placeholder="e.g. Journal"
              />
              <LabeledInput
                label="Designation"
                value={draft.designation}
                onChange={(v) => setDraft((d) => ({ ...d, designation: v }))}
                placeholder="e.g. Assistant Professor"
              />
              <div className="grid grid-cols-2 gap-3">
                <LabeledNumber
                  label="Year from"
                  value={draft.year_from}
                  onChange={(v) => setDraft((d) => ({ ...d, year_from: v }))}
                />
                <LabeledNumber
                  label="Year to"
                  value={draft.year_to}
                  onChange={(v) => setDraft((d) => ({ ...d, year_to: v }))}
                />
              </div>
              {seeMoney && (
                <LabeledNumber
                  label="Minimum amount"
                  value={draft.min_amount}
                  onChange={(v) => setDraft((d) => ({ ...d, min_amount: v }))}
                  unit="₹"
                />
              )}
              <div className="space-y-1.5">
                <label className="block text-sm font-medium" htmlFor="pub-month">
                  Payout month
                </label>
                <input
                  id="pub-month"
                  type="month"
                  value={draft.month}
                  onChange={(e) => setDraft((d) => ({ ...d, month: e.target.value }))}
                  className={cn(
                    "h-8 w-full rounded-md bg-surface px-2.5 text-sm text-fg outline-none",
                    "ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent"
                  )}
                />
              </div>
            </SheetBody>
            <SheetFooter>
              <Button kind="quiet" size="sm" onClick={clearAll}>
                Clear all
              </Button>
              <Button kind="primary" size="sm" onClick={applyDraft}>
                Apply
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>

      {activeKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeKeys.map((key) => (
            <Chip key={key} label={chipLabel(key, filters[key])} onRemove={() => removeFilter(key)} />
          ))}
        </div>
      )}

      {!isLoading && !isError && (
        <Meta className="block">
          {total} {total === 1 ? "result" : "results"}
          {seeMoney && data && total > 0 ? ` · ${money(data.total_amount)} total` : ""}
        </Meta>
      )}

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={48} />
      ) : isError ? (
        error?.status === 403 ? (
          <ErrorState
            title="Not available for this account"
            message="This query is open to the research cell, the Principal, Finance and system admins."
          />
        ) : (
          <ErrorState
            title="Could not run this query"
            message="The server did not answer. Nothing has been lost."
            onRetry={() => refetch()}
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : FileSearch}
          title={filtered ? "No results for this query" : "Nothing has been filed yet"}
          message={
            filtered
              ? "No publication matches this search and these filters. Try loosening one of them."
              : "Once faculty start filing papers, they will show up here."
          }
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={clearAll}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table
            rows={rows}
            getKey={(r) => r.id}
            rowLink={(r) => `/papers/${r.id}`}
            minWidth="56rem"
            columns={columns}
          />
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}
    </div>
  )
}

function chipLabel(key: GeneralFilterKey, value: string): string {
  switch (key) {
    case "status":
      return `Status: ${optionLabel(STATUS_OPTIONS, value)}`
    case "quartile":
      return `Quartile: ${optionLabel(QUARTILE_OPTIONS, value)}`
    case "min_amount":
      return `Min ${money(Number(value))}`
    case "year_from":
      return `From ${value}`
    case "year_to":
      return `To ${value}`
    case "department":
      return `Dept: ${value}`
    case "engineering_class":
      return `Class: ${value}`
    case "publication_type":
      return `Type: ${value}`
    case "month":
      return `Paid: ${value}`
    default:
      return `${key[0].toUpperCase()}${key.slice(1).replace(/_/g, " ")}: ${value}`
  }
}

/** The amount, with the two things that make it not a settled figure shown
 *  beside it — mirrors `papers.tsx`'s `AmountCell`, redeclared here rather
 *  than imported since this file may not touch `papers.tsx`. */
function AmountCell({ row }: { row: SearchRow }) {
  if (row.calc_error) {
    return <span className="text-xs text-critical">Could not calculate</span>
  }
  return (
    <span className="inline-flex flex-col items-end">
      <span className="tabular">{money(row.remuneration)}</span>
      {row.remuneration != null && row.remuneration_is_estimate && (
        <span className="text-xs font-normal leading-tight text-caution">Estimate</span>
      )}
    </span>
  )
}

/** The department picker, sourced from `/api/meta/departments` — the same
 *  endpoint and pattern `people.tsx` uses, so this filter only ever offers a
 *  department that actually has someone in it. */
function DepartmentField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useApi<string[]>(["meta", "departments"], "/api/meta/departments")
  const options: ComboboxOption[] = [
    { value: "", label: "Any department" },
    ...(data || []).map((d) => ({ value: d, label: d })),
  ]
  return <LabeledCombobox label="Department" value={value} onChange={onChange} options={options} />
}

function LabeledCombobox({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: ComboboxOption[]
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      <Combobox value={value} onChange={onChange} options={options} aria-label={label} />
    </div>
  )
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  )
}

function LabeledNumber({
  label,
  value,
  onChange,
  unit,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  unit?: string
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      <NumberInput value={value} onChange={(e) => onChange(e.target.value)} unit={unit} />
    </div>
  )
}

/** One active filter, said as a removable chip. Never a naked value — a
 *  reader glancing at "Q1" has no idea whether that is a quartile or a
 *  minimum amount, so every chip names its own dimension. */
function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-selected px-2 py-1 text-sm text-fg">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="grid size-4 place-items-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* The department-scoped, money-blind query — an HOD                       */
/* ------------------------------------------------------------------------ */

type HodRow = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  publication_year: number | null
  quartile: string | null
  snip: number | null
  indexing_level: string | null
  publication_type: string | null
  owner_name: string
  progress: string
}

type HodPayload = {
  total: number
  limit: number
  offset: number
  department: string
  results: HodRow[]
}

const HOD_SORT_OPTIONS: ComboboxOption[] = [
  { value: "recent", label: "Most recently updated" },
  { value: "year", label: "Publication year" },
  { value: "title", label: "Title" },
  { value: "person", label: "Faculty name" },
  { value: "journal", label: "Journal" },
]

const HOD_PROGRESS_TONE: Record<string, string> = {
  "Not yet filed": "text-fg-muted",
  "Under review": "text-fg",
  Approved: "text-fg",
  Completed: "text-positive",
  "Sent back": "text-critical",
}

/**
 * A head of department gets exactly one publication, exactly one department
 * and never a rupee — `/api/hod/publications`, not `/api/reports/search`.
 * The two screens share a shape (search, sort, filter sheet, chips, table,
 * pagination) but not a query surface: the general query's filter keys and
 * sort values do not exist on this endpoint, so nothing is shared beyond the
 * small display pieces (`Chip`, `Pagination`) redeclared for this branch.
 */
function HodQuery({ department }: { department: string | null }) {
  const [searchParams, setSearchParams] = useSearchParams()

  const q = searchParams.get("q") ?? ""
  const year = searchParams.get("year") ?? ""
  const quartile = searchParams.get("quartile") ?? ""
  const sort = searchParams.get("sort") ?? "recent"
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  const [searchDraft, setSearchDraft] = useState(q)
  useEffect(() => setSearchDraft(q), [q])
  useEffect(() => {
    if (searchDraft === q) return
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (searchDraft) next.set("q", searchDraft)
          else next.delete("q")
          next.delete("page")
          return next
        },
        { replace: true }
      )
    }, 250)
    return () => clearTimeout(t)
  }, [searchDraft, q, setSearchParams])

  const [sheetOpen, setSheetOpen] = useState(false)
  const [draftYear, setDraftYear] = useState(year)
  const [draftQuartile, setDraftQuartile] = useState(quartile)
  useEffect(() => {
    if (sheetOpen) {
      setDraftYear(year)
      setDraftQuartile(quartile)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen])

  function applyDraft() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (draftYear) next.set("year", draftYear)
      else next.delete("year")
      if (draftQuartile) next.set("quartile", draftQuartile)
      else next.delete("quartile")
      next.delete("page")
      return next
    })
    setSheetOpen(false)
  }

  function clearAll() {
    setSearchDraft("")
    setDraftYear("")
    setDraftQuartile("")
    setSearchParams(new URLSearchParams())
    setSheetOpen(false)
  }

  function removeFilter(key: "year" | "quartile") {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete(key)
      next.delete("page")
      return next
    })
  }

  function setSort(next: string) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next && next !== "recent") params.set("sort", next)
      else params.delete("sort")
      params.delete("page")
      return params
    })
  }

  function goToPage(next: number) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next > 0) params.set("page", String(next))
      else params.delete("page")
      return params
    })
  }

  const queryParams = new URLSearchParams()
  if (q) queryParams.set("q", q)
  if (year) queryParams.set("year", year)
  if (quartile) queryParams.set("quartile", quartile)
  if (sort !== "recent") queryParams.set("sort", sort)
  queryParams.set("limit", String(PAGE_SIZE))
  queryParams.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<HodPayload>(
    ["hod-publications", queryParams.toString()],
    `/api/hod/publications?${queryParams.toString()}`,
    { placeholderData: (prev) => prev }
  )

  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) goToPage(maxPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const activeFilters: { key: "year" | "quartile"; label: string }[] = [
    ...(year ? [{ key: "year" as const, label: `Year: ${year}` }] : []),
    ...(quartile ? [{ key: "quartile" as const, label: `Quartile: ${optionLabel(QUARTILE_OPTIONS, quartile)}` }] : []),
  ]
  const filtered = Boolean(q) || activeFilters.length > 0

  const exportParams = new URLSearchParams(queryParams)
  exportParams.delete("limit")
  exportParams.delete("offset")
  exportParams.set("fmt", "xlsx")

  const columns: Column<HodRow>[] = [
    {
      key: "paper",
      header: "Paper",
      className: "max-w-[20rem]",
      cell: (r) => (
        <span className="block">
          <span className="block truncate text-base">{r.paper_title || "Untitled"}</span>
          <Meta className="mt-0.5 block truncate">{r.ticket_number || "—"}</Meta>
        </span>
      ),
    },
    { key: "faculty", header: "Faculty", className: "max-w-[13rem]", cell: (r) => <span className="block truncate text-sm">{r.owner_name}</span> },
    { key: "journal", header: "Journal", className: "max-w-[13rem]", cell: (r) => <span className="line-clamp-2 text-sm text-fg-muted">{r.journal_title || "—"}</span> },
    { key: "year", header: "Year", className: "w-16", cell: (r) => <span className="tabular">{r.publication_year ?? "—"}</span> },
    { key: "quartile", header: "Quartile", className: "w-20", cell: (r) => <span className="text-sm">{r.quartile || "—"}</span> },
    { key: "indexing", header: "Indexed in", className: "max-w-[10rem]", cell: (r) => <span className="truncate text-sm text-fg-muted">{r.indexing_level || "—"}</span> },
    {
      key: "progress",
      header: "Progress",
      className: "w-32",
      cell: (r) => <span className={cn("text-sm", HOD_PROGRESS_TONE[r.progress] ?? "text-fg-muted")}>{r.progress}</span>,
    },
  ]

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Publications</PageTitle>
          <Sub className="mt-1">
            Every publication filed in {department || "your department"}, one row each.
          </Sub>
        </div>
        <Button kind="default" asChild>
          <a href={`/api/hod/export?${exportParams.toString()}`} target="_blank" rel="noreferrer">
            <Download />
            Export
          </a>
        </Button>
      </header>

      <Callout tone="info" title="Payment figures are not shown for this role">
        As a head of department you can see what your department has published, not what anyone was
        paid for it — this list, and its export, never carry a rupee figure.
      </Callout>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title, journal or faculty"
            aria-label="Search department publications"
            className="pl-8"
          />
        </div>

        <Combobox value={sort} onChange={setSort} options={HOD_SORT_OPTIONS} aria-label="Sort by" className="w-52" />

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button kind="default">
              <SlidersHorizontal />
              Filters
              {activeFilters.length > 0 && <span className="tabular">{activeFilters.length}</span>}
            </Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <SheetBody className="space-y-4">
              <LabeledNumber label="Year" value={draftYear} onChange={setDraftYear} />
              <LabeledCombobox label="Quartile" value={draftQuartile} onChange={setDraftQuartile} options={QUARTILE_OPTIONS} />
            </SheetBody>
            <SheetFooter>
              <Button kind="quiet" size="sm" onClick={clearAll}>
                Clear all
              </Button>
              <Button kind="primary" size="sm" onClick={applyDraft}>
                Apply
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>

      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeFilters.map((f) => (
            <Chip key={f.key} label={f.label} onRemove={() => removeFilter(f.key)} />
          ))}
        </div>
      )}

      {!isLoading && !isError && (
        <Meta className="block">
          {total} {total === 1 ? "result" : "results"}
        </Meta>
      )}

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={48} />
      ) : isError ? (
        error?.status === 403 ? (
          <ErrorState
            title="Not available for this account"
            message="This department view is only open to heads of department."
          />
        ) : (
          <ErrorState
            title="Could not run this query"
            message="The server did not answer. Nothing has been lost."
            onRetry={() => refetch()}
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : FileSearch}
          title={filtered ? "No results for this query" : "Nothing filed in this department yet"}
          message={
            filtered
              ? "No publication matches this search and these filters. Try loosening one of them."
              : "Once your faculty start filing papers, they will show up here."
          }
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={clearAll}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table rows={rows} getKey={(r) => r.id} rowLink={(r) => `/papers/${r.id}`} minWidth="52rem" columns={columns} />
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Shared display pieces                                                    */
/* ------------------------------------------------------------------------ */

