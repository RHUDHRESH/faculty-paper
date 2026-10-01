import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Download, ExternalLink, Search } from "lucide-react"

import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { Rows } from "@/ui/section"
import { Pagination } from "@/ui/pagination"
import { Avatar, initialsOf } from "@/ui/person"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { type Column, Table } from "@/ui/table"
import { ColumnLabel, Meta } from "@/ui/text"
import { type Brief, n } from "@/pages/principal-parts"

/**
 * The papers behind any figure on the Principal's reports.
 *
 * "Can I trust this number?" is answered by opening the papers it counts, so
 * every figure on the brief links here with its filter already applied
 * (?year=2025&department=BME&quartile=top). The count comes from the same
 * service as the brief (core/services/college_totals.py), so the total at the
 * top of this page is the figure that was clicked.
 */

type Author = { user_id: string | null; name: string; department: string; photo_url?: string | null; initials?: string }
type PaperRow = {
  id: string
  source: "record" | "claims"
  title: string
  journal: string
  year: number | null
  quartile: string | null
  doi: string | null
  departments: string[]
  authors: Author[]
  claim_id: string | null
  claim_no: string | null
}
type Payload = {
  total: number
  results: PaperRow[]
  by_quartile: Record<string, number>
}

const PAGE = 25
const NOT_RECORDED = "Department not recorded"

const QUARTILES: ComboboxOption[] = [
  { value: "", label: "Any quartile" },
  { value: "top", label: "Q1 or Q2" },
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
  { value: "none", label: "Quartile not recorded" },
]

function Authors({ authors }: { authors: Author[] }) {
  if (authors.length === 0) return null
  const shown = authors.slice(0, 3)
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {shown.map((a) => (
        <span key={`${a.user_id}-${a.name}`} className="inline-flex items-center gap-1.5">
          <Avatar
            size="sm"
            person={{ name: a.name, initials: a.initials ?? initialsOf(a.name), photo_url: a.photo_url ?? null }}
          />
          {a.user_id ? (
            <Link to={`/faculty/${a.user_id}`} className="underline-offset-4 hover:underline">
              {a.name}
            </Link>
          ) : (
            a.name
          )}
        </span>
      ))}
      {authors.length > shown.length && <Meta>and {authors.length - shown.length} more</Meta>}
    </span>
  )
}

function Title({ p }: { p: PaperRow }) {
  const text = paperTitle(p.title) || "Untitled"
  if (p.claim_id)
    return (
      <Link to={`/papers/${p.claim_id}`} className="font-medium underline-offset-4 hover:underline">
        {text}
      </Link>
    )
  if (p.doi)
    return (
      <a
        href={`https://doi.org/${p.doi}`}
        target="_blank"
        rel="noreferrer"
        className="font-medium underline-offset-4 hover:underline"
      >
        {text}
        <ExternalLink className="ml-1 inline size-3 text-fg-subtle" aria-label="opens the paper at its DOI" />
      </a>
    )
  return <span className="font-medium">{text}</span>
}

