"use client"

import { useSearchParams } from "react-router-dom"
import { useEffect, useMemo, useState } from "react"
import { Search as SearchIcon, X } from "lucide-react"

import { ClaimDetailFields } from "@/components/claim-detail-fields"
import { EmptyState, ErrorState, MasterDetail, PageHeader } from "@/components/layout/page"
import { Money, StatusChip, TicketProgress } from "@/components/ticket-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Pager } from "@/components/ui/pagination"
import { type Claim } from "@/lib/api"
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
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{anyLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
    p.set("sort", sort)
    p.set("limit", String(PAGE))
    p.set("offset", String(offset))
    return p.toString()
  }, [debouncedQ, department, status, quartile, category, engineering, year, owner, journal, sort, offset])

  const { data, isLoading: loading, isError, refetch } = useApiQuery<Results>(
    ["search", query],
    `/api/reports/search?${query}`
  )
  const { data: departments = [] } = useApiQuery<string[]>(
    ["meta", "departments"],
    "/api/meta/departments"
  )

  const activeCount = [
    q.trim(),
    department !== ANY,
    status !== ANY,
    quartile !== ANY,
    category !== ANY,
    engineering !== ANY,
    year.trim(),
    owner,
    journal,
  ].filter(Boolean).length

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
    setSort("recent")
    setOffset(0)
  }

  const listPanel = (
    <div className="space-y-3">
      <div className="surface-card p-4">
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="pl-9"
            placeholder="Title, journal, DOI, ISSN, ticket, faculty, staff ID…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search publications"
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Picker
            id="s-dept"
            label="Department"
            value={department}
            onChange={(v) => {
              setDepartment(v)
              setOffset(0)
            }}
            anyLabel="Any department"
            options={departments.map((d) => ({ value: d, label: d }))}
          />
          <Picker
            id="s-status"
            label="Status"
            value={status}
            onChange={(v) => {
              setStatus(v)
              setOffset(0)
            }}
            anyLabel="Any status"
            options={STATUSES.map((s) => ({ value: s, label: s }))}
          />
          <Picker
            id="s-quartile"
            label="Quartile"
            value={quartile}
            onChange={(v) => {
              setQuartile(v)
              setOffset(0)
            }}
            anyLabel="Any quartile"
            options={QUARTILES.map((s) => ({ value: s, label: s }))}
          />
          <Picker
            id="s-category"
            label="Category"
            value={category}
            onChange={(v) => {
              setCategory(v)
              setOffset(0)
            }}
            anyLabel="Any category"
            options={CATEGORIES}
          />
          <Picker
            id="s-eng"
            label="Classification"
            value={engineering}
            onChange={(v) => {
              setEngineering(v)
              setOffset(0)
            }}
            anyLabel="Any"
            options={[
              { value: "Engineering", label: "Engineering" },
              { value: "Non-Engineering", label: "Non-Engineering" },
            ]}
          />
          <div className="space-y-1.5">
            <Label htmlFor="s-year" className="text-xs">
              Publication year
            </Label>
            <Input
              id="s-year"
              inputMode="numeric"
              placeholder="Any"
              className="tabular-nums"
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
            className="sm:col-span-2"
          />
        </div>

        {activeCount > 0 ? (
          <Button type="button" variant="ghost" size="xs" className="mt-3" onClick={reset}>
            <X className="size-3.5" />
            Clear {activeCount} filter{activeCount === 1 ? "" : "s"}
          </Button>
        ) : null}
      </div>

      {/* Arrived here from somebody's record or a journal's. Say so, and let
          it be dropped: a filter narrowing the totals while invisible is how
          a reader ends up quoting a wrong figure. */}
      {owner || journal ? (
        <div className="flex flex-wrap items-center gap-2">
          {owner ? (
            <button
              type="button"
              onClick={() => { setOwner(""); setOffset(0) }}
              className="interactive inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs hover:border-destructive/50"
            >
              <span className="text-muted-foreground">Author:</span>
              <span className="font-medium">{ownerName || "one person"}</span>
              <X className="size-3 text-muted-foreground" aria-hidden />
            </button>
          ) : null}
          {journal ? (
            <button
              type="button"
              onClick={() => { setJournal(""); setOffset(0) }}
              className="interactive inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs hover:border-destructive/50"
            >
              <span className="text-muted-foreground">Journal:</span>
              <span className="font-medium">{journal}</span>
              <X className="size-3 text-muted-foreground" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Totals for the whole match, not the page — otherwise the number on
          screen answers a different question than the one asked. */}
      <div className="flex items-baseline justify-between gap-3 rounded-[var(--radius)] border border-border/80 bg-muted/40 px-4 py-2.5">
        <span className="text-sm text-muted-foreground">
          {loading ? "Searching…" : `${data?.total ?? 0} publication${data?.total === 1 ? "" : "s"}`}
        </span>
        <span className="text-sm font-semibold tabular-nums">
          <Money value={data?.total_amount ?? 0} />
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
    <EmptyState title="Select a publication" description="Pick a result to see the full record." />
  )

  return (
    <div>
      <PageHeader title="Query" subtitle="Search every publication across the college" />
      {isDesktop ? (
        <MasterDetail list={listPanel} detail={detailPanel} />
      ) : (
        <div className="space-y-4">
          {listPanel}
          {selected ? detailPanel : null}
        </div>
      )}
    </div>
  )
}
