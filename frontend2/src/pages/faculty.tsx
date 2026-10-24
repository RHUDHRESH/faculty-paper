import { useEffect, useState } from "react"
import { Link, Navigate, useSearchParams } from "react-router-dom"
import { ArrowDown, ArrowUp, Download, ExternalLink, Search, SearchX, Users } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Checkbox, Input } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Avatar } from "@/ui/person"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { AnswerLine, AnswerWord } from "@/ui/answer"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import {
  MISSING_WORDS,
  count,
  paperDate,
  type DirectoryPayload,
  type FacultyRow,
  type MissingKey,
} from "@/pages/faculty-types"

/**
 * The faculty directory: every faculty member as a row of a real table, with
 * the things the office is asked about most (photo, Scopus ID, papers,
 * claims, incentives) on one line, and the whole record one click away
 * (`/faculty/:id`, see faculty-record.tsx).
 *
 * The server decides what a reader may see; this page asks for what is
 * there. A head of department gets their own department and no `incentive`
 * on any row but their own, so the money column simply does not appear.
 */

/** The page sizes on offer; the API takes at most 100 a page. */
const PAGE_SIZES = [30, 50, 100]
const PAGE_SIZE = 30
/** Export: the API's largest page, and the most rows one file will carry. */
const EXPORT_PAGE = 100
const EXPORT_LIMIT = 5000
/** The width from which Citations and Last paper are shown by default. */
const WIDE_QUERY = "(min-width: 1536px)"

const TYPE_OPTIONS: ComboboxOption[] = [
  { value: "", label: "All faculty" },
  { value: "REGULAR", label: "Regular faculty" },
  { value: "RESEARCH", label: "Research faculty" },
]

const MISSING_OPTIONS: ComboboxOption[] = [
  { value: "", label: "Any record" },
  ...(Object.keys(MISSING_WORDS) as MissingKey[]).map((k) => ({ value: k, label: MISSING_WORDS[k] })),
]

const SCOPUS_OPTIONS: ComboboxOption[] = [
  { value: "", label: "All faculty" },
  { value: "linked", label: "Linked to Scopus" },
  { value: "no_id", label: "No Scopus ID" },
  { value: "never_synced", label: "Never synced" },
  { value: "gap", label: "Papers missing from Scopus" },
]

const SORT_OPTIONS: ComboboxOption[] = [
  { value: "name", label: "Name" },
  { value: "department", label: "Department" },
  { value: "papers", label: "Papers on record" },
  { value: "citations", label: "Citations" },
  { value: "h_index", label: "h-index" },
  { value: "last_paper", label: "Last paper" },
  { value: "claims", label: "Claims filed this year" },
  { value: "completeness", label: "Profile completeness" },
]

/** "12 Oct 2026" from an ISO time, or null when there is none. */
function syncedLabel(iso: string | null | undefined, withYear = true): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-IN", withYear ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" })
}

/** "Missing from the record", without the Scopus gap (the Scopus column says it). */
function missingList(r: FacultyRow): string {
  return r.missing
    .filter((m) => m !== "scopus")
    .map((m) => MISSING_WORDS[m].replace(/^No /, ""))
    .join(", ")
}

function isWide(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(WIDE_QUERY).matches
}

export function FacultyDirectory() {
  const { me } = useAuth()
  if (me?.role === "FACULTY") return <Navigate to="/faculty/me" replace />
  return <Directory />
}

function useParamSetter() {
  const [params, setParams] = useSearchParams()
  const set = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v)
          else next.delete(k)
        }
        if (!("page" in changes)) next.delete("page")
        return next
      },
      { replace: true }
    )
  return [params, set, setParams] as const
}