export function ReportPapers() {
  const [params, setParams] = useSearchParams()
  const year = params.get("year") ?? ""
  const department = params.get("department") ?? ""
  const quartile = params.get("quartile") ?? ""
  const q = params.get("q") ?? ""
  const page = Math.max(0, Number(params.get("page") ?? 0) || 0)
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])

  const set = (patch: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v)
        else next.delete(k)
      }
      if (!("page" in patch)) next.delete("page")
      return next
    })

  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => set({ q: draft.trim() }), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const brief = useApi<Brief>(["reports-brief", ""], "/api/reports/brief")
  const depts = useApi<string[]>(["meta", "departments"], "/api/meta/departments")

  const query = new URLSearchParams()
  if (year) query.set("year", year)
  if (department) query.set("department", department)
  if (quartile) query.set("quartile", quartile)
  if (q) query.set("q", q)
  const list = useApi<Payload>(
    ["reports-papers", query.toString(), page],
    `/api/reports/papers?${query.toString()}${query.toString() ? "&" : ""}limit=${PAGE}&offset=${page * PAGE}`,
    { placeholderData: (prev) => prev }
  )
  const d = list.data

  const yearOptions: ComboboxOption[] = [
    { value: "", label: "Every year" },
    ...(brief.data?.years_available ?? []).map((y) => ({ value: String(y), label: String(y) })),
  ]
  const deptOptions: ComboboxOption[] = [
    { value: "", label: "Every department" },
    ...(depts.data ?? []).map((x) => ({ value: x, label: x })),
    ...(depts.data?.includes(NOT_RECORDED) ? [] : [{ value: NOT_RECORDED, label: NOT_RECORDED }]),
  ]

  const scope = [
    year ? `of ${year}` : "in every year",
    department ? (department === NOT_RECORDED ? "with no department recorded" : `in ${department}`) : "in every department",
    quartile ? QUARTILES.find((o) => o.value === quartile)?.label : "",
    q ? `matching “${q}”` : "",
  ]
    .filter(Boolean)
    .join(", ")

  const filtered = Boolean(year || department || quartile || q)

  const columns: Column<PaperRow>[] = [
    {
      key: "paper",
      header: "Paper",
      className: "max-w-[28rem]",
      cell: (p) => (
        <>
          <Title p={p} />
          <Meta className="mt-0.5 block">
            {[p.departments.join(", ") || "No department recorded", p.claim_no].filter(Boolean).join(" · ")}
          </Meta>
        </>
      ),
    },
    { key: "authors", header: "Authors", cell: (p) => <Authors authors={p.authors} /> },
    { key: "journal", header: "Journal", className: "max-w-[16rem]", cell: (p) => p.journal },
    { key: "year", header: "Year", align: "right", cell: (p) => p.year },
    { key: "quartile", header: "Quartile", align: "right", cell: (p) => p.quartile },
  ]

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Papers"
        sub={
          d ? (
            <>
              <strong className="text-fg">{n(d.total)} papers</strong> {scope}. The list behind the figures on the year
              brief.
            </>
          ) : (
            "The list behind the figures on the year brief."
          )
        }
        action={
          <Button asChild className="print:hidden">
            <a href={`/api/reports/papers/export?${query.toString()}`} download>
              <Download />
              Download {d ? `these ${n(d.total)} papers` : "these papers"}
            </a>
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div className="w-32">
          <ColumnLabel className="mb-1 block">Year</ColumnLabel>
          <Combobox aria-label="Year" value={year} onChange={(v) => set({ year: v })} options={yearOptions} />
        </div>
        <div className="w-56">
          <ColumnLabel className="mb-1 block">Department</ColumnLabel>
          <Combobox
            aria-label="Department"
            value={department}
            onChange={(v) => set({ department: v })}
            options={deptOptions}
          />
        </div>
        <div className="w-48">
          <ColumnLabel className="mb-1 block">Journal quartile</ColumnLabel>
          <Combobox aria-label="Journal quartile" value={quartile} onChange={(v) => set({ quartile: v })} options={QUARTILES} />
        </div>
        <div className="relative w-full min-w-0 sm:w-64">
          <ColumnLabel className="mb-1 block">Search</ColumnLabel>
          <Search className="pointer-events-none absolute bottom-2.5 left-2.5 size-4 text-fg-subtle" aria-hidden />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Title, journal, DOI or author"
            aria-label="Search papers"
            className="pl-8"
          />
        </div>
        {filtered && (
          <Button kind="quiet" onClick={() => setParams({})}>
            Clear filters
          </Button>
        )}
      </div>

      {list.isError ? (
        <ErrorState title="The papers could not be loaded" message="Try again in a moment." onRetry={() => list.refetch()} />
      ) : !d ? (
        <SkeletonRows rows={8} rowHeight={56} />
      ) : (
        <>
          {/* A phone gets each paper as a title and one line of facts; the kit's
              stacked table would print five labelled lines under every title. */}
          <Rows className="sm:hidden">
            {d.results.map((p) => (
              <li key={p.id} className="space-y-1 py-3">
                <Title p={p} />
                <Authors authors={p.authors} />
                <Meta className="block">
                  {[p.journal || "Journal not recorded", p.year ?? "Year not recorded", p.quartile ?? "Quartile not recorded"].join(
                    " · "
                  )}
                </Meta>
                <Meta className="block">{p.departments.join(", ") || "No department recorded"}</Meta>
              </li>
            ))}
          </Rows>
          <div className={d.results.length ? "max-sm:hidden" : undefined}>
            <Table
              rows={d.results}
              columns={columns}
              getKey={(p) => p.id}
              maxHeight="none"
              minWidth="52rem"
              stack={false}
              caption={`Papers ${scope}`}
              empty={{
                art: "no-results",
                title: "No paper matches",
                message: "Widen the year or the department, or clear the search.",
                action: filtered ? <Button onClick={() => setParams({})}>Clear filters</Button> : undefined,
              }}
            />
          </div>
          <Pagination page={page} pageSize={PAGE} total={d.total} onChange={(p) => set({ page: p ? String(p) : "" })} />
        </>
      )}
    </div>
  )
}
