import { useEffect, useState } from "react"
import { Link, Navigate, useSearchParams } from "react-router-dom"
import { ArrowDown, ArrowUp, Download, ExternalLink, Search, SearchX, Users } from "lucide-react"

import { can, useAuth } from "@/app/auth"
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
import { Answer } from "@/ui/answer"
import { ColumnLabel, Meta } from "@/ui/text"
import {
  MISSING_WORDS,
  count,
  paperDate,
  type DirectoryPayload,
  type FacultyRow,
  type MissingKey,
} from "@/pages/faculty-types"

/**
 * The faculty directory: every faculty member as a row, with the things the
 * office is asked about most (photo, Scopus ID, papers, citations, claims,
 * incentives) on one line, and the whole record one click away
 * (`/faculty/:id`, see faculty-record.tsx).
 *
 * The server decides what a reader may see; this page asks for what is
 * there. A head of department gets their own department and no `incentive`
 * on any row but their own, so the money column simply does not appear.
 */

const PAGE_SIZE = 30

const TYPE_OPTIONS: ComboboxOption[] = [
  { value: "", label: "All faculty" },
  { value: "REGULAR", label: "Regular faculty" },
  { value: "RESEARCH", label: "Research faculty" },
]

const MISSING_OPTIONS: ComboboxOption[] = [
  { value: "", label: "Any record" },
  ...(Object.keys(MISSING_WORDS) as MissingKey[]).map((k) => ({ value: k, label: MISSING_WORDS[k] })),
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

/** Columns of the wide layout. The money column is added for those who may see it. */
const GRID =
  "lg:grid-cols-[minmax(13rem,2.3fr)_minmax(10rem,1.6fr)_4.5rem_5.5rem_5.5rem_minmax(6.5rem,1fr)]"
/** A head's list: their own department, so no department line; and incentive
 *  claims are not their concern, so no claims column. */
const GRID_HEAD = "lg:grid-cols-[minmax(13rem,2.3fr)_minmax(10rem,1.6fr)_4.5rem_5.5rem_minmax(6.5rem,1fr)]"
const GRID_MONEY =
  "lg:grid-cols-[minmax(13rem,2.3fr)_minmax(10rem,1.6fr)_4.5rem_5.5rem_5.5rem_minmax(6.5rem,1fr)_minmax(6.5rem,1fr)]"

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
  const noPapers = params.get("nopapers") === "1"
  const left = params.get("left") === "1"
  const sort = params.get("sort") ?? "name"
  const dir = params.get("dir") === "desc" ? "desc" : "asc"
  const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0)

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
  if (noPapers) filters.set("no_papers_year", "true")
  if (left) filters.set("include_left", "true")
  filters.set("sort", sort)
  filters.set("dir", dir)
  const listQuery = new URLSearchParams(filters)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

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
  const filtered = Boolean(q || department || type || missing || noPapers || left)
  const office = can(me?.role).manageUsers
  // A head sees their own department only, so the list drops what is the same
  // on every row (the department) and what is not theirs to chase (claims).
  const headView = data?.scope === "department"
  const sortOptions = headView ? SORT_OPTIONS.filter((o) => o.value !== "department" && o.value !== "claims") : SORT_OPTIONS

  function clear() {
    setDraft("")
    setParams(new URLSearchParams(), { replace: true })
  }

  function sortBy(key: string) {
    if (sort === key) set({ dir: dir === "asc" ? "desc" : null })
    else set({ sort: key, dir: ["papers", "citations", "h_index", "last_paper", "claims", "completeness"].includes(key) ? "desc" : null })
  }

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Faculty"
        sub={
          data?.scope === "department"
            ? "Everyone in your department, with their Scopus ID and papers. Open a name for the whole record."
            : "Every faculty member with their photo, Scopus ID, papers and claims. Open a name for the whole record."
        }
        spot="spot-people"
        actions={
          <Button asChild kind="default" size="md">
            <a href={`/api/directory/faculty/export.csv?${filters.toString()}`} download>
              <Download />
              Export as CSV
            </a>
          </Button>
        }
      />

      <Answer
        items={[
          { value: data?.counts.people, label: seesEveryone ? "Faculty at the college" : "Faculty in your department", to: "/faculty" },
          { value: data?.counts.no_photo, label: "Without a photo", zero: "Everyone has a photo", to: "/faculty?missing=photo", tone: "caution" },
          { value: data?.counts.no_scopus, label: "Without a Scopus ID", zero: "Everyone has a Scopus ID", to: "/faculty?missing=scopus", tone: "caution" },
          { value: data?.counts.no_papers_year, label: `With no paper in ${year}`, zero: `Everyone has a paper in ${year}`, to: "/faculty?nopapers=1" },
        ]}
      />
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
            message="The faculty directory is for the college office and heads of department. You can open your own record from the menu."
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
          message={
            filtered
              ? "No faculty member fits this search and these filters. Try clearing one."
              : "Faculty appear here once their accounts are created."
          }
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
          <div>
            <HeaderRow money={Boolean(data?.money)} head={headView} sort={sort} dir={dir} onSort={sortBy} year={year} />
            <ul aria-label="Faculty" className="divide-y divide-line border-y border-line">
              {rows.map((r) => (
                <FacultyRowView key={r.id} row={r} year={year} money={Boolean(data?.money)} office={office} head={headView} />
              ))}
            </ul>
          </div>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            onChange={(p) => set({ page: p ? String(p) : null })}
          />
        </>
      )}
    </div>
  )
}