function Directory() {
  const { me } = useAuth()
  const [params, set, setParams] = useParamSetter()
  const q = params.get("q") ?? ""
  const department = params.get("department") ?? ""
  const type = params.get("type") ?? ""
  const missing = params.get("missing") ?? ""
  const scopus = params.get("scopus") ?? ""
  const noPapers = params.get("nopapers") === "1"
  const left = params.get("left") === "1"
  const sort = params.get("sort") ?? "name"
  const dir = params.get("dir") === "desc" ? "desc" : "asc"
  const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0)
  const limitParam = Number.parseInt(params.get("limit") ?? "", 10)
  const limit = PAGE_SIZES.includes(limitParam) ? limitParam : PAGE_SIZE

  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => set({ q: draft || null }), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, q])

  const filters = new URLSearchParams()
  if (q) filters.set("q", q)
  if (department) filters.set("department", department)
  if (type) filters.set("faculty_type", type)
  if (missing) filters.set("missing", missing)
  if (scopus) filters.set("scopus", scopus)
  if (noPapers) filters.set("no_papers_year", "true")
  if (left) filters.set("include_left", "true")
  filters.set("sort", sort)
  filters.set("dir", dir)
  const listQuery = new URLSearchParams(filters)
  listQuery.set("limit", String(limit))
  listQuery.set("offset", String(page * limit))

  const list = useApi<DirectoryPayload>(
    ["faculty-directory", listQuery.toString()],
    `/api/directory/faculty?${listQuery.toString()}`,
    { placeholderData: (prev) => prev }
  )
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments")
  const seesEveryone = list.data ? list.data.scope === "college" : can(me?.role).seeCollege
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "All departments" },
    ...(departments.data || []).map((d) => ({ value: d, label: d })),
  ]

  const data = list.data
  const year = data?.year ?? new Date().getFullYear()
  const rows = data?.results ?? []
  const summary = data?.scopus_summary
  const noScopus = summary?.without_id ?? data?.counts.no_scopus ?? 0
  const filtered = Boolean(q || department || type || missing || scopus || noPapers || left)
  const office = can(me?.role).manageUsers
  // A head sees their own department only, so the list drops what is the same
  // on every row (the department) and what is not theirs to chase (claims).
  const headView = data?.scope === "department"
  const sortOptions = headView ? SORT_OPTIONS.filter((o) => o.value !== "department" && o.value !== "claims") : SORT_OPTIONS
  const columns = facultyColumns({ year, money: Boolean(data?.money), head: headView, office, wide: isWide() })

  function clear() {
    setDraft("")
    setParams(new URLSearchParams(), { replace: true })
  }

  function sortBy(key: string) {
    if (sort === key) set({ dir: dir === "asc" ? "desc" : null })
    else set({ sort: key, dir: ["papers", "citations", "h_index", "last_paper", "claims", "completeness"].includes(key) ? "desc" : null })
  }

  /** Every row the current filters match, following `offset` to the total (capped). */
  async function fetchAllRows(): Promise<FacultyRow[]> {
    const out: FacultyRow[] = []
    let offset = 0
    let total = Number.POSITIVE_INFINITY
    while (offset < total && out.length < EXPORT_LIMIT) {
      const qs = new URLSearchParams(filters)
      qs.set("limit", String(EXPORT_PAGE))
      qs.set("offset", String(offset))
      const res = await api<DirectoryPayload>(`/api/directory/faculty?${qs.toString()}`)
      total = res.total
      if (res.results.length === 0) break
      out.push(...res.results)
      offset += res.results.length
    }
    return out.slice(0, EXPORT_LIMIT)
  }

  const words: string[] = []
  if (q) words.push(`search "${q}"`)
  if (department) words.push(department)
  if (type) words.push(TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type)
  if (missing) words.push(MISSING_WORDS[missing as MissingKey] ?? missing)
  if (scopus) words.push(SCOPUS_OPTIONS.find((o) => o.value === scopus)?.label ?? scopus)
  if (noPapers) words.push(`no papers in ${year}`)
  if (left) words.push("including people who have left")
  const headline = data ? `${count(data.total)} of ${count(data.counts.people)} faculty` : "Faculty"
  const subtitle = (words.length ? `${headline}, filtered by ${words.join(", ")}.` : `${headline}.`) +
    (data && data.total > EXPORT_LIMIT ? ` The file holds the first ${count(EXPORT_LIMIT)}.` : "")

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Faculty"
        sub={data ? `${count(data.counts.people)} ${seesEveryone ? "faculty at the college" : "faculty in your department"}.` : undefined}
        spot="spot-people"
        action={
          <Button asChild kind="primary" size="md">
            <a href={`/api/directory/faculty/export.csv?${filters.toString()}`} download>
              <Download />
              Export as CSV
            </a>
          </Button>
        }
      />

      {summary && (
        <div className="space-y-2">
          <AnswerLine>
            {count(summary.with_id)} of {count(summary.faculty)} faculty are linked to Scopus.{" "}
            {summary.without_id > 0 ? (
              <AnswerWord tone="amber">{count(summary.without_id)} are not</AnswerWord>
            ) : (
              <AnswerWord tone="sage">all linked</AnswerWord>
            )}
          </AnswerLine>
          <p className="text-base text-fg-muted">
            {count(summary.scopus_papers)} of {count(summary.papers)} papers on record are Scopus-linked. Last synced{" "}
            {syncedLabel(summary.last_synced_at) ?? "never"}.
          </p>
        </div>
      )}

      {missing && <MissingHint kind={missing} office={office} />}

      <div className={filterBar}>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search name, staff ID or Scopus ID"
            aria-label="Search faculty"
            className="pl-8"
          />
        </div>
        {seesEveryone && (
          <Combobox
            value={department}
            onChange={(v) => set({ department: v || null })}
            options={departmentOptions}
            placeholder="All departments"
            aria-label="Filter by department"
            className="w-52"
          />
        )}
        <Combobox
          value={type}
          onChange={(v) => set({ type: v || null })}
          options={TYPE_OPTIONS}
          placeholder="All faculty"
          aria-label="Filter by faculty type"
          className="w-52"
        />
        <Combobox
          value={missing}
          onChange={(v) => set({ missing: v || null })}
          options={MISSING_OPTIONS}
          placeholder="Any record"
          aria-label="Filter by what is missing"
          className="w-48"
        />
        <Combobox
          value={scopus}
          onChange={(v) => set({ scopus: v || null })}
          options={SCOPUS_OPTIONS}
          placeholder="All faculty"
          aria-label="Filter by Scopus"
          className="w-52"
        />
        <div className="flex h-9 items-center max-sm:h-10">
          <Checkbox
            checked={noPapers}
            onCheckedChange={(v) => set({ nopapers: v === true ? "1" : null })}
            label={`No papers in ${year}`}
          />
        </div>
        {office && (data?.counts.left ?? 0) > 0 && (
          <div className="flex h-9 items-center max-sm:h-10">
            <Checkbox
              checked={left}
              onCheckedChange={(v) => set({ left: v === true ? "1" : null })}
              label={`Include ${count(data!.counts.left)} who have left`}
            />
          </div>
        )}
        <div className="flex items-center gap-1 sm:ml-auto">
          <Combobox
            value={sort}
            onChange={(v) => sortBy(v)}
            options={sortOptions}
            aria-label="Sort by"
            className="w-52"
          />
          <Button
            kind="quiet"
            size="icon"
            aria-label={dir === "asc" ? "Sorted ascending. Reverse" : "Sorted descending. Reverse"}
            onClick={() => set({ dir: dir === "asc" ? "desc" : null })}
          >
            {dir === "asc" ? <ArrowUp /> : <ArrowDown />}
          </Button>
        </div>
      </div>

      {data && filtered && (
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-fg-muted" aria-live="polite">
          <span>
            {count(data.total)} of {count(data.counts.people)} faculty match.
          </span>
          <Button kind="quiet" size="sm" onClick={clear}>
            Clear filters
          </Button>
        </p>
      )}

      {list.isLoading ? (
        <SkeletonRows rows={8} rowHeight={64} />
      ) : list.isError ? (
        list.error?.status === 403 ? (
          <ErrorState
            title="Not open to this account"
            message="The directory is for the college office and heads of department."
          />
        ) : (
          <ErrorState
            title="Could not load the faculty"
            message="The server did not answer. Nothing has been lost."
            onRetry={() => list.refetch()}
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : Users}
          title={filtered ? "Nobody matches" : "No faculty yet"}
          message={filtered ? "Try clearing a filter." : "Faculty appear here once their accounts are created."}
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={clear}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {noScopus > 0 && (
            <p className="text-base text-fg-muted">
              {count(noScopus)} {noScopus === 1 ? "person has" : "faculty have"} no Scopus ID. Open a person to add it.
            </p>
          )}
          <Table<FacultyRow>
            caption="Faculty"
            rows={rows}
            columns={columns}
            getKey={(r) => r.id}
            stack
            minWidth="50rem"
            sortKey={sort}
            sortDir={dir}
            onSort={sortBy}
            tools={{ id: "faculty", title: "Faculty", subtitle, getAllRows: fetchAllRows }}
          />
          <div className="flex items-center justify-end gap-2">
            <Meta>Show</Meta>
            <Combobox
              value={String(limit)}
              onChange={(v) => set({ limit: v === String(PAGE_SIZE) ? null : v, page: null })}
              options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
              aria-label="Rows per page"
              className="w-24"
            />
          </div>
          <Pagination
            page={page}
            pageSize={limit}
            total={data?.total ?? 0}
            onChange={(p) => set({ page: p ? String(p) : null })}
          />
        </>
      )}
    </div>
  )
}

