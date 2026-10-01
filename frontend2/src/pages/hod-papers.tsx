import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Download, Search, X } from "lucide-react"

import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { useBrief } from "@/pages/hod-parts"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { Pagination } from "@/ui/pagination"
import { Avatar, initialsOf } from "@/ui/person"
import { Rows } from "@/ui/section"
import { Delayed, ErrorState, SkeletonRows } from "@/ui/state"
import { type Column, Table } from "@/ui/table"
import { ColumnLabel, Meta } from "@/ui/text"

/**
 * The department's papers, the list behind every figure on a head's pages
 * (`/api/hod/department/papers`). It counts what the Principal's list counts
 * for the department, from the college's publication record, so "261 papers"
 * on Home opens 261 rows here. This replaces a list of the department's
 * incentive claims (19 rows for ECE) that carried the same title and disagreed
 * with every other page.
 *
 * A head sees no money and nobody's claim: a row opens the paper, never the
 * claim behind it.
 */

type Author = { user_id: string | null; name: string; department: string; photo_url?: string | null }
type PaperRow = {
  id: string
  source: "record" | "claims"
  title: string
  journal: string
  year: number | null
  quartile: string | null
  doi: string | null
  issn: string | null
  indexed: boolean
  citations: number | null
  authors: Author[]
}
type Payload = {
  total: number
  department: string
  results: PaperRow[]
  by_quartile: Record<string, number>
  years: number[]
}

const PAGE = 25

const QUARTILES: ComboboxOption[] = [
  { value: "", label: "Any quartile" },
  { value: "top", label: "Q1 or Q2" },
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
  { value: "low", label: "Q3 or Q4" },
  { value: "none", label: "Quartile not recorded" },
]

const MISSING: Record<string, string> = { doi: "missing a DOI", issn: "missing an ISSN" }