function HeaderRow({
  money: showMoney,
  head,
  sort,
  dir,
  onSort,
  year,
}: {
  money: boolean
  head: boolean
  sort: string
  dir: string
  onSort: (key: string) => void
  year: number
}) {
  const cols: { key: string | null; label: string }[] = [
    { key: "name", label: "Faculty" },
    { key: null, label: "Scopus ID" },
    { key: "papers", label: "Papers" },
    { key: "citations", label: "Citations" },
    ...(head ? [] : [{ key: "claims", label: `Claims in ${year}` }]),
    { key: "last_paper", label: "Last paper" },
  ]
  if (showMoney) cols.push({ key: null, label: `Incentives paid in ${year}` })
  return (
    <div
      className={cn(
        "hidden gap-x-4 border-t border-line px-1 py-2 lg:grid",
        showMoney ? GRID_MONEY : head ? GRID_HEAD : GRID
      )}
    >
      {cols.map((c) =>
        c.key ? (
          <button
            key={c.label}
            type="button"
            onClick={() => onSort(c.key!)}
            aria-label={`Sort by ${c.label}`}
            className="flex items-center gap-1 text-left hover:text-fg"
          >
            <ColumnLabel>{c.label}</ColumnLabel>
            {sort === c.key && (dir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />)}
          </button>
        ) : (
          <ColumnLabel key={c.label}>{c.label}</ColumnLabel>
        )
      )}
    </div>
  )
}