/**
 * The columns the list shows, in order. Faculty is always first (the table
 * locks it on). Citations, Last paper and Missing start hidden; the reader
 * shows them from the Columns menu. Citations and Last paper start shown at 2xl.
 */
function facultyColumns(o: { year: number; money: boolean; head: boolean; office: boolean; wide: boolean }): Column<FacultyRow>[] {
  const cols: Column<FacultyRow>[] = [
    {
      key: "name",
      header: "Faculty",
      sortable: true,
      exportValue: (r) => r.name,
      exportKind: "text",
      cell: (r) => <FacultyCell row={r} office={o.office} />,
    },
  ]
  if (!o.head) {
    cols.push({
      key: "department",
      header: "Department",
      sortable: true,
      empty: "No department",
      exportValue: (r) => r.department,
      exportKind: "text",
      cell: (r) => <DepartmentCell row={r} office={o.office} />,
    })
  }
  cols.push(
    {
      key: "scopus",
      header: "Scopus",
      exportValue: (r) => (r.scopus_author_id ? `Linked ${r.scopus_author_id}` : "No Scopus ID"),
      exportKind: "text",
      cell: (r) => <ScopusCell row={r} />,
    },
    {
      key: "in_scopus",
      header: "In Scopus",
      align: "right",
      exportValue: (r) => r.scopus_papers ?? null,
      exportKind: "number",
      cell: (r) => (
        <span className={cn("tabular", r.papers === 0 && "text-fg-muted")}>
          {count(r.scopus_papers)} of {count(r.papers)}
        </span>
      ),
    },
    {
      key: "last_synced",
      header: "Last synced",
      exportValue: (r) => r.scopus_synced_at ?? null,
      exportKind: "date",
      cell: (r) => <SyncedCell row={r} />,
    },
    {
      key: "papers",
      header: "Papers",
      align: "right",
      sortable: true,
      exportValue: (r) => r.papers,
      exportKind: "number",
      cell: (r) => (
        <div>
          <span className="tabular block">{count(r.papers)}</span>
          <span className={cn("tabular block text-sm", r.papers_year === 0 ? "text-caution" : "text-fg-muted")}>
            {count(r.papers_year)} in {o.year}
          </span>
        </div>
      ),
    }
  )
  if (!o.head) {
    cols.push({
      key: "claims",
      header: `Claims in ${o.year}`,
      align: "right",
      sortable: true,
      exportValue: (r) => r.claims_filed_year,
      exportKind: "number",
      cell: (r) => (
        <div>
          <span className="tabular block">{count(r.claims_filed_year)} filed</span>
          <span className="tabular block text-sm text-fg-muted">
            {count(r.claims_done_year)} {o.money ? "paid" : "completed"}
          </span>
        </div>
      ),
    })
  }
  if (o.money) {
    cols.push({
      key: "incentive",
      header: `Incentives paid in ${o.year}`,
      align: "right",
      exportValue: (r) => r.incentive?.amount ?? null,
      exportKind: "money",
      cell: (r) =>
        r.incentive ? (
          <div>
            <span className="tabular block">{money(r.incentive.amount)}</span>
            <span className="tabular block text-sm text-fg-muted">{money(r.incentive.total_amount)} in all years</span>
          </div>
        ) : (
          <span className="text-fg-muted">Not shown</span>
        ),
    })
  }
  cols.push(
    {
      key: "citations",
      header: "Citations",
      align: "right",
      sortable: true,
      defaultHidden: !o.wide,
      exportValue: (r) => r.citations,
      exportKind: "number",
      cell: (r) => (
        <div>
          <span className="tabular block">{count(r.citations)}</span>
          <span className="tabular block text-sm text-fg-muted">h-index {r.h_index}</span>
        </div>
      ),
    },
    {
      key: "last_paper",
      header: "Last paper",
      sortable: true,
      defaultHidden: !o.wide,
      exportValue: (r) => r.last_paper_on ?? r.last_paper_year ?? null,
      exportKind: "date",
      cell: (r) => <span>{r.last_paper_year ? paperDate(r.last_paper_on, r.last_paper_year) : "None yet"}</span>,
    },
    {
      key: "missing",
      header: "Missing",
      defaultHidden: true,
      empty: "None",
      exportValue: (r) => missingList(r) || null,
      exportKind: "text",
      cell: (r) => (missingList(r) ? <span className="text-caution">{missingList(r)}</span> : null),
    }
  )
  return cols
}

