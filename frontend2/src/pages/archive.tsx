import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { FileSearch, Search, SearchX } from "lucide-react"

import { useAuth } from "@/app/auth"
import { reviewsFlags } from "@/app/nav"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input, NumberInput } from "@/ui/field"
import { money, Stage, stageOf } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, Sub } from "@/ui/text"

/**
 * Looking into the past: every claim filed with the college, paid and
 * imported ones included, for the desks that judge a paper.
 *
 * The chain's own queues only ever show what is still moving, so a paper
 * paid last year -- or brought across from the old ERP -- had no screen a
 * reviewer could find it from to go back and ask a question about it. Each
 * row opens on the claim's ordinary page, where its files can be read and a
 * flag raised; the open flags on each row are the one thing this list adds.
 */

const PAGE_SIZE = 25

type Row = {
  id: string
  ticket_number: string | null
  paper_title: string | null
  journal_title: string | null
  publication_year: number | null
  status: string
  status_note: string | null
  owner_name: string
  owner_department: string | null
  remuneration: number | null
  paid_at: string | null
  file_count: number
  open_flags: number
}

type Payload = { total: number; limit: number; offset: number; results: Row[] }

const STATUS_OPTIONS: ComboboxOption[] = [
  { value: "", label: "Any status" },
  { value: "PAID", label: "Paid" },
  { value: "SUBMITTED", label: "Filed" },
  { value: "CLEARED", label: "Checked" },
  { value: "PRINCIPAL_APPROVED", label: "Approved" },
  { value: "DIRECTOR_APPROVED", label: "Authorised" },
  { value: "REJECTED", label: "Sent back" },
  { value: "HOD_APPROVED", label: "Filed (old chain)" },
  { value: "RESEARCH_APPROVED", label: "Checked (old chain)" },
  { value: "FINANCE_APPROVED", label: "Approved (old chain)" },
]

const FLAGGED_FILTERS = [
  { value: "", label: "All" },
  { value: "open", label: "With open flags" },
  { value: "none", label: "No open flags" },
]

