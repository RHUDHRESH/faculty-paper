import { paperTitle } from "@/lib/names"
import { HodPapers } from "@/pages/hod-papers"
import { useEffect, useId, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
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
import { Avatar, initialsOf } from "@/ui/person"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input, NumberInput } from "@/ui/field"
import { Table, type Column } from "@/ui/table"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { PageHeader } from "@/ui/page-header"
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

  return me.role === "HOD" ? <HodPapers /> : <GeneralQuery />
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
  owner_photo_url?: string | null
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
    // Sort survives. It is not a filter — it hides nothing — and having
    // "clear filters" silently reorder the list underneath the reader is a
    // second surprise on top of the one they asked for.
    setSearchParams((prev) => {
      const next = new URLSearchParams()
      const keepSort = prev.get("sort")
      if (keepSort) next.set("sort", keepSort)
      return next
    })
    setSheetOpen(false)
  }

  function clearSearch() {
    setSearchDraft("")
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete("q")
      next.delete("page")
      return next
    })
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
          <span className="block truncate text-base">{paperTitle(r.paper_title)}</span>
          <Meta className="mt-0.5 block truncate" title={r.ticket_number?.startsWith("ERP-") ? "A claim number imported from the old ERP spreadsheet" : undefined}>
            {r.ticket_number ? (r.ticket_number.startsWith("ERP-") ? `Old ERP, ${r.ticket_number.replace(/^ERP-/, "")}` : r.ticket_number) : "No claim number"}
          </Meta>
        </span>
      ),
    },
    {
      key: "faculty",
      header: "Faculty",
      className: "max-w-[14rem]",
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <Avatar
            person={{ name: r.owner_name, initials: initialsOf(r.owner_name), photo_url: r.owner_photo_url ?? null }}
            size="xs"
          />
          <span className="min-w-0 truncate">
            {r.owner_name}
            {r.owner_department && <Meta className="ml-1.5">{r.owner_department}</Meta>}
          </span>
        </span>
      ),
    },
    {
      key: "journal",
      header: "Journal",
      className: "max-w-[13rem]",
      cell: (r) => (r.journal_title ? <span className="line-clamp-2 text-sm text-fg-muted">{r.journal_title}</span> : null),
    },
    { key: "year", header: "Year", className: "w-16", cell: (r) => (r.publication_year ? <span className="tabular">{r.publication_year}</span> : null) },
    { key: "quartile", header: "Quartile", className: "w-20", cell: (r) => (r.quartile ? <span className="text-sm">{r.quartile}</span> : null) },
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
      <PageHeader
        title="Publications"
        sub="Claims under the incentive scheme, and where each stands."
        action={
          <Button kind="primary" asChild>
            <a href={`/api/reports/search/export?${exportParams.toString()}`} target="_blank" rel="noreferrer">
              <Download />
              Download {data ? `these ${total.toLocaleString("en-IN")} claims` : "these claims"}
            </a>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title, claim, DOI, ISSN, faculty…"
            aria-label="Search claims"
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
              <LabeledMonth
                label="Month paid"
                value={draft.month}
                onChange={(v) => setDraft((d) => ({ ...d, month: v }))}
              />
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

      {/* Count and chips together, above the results: what was asked, and
          how much came back. The search box holds a term without looking
          like a filter, so it gets a chip of its own — an empty list with a
          forgotten search still in the box is the case this whole strip
          exists for. */}
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        <div role="status" aria-live="polite">
          {!isLoading && !isError && (
            <Meta className="tabular">
              {total === 1 ? "1 claim" : `${total.toLocaleString("en-IN")} claims`}
              {filtered ? " matching these filters" : ""}
              {seeMoney && data && total > 0 ? ` · ${money(data.total_amount)} total` : ""}
            </Meta>
          )}
        </div>
        {q && <Chip label={`Search: ${q}`} onRemove={clearSearch} />}
        {activeKeys.map((key) => (
          <Chip key={key} label={chipLabel(key, filters[key])} onRemove={() => removeFilter(key)} />
        ))}
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clearAll}>
            Clear all
          </Button>
        )}
      </div>

      {isLoading ? (
        <>
          <SkeletonRows rows={8} rowHeight={48} className="hidden md:block" />
          <SkeletonRows rows={5} rowHeight={84} className="md:hidden" />
        </>
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
          art="no-results"
          icon={filtered ? SearchX : FileSearch}
          title={filtered ? "No results for this query" : "Nothing has been filed yet"}
          message={
            filtered
              ? "No claim matches this search and these filters. Try loosening one of them."
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
            className="hidden md:block"
            rows={rows}
            getKey={(r) => r.id}
            rowLink={(r) => `/papers/${r.id}`}
            minWidth="56rem"
            columns={columns}
          />

          <ul className="divide-y divide-line border-y border-line md:hidden">
            {rows.map((r) => (
              <SearchCard key={r.id} row={r} seeMoney={seeMoney} />
            ))}
          </ul>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}
    </div>
  )
}