function FacultyCell({ row: r, office }: { row: FacultyRow; office: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar person={r} size="md" />
      <div className="min-w-0 flex-1">
        <Link
          to={`/faculty/${r.id}`}
          className={cn("block truncate font-medium hover:underline", !r.active && "text-fg-muted")}
        >
          {r.name}
        </Link>
        <Meta className="block truncate">
          {[r.staff_id, r.designation].filter(Boolean).join(" · ") || "No staff ID or designation"}
        </Meta>
        {!r.active && <Meta className="block truncate">No longer at the college</Meta>}
        {r.faculty_type === "RESEARCH" && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Chip tone="area" area="research" title="On a research post, with a yearly paper threshold">
              Research faculty
            </Chip>
            <Threshold row={r} office={office} />
          </div>
        )}
      </div>
    </div>
  )
}

function DepartmentCell({ row: r, office }: { row: FacultyRow; office: boolean }) {
  return (
    <div className="min-w-0">
      {r.department}
      {office && r.missing.some((m) => m !== "photo" && m !== "scopus") && (
        <div>
          <Button kind="quiet" size="sm" asChild className="-ml-2 mt-0.5">
            <Link to={`/people/${r.id}`}>Fix on the account</Link>
          </Button>
        </div>
      )}
    </div>
  )
}