export function PastClaims() {
  const { me } = useAuth()
  const allowed = reviewsFlags(me?.role)
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const status = searchParams.get("status") ?? ""
  const year = searchParams.get("year") ?? ""
  const department = searchParams.get("department") ?? ""
  const flagged = searchParams.get("flagged") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  function setParam(name: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(name, value)
      else next.delete(name)
      if (name !== "page") next.delete("page")
      return next
    })
  }

  // Typed boxes settle before they ask the server, so a search is one
  // request rather than one per keystroke.
  const [searchDraft, setSearchDraft] = useState(q)
  const [yearDraft, setYearDraft] = useState(year)
  useEffect(() => setSearchDraft(q), [q])
  useEffect(() => setYearDraft(year), [year])
  useEffect(() => {
    if (searchDraft === q && yearDraft === year) return
    const t = setTimeout(() => {
      // One update for both boxes. Two in the same tick each start from the
      // URL as this render saw it, so the second silently undid the first
      // and a search typed just before a year was dropped.
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          const term = searchDraft.trim()
          if (term) next.set("q", term)
          else next.delete("q")
          if (yearDraft === "") next.delete("year")
          else if (/^\d{4}$/.test(yearDraft)) next.set("year", yearDraft)
          next.delete("page")
          return next
        },
        { replace: true }
      )
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft, yearDraft])

  const query = new URLSearchParams()
  if (q) query.set("q", q)
  if (status) query.set("status", status)
  if (year) query.set("year", year)
  if (department) query.set("department", department)
  if (flagged) query.set("flagged", flagged)
  query.set("limit", String(PAGE_SIZE))
  query.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<Payload>(
    ["archive", query.toString()],
    `/api/archive/claims?${query.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments", {
    enabled: allowed,
  })

  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) setParam("page", maxPage > 0 ? String(maxPage) : "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          art="closed-gate"
          title="Not open to this account"
          message="Past claims are for the research cell, the coordinator, the Principal and the super admin, who can reopen any claim and flag it."
        />
      </div>
    )
  }

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const filtered = Boolean(q || status || year || department || flagged)
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "Any department" },
    ...(departments.data ?? []).map((d) => ({ value: d, label: d })),
  ]

  function clearAll() {
    setSearchDraft("")
    setYearDraft("")
    setSearchParams(new URLSearchParams())
  }

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>Past claims</PageTitle>
        <Sub className="mt-1">
          Every claim filed with the college, paid ones and those brought across from the old
          records included. Open one to read its files and raise a flag.
        </Sub>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title, ticket, DOI, ISSN or faculty"
            aria-label="Search past claims"
            className="pl-8"
          />
        </div>
        <Combobox value={status} onChange={(v) => setParam("status", v)} options={STATUS_OPTIONS} aria-label="Status" />
        <NumberInput
          value={yearDraft}
          onChange={(e) => setYearDraft(e.target.value)}
          placeholder="Publication year"
          aria-label="Publication year"
          min={1990}
          max={2100}
        />
        <Combobox
          value={department}
          onChange={(v) => setParam("department", v)}
          options={departmentOptions}
          aria-label="Department"
          className="sm:col-span-2"
        />
        <div className="flex flex-wrap items-center gap-1 sm:col-span-2" role="group" aria-label="Flags">
          {FLAGGED_FILTERS.map((f) => (
            <Chip key={f.value || "all"} active={flagged === f.value} onClick={() => setParam("flagged", f.value)}>
              {f.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="flex min-h-7 flex-wrap items-center gap-2" role="status" aria-live="polite">
        {!isLoading && !isError && (
          <Meta className="tabular">
            {total === 1 ? "1 claim" : `${total} claims`}
            {filtered ? " matching these filters" : ""}
          </Meta>
        )}
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clearAll}>
            Clear all
          </Button>
        )}
      </div>

      {isLoading && !data ? (
        <SkeletonRows rows={8} rowHeight={72} />
      ) : isError ? (
        <ErrorState
          title="Could not load past claims"
          message={
            error?.status === 403
              ? "Not allowed for this account."
              : "The server did not answer. Nothing has been changed."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          art="no-results"
          icon={filtered ? SearchX : FileSearch}
          title={filtered ? "No claim matches these filters" : "Nothing has been filed yet"}
          message={
            filtered
              ? "Try loosening one of the filters."
              : "Once claims are filed or imported, every one of them is listed here."
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
          <ul className="divide-y divide-line border-y border-line">
            {rows.map((r) => (
              <PastRow key={r.id} row={r} />
            ))}
          </ul>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={(n) => setParam("page", n > 0 ? String(n) : "")} />
        </>
      )}
    </div>
  )
}

/** One claim, stacked so it reads the same at 375px as on a desk. */
function PastRow({ row }: { row: Row }) {
  const paid = row.status === "PAID"
  return (
    <li className="row">
      <Link to={`/papers/${row.id}`} className="block px-1 py-3">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base">{row.paper_title || "Untitled"}</span>
            <Meta className="mt-0.5 block truncate">
              {[row.ticket_number, row.owner_name, row.owner_department].filter(Boolean).join(" · ")}
            </Meta>
          </span>
          <span className="shrink-0 text-right">
            <span className="block tabular text-sm font-medium">{money(row.remuneration)}</span>
            {paid && row.paid_at && <Meta className="block">Paid {formatDate(row.paid_at)}</Meta>}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Stage stage={stageOf(row.status)} className="w-[8rem]" />
          {row.open_flags > 0 && (
            <span className="rounded-sm bg-caution-wash px-1.5 py-0.5 text-xs font-medium text-caution">
              {row.open_flags === 1 ? "1 open flag" : `${row.open_flags} open flags`}
            </span>
          )}
          <Meta>
            {[
              row.journal_title,
              row.publication_year,
              row.file_count === 1 ? "1 file" : `${row.file_count} files`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Meta>
        </div>
      </Link>
    </li>
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
        "h-7 rounded-sm px-2 text-sm transition-colors duration-[var(--dur-1)] ease-out",
        active ? "bg-selected font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      )}
    >
      {children}
    </button>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