/** The seven-column result row, restacked for a screen too narrow to hold
 *  it. Without this the table is the only layout, and at 375px a reader is
 *  side-scrolling a 56rem grid to find the stage of a paper whose title
 *  they can no longer see. */
function SearchCard({ row, seeMoney }: { row: SearchRow; seeMoney: boolean }) {
  return (
    <li className="row">
      <Link to={`/papers/${row.id}`} className="block px-1 py-3">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base">{paperTitle(row.paper_title)}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
              <Avatar
                person={{ name: row.owner_name, initials: initialsOf(row.owner_name), photo_url: row.owner_photo_url ?? null }}
                size="xs"
              />
              <Meta className="block truncate">
                {[row.owner_name, row.owner_department, row.ticket_number].filter(Boolean).join(" · ")}
              </Meta>
            </span>
          </span>
          {seeMoney && (
            <span className="shrink-0 text-right">
              <AmountCell row={row} />
            </span>
          )}
        </div>
        <Meta className="mt-1 block truncate">
          {[row.journal_title, row.publication_year, row.quartile].filter(Boolean).join(" · ") || "Journal, year and quartile not recorded"}
        </Meta>
        <div className="mt-2">
          <Stage stage={stageOf(row.status)} className="w-[8rem]" />
        </div>
      </Link>
    </li>
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
      return `Department: ${value}`
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
  // Rows brought in from the old ERP spreadsheet were paid through the ledger
  // and carry no amount of their own; "₹0" beside "Paid" read as unpaid.
  if (row.remuneration === 0) {
    return <span className="text-xs text-fg-muted">Not recorded</span>
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
  // Was a <span>: the combobox had a name from `aria-label`, so it was not
  // silent, but the words above it were not clickable and the three fields
  // in this sheet were built three different ways. `Combobox` puts `id` on
  // its trigger button, which is labelable, so it can take the same
  // useId/htmlFor pairing the text and number filters use.
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <Combobox id={id} value={value} onChange={onChange} options={options} aria-label={label} />
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
  // A <span> is not a label: it gives the field no accessible name and
  // clicking it does not focus anything. Nine filters here were announced as
  // unlabelled edit boxes, while the Combobox directly above them passed
  // aria-label all along.
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
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
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <NumberInput
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        unit={unit}
      />
    </div>
  )
}

/** `type="month"` in the house colours. There is no `MonthInput` in
 *  `src/ui/field.tsx` to reach for, so the ring, height and radius are
 *  written out here to match `Input` exactly — a hand-rolled id was the one
 *  thing that could not be matched by eye, so it uses `useId` like the rest. */
function LabeledMonth({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="month"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-8 w-full rounded-md bg-surface px-2.5 text-sm text-fg outline-none",
          "ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent"
        )}
      />
    </div>
  )
}

/** One active filter, said as a removable chip. Never a naked value — a
 *  reader glancing at "Q1" has no idea whether that is a quartile or a
 *  minimum amount, so every chip names its own dimension. */
function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-selected px-2 py-1 text-sm text-fg">
      {/* A pasted search term is not length-limited, and a chip that cannot
          shrink pushes the page itself sideways on a phone. */}
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="grid size-4 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  )
}