function Authors({ authors }: { authors: Author[] }) {
  if (authors.length === 0) return null
  const shown = authors.slice(0, 3)
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {shown.map((a) => (
        <span key={`${a.user_id}-${a.name}`} className="inline-flex items-center gap-1.5">
          <Avatar size="sm" person={{ name: a.name, initials: initialsOf(a.name), photo_url: a.photo_url ?? null }} />
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

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex min-h-8 items-center gap-1 rounded-full bg-accent-wash px-3 text-sm text-fg">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove the filter: ${label}`}
        className="grid size-5 place-items-center rounded-full hover:bg-hover"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </span>
  )
}

export function HodPapers() {
  const [params, setParams] = useSearchParams()
  const year = params.get("year") ?? ""
  const quartile = params.get("quartile") ?? ""
  const person = params.get("person") ?? ""
  const missing = params.get("missing") ?? ""
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

  const brief = useBrief()
  const query = new URLSearchParams()
  if (year) query.set("year", year)
  if (quartile) query.set("quartile", quartile)
  if (person) query.set("person", person)
  if (missing) query.set("missing", missing)
  if (q) query.set("q", q)
  const list = useApi<Payload>(
    ["hod", "papers", query.toString(), page],
    `/api/hod/department/papers?${query.toString()}${query.toString() ? "&" : ""}limit=${PAGE}&offset=${page * PAGE}`,
    { placeholderData: (prev) => prev, retry: false }
  )
  const d = list.data
  const who = brief.data?.people.find((p) => p.id === person)

  const yearOptions: ComboboxOption[] = [
    { value: "", label: "Every year" },
    ...(d?.years ?? []).map((y) => ({ value: String(y), label: String(y) })),
  ]
  const personOptions: ComboboxOption[] = [
    { value: "", label: "Everyone in the department" },
    ...(brief.data?.people ?? []).map((p) => ({ value: p.id, label: p.name })),
  ]

  const filtered = Boolean(year || quartile || person || missing || q)
  const scope = [
    year ? `of ${year}` : "in every year",
    who ? `by ${who.name}` : "",
    quartile ? QUARTILES.find((o) => o.value === quartile)?.label : "",
    missing ? MISSING[missing] : "",
    q ? `matching “${q}”` : "",
  ]
    .filter(Boolean)
    .join(", ")
  const b = d?.by_quartile ?? {}
  // Nothing is a zero until the list has answered.
  const num = (v: number) => (d ? v : null)
  const link = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params)
    next.delete("page")
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    return `/publications?${next.toString()}`
  }

  const columns: Column<PaperRow>[] = [
    {
      key: "paper",
      header: "Paper",
      className: "max-w-[28rem]",
      cell: (p) => (
        <Link to={`/department/papers/${p.id}`} className="font-medium underline-offset-4 hover:underline">
          {paperTitle(p.title) || "Untitled"}
        </Link>
      ),
    },
    { key: "authors", header: "Authors", cell: (p) => <Authors authors={p.authors} /> },
    { key: "journal", header: "Journal", className: "max-w-[16rem]", cell: (p) => p.journal },
    { key: "year", header: "Year", align: "right", cell: (p) => p.year },
    { key: "quartile", header: "Quartile", align: "right", cell: (p) => p.quartile },
    {
      key: "doi",
      header: "DOI",
      empty: "No DOI",
      cell: (p) =>
        p.doi ? (
          <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
            Read the paper
          </a>
        ) : null,
    },
  ]

  return (
    <div className="page space-y-8">
      <PageHeader
        title="Department papers"
        sub={
          d ? (
            <>
              <strong className="text-fg">{formatCount(d.total)} papers</strong> {scope}. From the college record, the same
              papers the Principal counts for {d.department}.
            </>
          ) : (
            "Every paper the department's people have on the college record."
          )
        }
        action={
          <Button kind="primary" asChild>
            <a href={`/api/hod/department/papers/export?${query.toString()}`} download>
              <Download />
              Download {d ? `these ${formatCount(d.total)} papers` : "these papers"}
            </a>
          </Button>
        }
      />

      <Answer
        items={[
          { value: num(b.Q1 ?? 0), label: "in Q1 journals", zero: "None in Q1 journals", to: link({ quartile: "Q1" }) },
          { value: num(b.Q2 ?? 0), label: "in Q2 journals", zero: "None in Q2 journals", to: link({ quartile: "Q2" }) },
          {
            value: num((b.Q3 ?? 0) + (b.Q4 ?? 0)),
            label: "in Q3 or Q4 journals",
            zero: "None in Q3 or Q4 journals",
            to: link({ quartile: "low" }),
          },
          { value: num(b.none ?? 0), label: "with no quartile recorded", zero: "Every quartile is recorded", to: link({ quartile: "none" }) },
        ]}
      />

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div className="w-32">
          <ColumnLabel className="mb-1 block">Year</ColumnLabel>
          <Combobox aria-label="Year" value={year} onChange={(v) => set({ year: v })} options={yearOptions} />
        </div>
        <div className="w-48">
          <ColumnLabel className="mb-1 block">Journal quartile</ColumnLabel>
          <Combobox aria-label="Journal quartile" value={quartile} onChange={(v) => set({ quartile: v })} options={QUARTILES} />
        </div>
        <div className="w-56">
          <ColumnLabel className="mb-1 block">Author</ColumnLabel>
          <Combobox aria-label="Author" value={person} onChange={(v) => set({ person: v })} options={personOptions} />
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
      {missing && (
        <div className="-mt-4">
          <Chip label={`Papers ${MISSING[missing]}`} onRemove={() => set({ missing: "" })} />
        </div>
      )}

      {list.isError ? (
        <ErrorState what="the department's papers" onRetry={() => void list.refetch()} />
      ) : !d ? (
        <Delayed>
          <SkeletonRows rows={8} rowHeight={56} />
        </Delayed>
      ) : (
        <>
          {/* A phone gets each paper as a title and one line of facts; the kit's
              stacked table would print six labelled lines under every title. */}
          <Rows className="sm:hidden">
            {d.results.map((p) => (
              <li key={p.id} className="space-y-1 py-3">
                <Link to={`/department/papers/${p.id}`} className="font-medium underline-offset-4 hover:underline">
                  {paperTitle(p.title) || "Untitled"}
                </Link>
                <Authors authors={p.authors} />
                <Meta className="block">
                  {[p.journal || "Journal not recorded", p.year ?? "Year not recorded", p.quartile ?? "Quartile not recorded"].join(" · ")}
                </Meta>
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
              caption={`Department papers ${scope}`}
              empty={{
                art: "no-results",
                title: "No paper matches",
                message: "Widen the year, or clear the search.",
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