function ScopusCell({ row: r }: { row: FacultyRow }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
      {r.scopus_author_id ? (
        <>
          <Chip tone="positive">Linked</Chip>
          <a
            href={r.scopus_url ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-fg underline-offset-2 hover:underline"
            aria-label={`Scopus author page for ${r.name}`}
          >
            <span className="tabular">{r.scopus_author_id}</span>
            <ExternalLink aria-hidden className="size-3.5 text-fg-subtle" />
          </a>
        </>
      ) : (
        <Chip tone="caution">No Scopus ID</Chip>
      )}
      {r.orcid_id && (
        <a
          href={r.orcid_url ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-fg-muted underline-offset-2 hover:underline"
        >
          ORCID
          <ExternalLink aria-hidden className="size-3.5" />
        </a>
      )}
    </div>
  )
}

function SyncedCell({ row: r }: { row: FacultyRow }) {
  const label = syncedLabel(r.scopus_synced_at)
  const tone = label ? "text-fg" : r.scopus_author_id ? "text-caution" : "text-fg-muted"
  return <span className={cn("tabular", tone)}>{label ?? "Never"}</span>
}

function Threshold({ row: r, office }: { row: FacultyRow; office: boolean }) {
  const text = r.threshold_set
    ? r.threshold != null
      ? `Threshold ${r.threshold} a year`
      : "Threshold set"
    : "Threshold not set"
  const inner = <span className={cn("text-xs", r.threshold_set ? "text-fg-muted" : "text-caution")}>{text}</span>
  if (!office) return inner
  return (
    <Link to={`/people/${r.id}`} className="underline-offset-2 hover:underline" title="Open the account to change the threshold">
      {inner}
    </Link>
  )
}

/* ------------------------------------------------------------------------ */
/* What a "missing" filter means                                            */
/* ------------------------------------------------------------------------ */

const MISSING_HINT: Record<string, { who: "person" | "office"; text: string }> = {
  photo: { who: "person", text: "Only they can add a photo, so ask them." },
  scopus: { who: "office", text: "Add the Scopus author ID on their account." },
  department: { who: "office", text: "Choose the department on their account." },
  designation: { who: "office", text: "Add the designation on their account." },
}

/** One line under the filters saying who fixes what the list is showing. */
function MissingHint({ kind, office }: { kind: string; office: boolean }) {
  const h = MISSING_HINT[kind]
  if (!h) return null
  return (
    <p className="text-sm text-fg-muted" data-testid="missing-hint">
      {MISSING_WORDS[kind as MissingKey]}. {office || h.who === "person" ? h.text : "The research office fixes this."}
    </p>
  )
}