function FacultyRowView({
  row: r,
  year,
  money: showMoney,
  office,
  head,
}: {
  row: FacultyRow
  year: number
  money: boolean
  office: boolean
  head: boolean
}) {
  const hasIncentive = showMoney && r.incentive
  return (
    <li className={cn("grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-3 px-1 py-3 lg:items-center", showMoney ? GRID_MONEY : head ? GRID_HEAD : GRID)}>
      {/* Who */}
      <div className="flex min-w-0 items-center gap-3">
        <Avatar person={r} size="md" />
        <div className="min-w-0">
          <Link
            to={`/faculty/${r.id}`}
            className={cn("block truncate text-base font-medium hover:underline", !r.active && "text-fg-muted")}
          >
            {r.name}
          </Link>
          <Meta className="block truncate">
            {[r.staff_id, r.designation].filter(Boolean).join(" · ") || "No staff ID or designation"}
          </Meta>
          {(!head || !r.active || !r.department) && (
            <Meta className="block truncate">
              {r.department || "No department"}
              {!r.active && " · No longer at the college"}
            </Meta>
          )}
          {r.missing.length > 0 && (
            <span className="block text-sm text-caution" title="Missing from the record">
              Missing: {r.missing.map((m) => MISSING_WORDS[m].replace(/^No /, "")).join(", ")}
              {office && r.missing.some((m) => m !== "photo") && (
                <>
                  {" · "}
                  <Link to={`/people/${r.id}`} className="text-accent underline underline-offset-2">
                    Fix on the account
                  </Link>
                </>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 lg:block lg:space-y-1">
          {r.faculty_type === "RESEARCH" && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone="area" area="research" title="On a research post, with a yearly paper threshold">
                Research faculty
              </Chip>
              <Threshold row={r} office={office} />
            </div>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
            {r.scopus_author_id ? (
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
            ) : (
              <span className="text-caution">No Scopus ID</span>
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
      </div>

      {/* On a phone the figures are three plain sentences; on a wide screen they are columns. */}
      <div className="space-y-0.5 text-sm text-fg-muted lg:hidden">
        <p>
          <b className="tabular font-medium text-fg">{count(r.papers)}</b> papers ({count(r.papers_year)} in {year}),{" "}
          <b className="tabular font-medium text-fg">{count(r.citations)}</b> citations, h-index {r.h_index}
        </p>
        {!head && (
          <p>
            {count(r.claims_filed_year)} {r.claims_filed_year === 1 ? "claim" : "claims"} filed and {count(r.claims_done_year)}{" "}
            {showMoney ? "paid" : "completed"} in {year}
            {hasIncentive && (
              <>
                , <b className="tabular font-medium text-fg">{money(r.incentive!.amount)}</b> paid
              </>
            )}
          </p>
        )}
        <p>
          Last paper {r.last_paper_year ? paperDate(r.last_paper_on, r.last_paper_year) : "none yet"}
          {r.missing.length > 0 && <span className="text-caution">. {r.missing.map((m) => MISSING_WORDS[m]).join(", ")}</span>}
        </p>
      </div>

      <div className="hidden lg:contents">
        <Cell label="Papers" main={count(r.papers)} sub={`${count(r.papers_year)} in ${year}`} attention={r.papers_year === 0} />
        <Cell label="Citations" main={count(r.citations)} sub={`h-index ${r.h_index}`} />
        {!head && (
          <Cell
            label={`Claims in ${year}`}
            main={`${count(r.claims_filed_year)} filed`}
            sub={`${count(r.claims_done_year)} ${showMoney ? "paid" : "completed"}`}
          />
        )}
        <Cell
          label="Last paper"
          main={r.last_paper_year ? paperDate(r.last_paper_on, r.last_paper_year) : "None yet"}
        />
        {showMoney && (
          <Cell
            label={`Incentives paid in ${year}`}
            main={hasIncentive ? money(r.incentive!.amount) : "Not shown"}
            sub={hasIncentive ? `${money(r.incentive!.total_amount)} in all years` : ""}
          />
        )}
      </div>
    </li>
  )
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

/** One figure with its own label on a phone (where the column head is hidden). */
function Cell({
  label,
  main,
  sub,
  subTitle,
  attention,
}: {
  label: string
  main: string
  sub?: string
  subTitle?: string
  attention?: boolean
}) {
  return (
    <div className="min-w-0">
      <span className="block text-xs text-fg-muted lg:hidden">{label}</span>
      <span className="tabular block truncate text-base text-fg">{main}</span>
      {sub ? (
        <span title={subTitle} className={cn("block truncate text-sm", attention ? "text-caution" : "text-fg-muted")}>
          {sub}
        </span>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* What a "missing" filter means                                            */
/* ------------------------------------------------------------------------ */

const MISSING_HINT: Record<string, { who: "person" | "office"; text: string }> = {
  photo: { who: "person", text: "Only they can add a photo, so ask them." },
  scopus: { who: "office", text: "Add the Scopus author ID on their account. Each row has a link to it." },
  department: { who: "office", text: "Choose the department on their account. Each row has a link to it." },
  designation: { who: "office", text: "Add the designation on their account. Each row has a link to it." },
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