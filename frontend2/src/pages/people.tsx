import { useEffect, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { ArrowLeft, ChevronLeft, ChevronRight, Search, SearchX, Users } from "lucide-react"

import { can, useAuth, type Role } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { RankedBars, MixBar, Trend, type Point } from "@/ui/chart"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input } from "@/ui/field"
import { money, Stage, stageOf } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows, SkeletonText } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * The staff directory (`People`) and one account's publication record
 * (`Person`), which the collaboration page has been linking to since it
 * shipped — every `/people/{id}` link there was dead until this file
 * existed.
 *
 * The one rule that matters more than any layout choice: a head of
 * department must never see a rupee figure here, by any route. `Person`
 * strips `amount` out of every breakdown before it reaches a chart, not just
 * out of the total — a chart component that still receives `amount` shows it
 * in its own "show the numbers" table regardless of which axis it was told
 * to draw, so hiding the axis alone would have leaked it right back.
 */

const PAGE_SIZE = 20

const ROLE_LABEL: Record<Role, string> = {
  FACULTY: "Faculty",
  HOD: "Head of department",
  PRINCIPAL: "Principal",
  FINANCE: "Finance",
  RESEARCH_CELL: "Research cell",
  SUPER_ADMIN: "Super admin",
}

function roleLabel(role: string): string {
  return ROLE_LABEL[role as Role] ?? role.replace(/_/g, " ").toLowerCase()
}

const ROLE_OPTIONS: ComboboxOption[] = [
  { value: "", label: "All roles" },
  ...(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] })),
]

/* ------------------------------------------------------------------------ */
/* People — the directory                                                   */
/* ------------------------------------------------------------------------ */

type PersonRow = {
  id: string
  email: string
  name: string
  role: Role
  department: string | null
  designation: string | null
  active: boolean
}

type PeoplePayload = {
  total: number
  limit: number
  offset: number
  results: PersonRow[]
}

/**
 * Everybody on the roster — office use, so a table, but a row still has to
 * read as a person: their name first, department and designation under it,
 * and the role written out rather than left as the raw constant the account
 * was created with.
 */
export function People() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const role = searchParams.get("role") ?? ""
  const department = searchParams.get("department") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  // The box's own state so typing feels instant; the URL only catches up
  // once typing pauses, matching the pattern `papers.tsx` already uses.
  const [searchDraft, setSearchDraft] = useState(q)
  useEffect(() => setSearchDraft(q), [q])

  useEffect(() => {
    if (searchDraft === q) return
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (searchDraft) {
            next.set("q", searchDraft)
          } else {
            next.delete("q")
          }
          next.delete("page")
          return next
        },
        { replace: true }
      )
    }, 250)
    return () => clearTimeout(t)
  }, [searchDraft, q, setSearchParams])

  function selectRole(next: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next) p.set("role", next)
      else p.delete("role")
      p.delete("page")
      return p
    })
  }

  function selectDepartment(next: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next) p.set("department", next)
      else p.delete("department")
      p.delete("page")
      return p
    })
  }

  function goToPage(next: number) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next > 0) p.set("page", String(next))
      else p.delete("page")
      return p
    })
  }

  function clearFilters() {
    setSearchDraft("")
    setSearchParams(new URLSearchParams())
  }

  const listQuery = new URLSearchParams()
  if (q) listQuery.set("q", q)
  if (department) listQuery.set("department", department)
  if (role) listQuery.set("role", role)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<PeoplePayload>(
    ["people", q, department, role, page],
    `/api/admin/users?${listQuery.toString()}`,
    // Keeps the previous page's rows on screen while the next page loads.
    { placeholderData: (prev) => prev }
  )

  const departmentsQuery = useApi<string[]>(["meta", "departments"], "/api/meta/departments")
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "All departments" },
    ...(departmentsQuery.data || []).map((d) => ({ value: d, label: d })),
  ]

  // The offset can end up past the end once a filter narrows the result set
  // out from under the current page.
  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) goToPage(maxPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const people = data?.results ?? []
  const total = data?.total ?? 0
  const filtered = Boolean(q) || Boolean(role) || Boolean(department)

  const columns: Column<PersonRow>[] = [
    {
      key: "person",
      header: "Person",
      cell: (p) => (
        <span className="block min-w-0">
          <span className="block truncate text-base">{p.name || p.email}</span>
          <Meta className="mt-0.5 block truncate">
            {[p.department, p.designation].filter(Boolean).join(" · ") || "—"}
          </Meta>
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      className: "w-40",
      cell: (p) => <span className="text-sm">{roleLabel(p.role)}</span>,
    },
    {
      key: "email",
      header: "Email",
      className: "max-w-[16rem]",
      cell: (p) => <span className="block truncate text-sm text-fg-muted">{p.email}</span>,
    },
    {
      key: "status",
      header: "Status",
      className: "w-24",
      cell: (p) => (
        <span className={cn("text-sm", p.active ? "text-fg-muted" : "text-critical")}>
          {p.active ? "Active" : "Inactive"}
        </span>
      ),
    },
  ]

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>People</PageTitle>
        <Sub className="mt-1">
          Every account on the roster, searchable by name, email, role and department.
        </Sub>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search name or email"
            aria-label="Search people"
            className="pl-8"
          />
        </div>
        <Combobox
          value={role}
          onChange={selectRole}
          options={ROLE_OPTIONS}
          placeholder="All roles"
          aria-label="Filter by role"
          className="w-44"
        />
        <Combobox
          value={department}
          onChange={selectDepartment}
          options={departmentOptions}
          placeholder={departmentsQuery.isLoading ? "Loading…" : "All departments"}
          disabled={departmentsQuery.isLoading}
          aria-label="Filter by department"
          className="w-56"
        />
      </div>

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={48} />
      ) : isError ? (
        error?.status === 403 ? (
          <ErrorState
            title="Not visible to this account"
            message="This directory is only open to the research cell and system admins."
          />
        ) : (
          <ErrorState
            title="Could not load the directory"
            message="The server did not answer. Nothing has been lost."
            onRetry={() => refetch()}
          />
        )
      ) : people.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : Users}
          title={filtered ? "Nobody matches" : "Nobody on the roster yet"}
          message={
            filtered
              ? "No account matches this search, role and department. Try clearing a filter."
              : "Accounts appear here once they are created."
          }
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table
            rows={people}
            columns={columns}
            getKey={(p) => p.id}
            rowLink={(p) => `/people/${p.id}`}
            minWidth="42rem"
          />
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Person — one record                                                      */
/* ------------------------------------------------------------------------ */

type Faculty = {
  id: string
  email: string
  name: string
  role: Role
  department: string | null
  designation: string | null
  employee_id: string | null
  staff_id: string | null
  active: boolean
}

type ReportTotals = {
  publications: number
  paid_claims: number
  paid_amount: number
  in_review: number
}

type ReportClaim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  publication_year: number | null
  status: string
  remuneration: number | null
  remuneration_is_estimate: boolean
  calc_error: string | null
}

type FacultyReport = {
  faculty: Faculty
  totals: ReportTotals
  by_month: Point[]
  by_quartile: Point[]
  by_status: Point[]
  by_year: Point[]
  by_journal: Point[]
  by_type: Point[]
  by_position: Point[]
  claims: ReportClaim[]
}

/** Every `amount` dropped, `count` left alone — so a chart handed these
 *  points cannot show a rupee figure even in its own "show the numbers"
 *  table underneath, which reads straight off the point rather than off
 *  whichever axis the chart happened to be drawing. */
function countOnly(points: Point[]): Point[] {
  return points.map(({ amount: _amount, ...rest }) => rest)
}

/**
 * One person's publication record: who they are, what the college has paid
 * them (unless they are looked at by their own head of department, who sees
 * none of that), and every paper behind the total.
 */
export function Person() {
  const { id } = useParams<{ id: string }>()
  const { me } = useAuth()
  const showMoney = can(me?.role).seeMoney

  const {
    data: report,
    isLoading,
    error,
    refetch,
  } = useApi<FacultyReport>(["faculty-report", id], `/api/faculty/${id}/report`, {
    enabled: !!id,
  })

  if (isLoading) {
    return (
      <div className="page space-y-8 py-8">
        <Skeleton className="h-4 w-24" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-2/3 max-w-md" />
          <Skeleton className="h-4 w-48" />
        </div>
        <SkeletonText lines={4} />
      </div>
    )
  }

  if (error) {
    if (error.status === 403) {
      return (
        <div className="page py-8">
          <ErrorState
            title="This record is not visible to this account"
            message="You do not have permission to open this person's publication record."
          />
        </div>
      )
    }
    if (error.status === 404) {
      return (
        <div className="page py-8">
          <ErrorState
            title="No such person"
            message="This account may have been removed, or the link is wrong."
          />
        </div>
      )
    }
    return (
      <div className="page py-8">
        <ErrorState
          title="Could not load this record"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => void refetch()}
        />
      </div>
    )
  }

  if (!report) {
    return (
      <div className="page py-8">
        <EmptyState title="Nothing here" message="This account has no record to show." />
      </div>
    )
  }

  const { faculty, totals, by_year, by_month, by_journal, by_quartile, claims } = report
  // A year with too few distinct buckets reads as a flat line; fall back to
  // the monthly series when there isn't enough of a year-over-year shape to
  // show yet.
  const yearPoints = by_year.length >= 2 ? by_year : by_month
  const trendPoints = showMoney ? yearPoints : countOnly(yearPoints)
  const journalPoints = showMoney ? by_journal : countOnly(by_journal)
  const quartilePoints = showMoney ? by_quartile : countOnly(by_quartile)

  const columns: Column<ReportClaim>[] = [
    {
      key: "title",
      header: "Paper",
      className: "max-w-[22rem]",
      cell: (c) => (
        <span className="block">
          <span className="block truncate text-base">{c.paper_title || "Untitled"}</span>
          <Meta className="mt-0.5 block truncate">{c.ticket_number || "—"}</Meta>
        </span>
      ),
    },
    {
      key: "journal",
      header: "Journal",
      className: "max-w-[14rem]",
      cell: (c) => (
        <span className="line-clamp-2 text-sm text-fg-muted">{c.journal_title || "—"}</span>
      ),
    },
    {
      key: "year",
      header: "Year",
      className: "w-16",
      cell: (c) => <span className="tabular">{c.publication_year ?? "—"}</span>,
    },
    {
      key: "stage",
      header: "Stage",
      className: "w-36",
      cell: (c) => <Stage stage={stageOf(c.status)} />,
    },
    ...(showMoney
      ? [
          {
            key: "amount",
            header: "Amount",
            align: "right" as const,
            cell: (c: ReportClaim) => <AmountCell claim={c} />,
          },
        ]
      : []),
  ]

  return (
    <div className="page space-y-10 py-8">
      <Link
        to="/people"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        People
      </Link>

      <header className="space-y-1">
        <PageTitle>{faculty.name || faculty.email}</PageTitle>
        <Sub>
          {roleLabel(faculty.role)}
          {[faculty.department, faculty.designation].filter(Boolean).length > 0
            ? ` · ${[faculty.department, faculty.designation].filter(Boolean).join(" · ")}`
            : ""}
        </Sub>
        <Meta className="block">{faculty.email}</Meta>
      </header>

      {!showMoney && (
        <Callout tone="info" title="Payment figures are not shown for this role">
          As a head of department you can see what this person has published, not what they
          have been paid for it.
        </Callout>
      )}

      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
        <Figure label="Publications" value={String(totals.publications)} />
        <Figure
          label="Paid"
          value={String(totals.paid_claims)}
          hint={showMoney ? money(totals.paid_amount) : undefined}
        />
        <Figure
          label="In review"
          value={String(totals.in_review)}
          muted={!totals.in_review}
        />
      </section>

      <section className="space-y-10">
        <Trend
          title="Publications over time"
          dimension={by_year.length >= 2 ? "Year" : "Month"}
          points={trendPoints}
          unit="count"
        />
        <RankedBars title="Where they publish" dimension="Journal" points={journalPoints} unit="count" />
        <MixBar title="Quartile mix" dimension="Quartile" points={quartilePoints} unit="count" />
      </section>

      <section className="space-y-3">
        <SectionTitle>Papers</SectionTitle>
        <Table
          rows={claims}
          columns={columns}
          getKey={(c) => c.id}
          rowLink={(c) => `/papers/${c.id}`}
          minWidth="40rem"
          empty="Nothing published yet."
        />
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Shared pieces                                                            */
/* ------------------------------------------------------------------------ */

/** The amount, with the two things that make it not a settled figure shown
 *  beside it — mirrors `papers.tsx`'s `AmountCell` rather than importing it,
 *  since that one isn't exported and this file may not touch `papers.tsx`. */
function AmountCell({ claim }: { claim: ReportClaim }) {
  if (claim.calc_error) {
    return <span className="text-xs text-critical">Could not calculate</span>
  }
  return (
    <span className="inline-flex flex-col items-end">
      <span className="tabular">{money(claim.remuneration)}</span>
      {claim.remuneration != null && claim.remuneration_is_estimate && (
        <span className="text-xs font-normal leading-tight text-caution">Estimate</span>
      )}
    </span>
  )
}

/** A number that is an answer, not a tile — matches `home-faculty.tsx`'s
 *  `Figure`, redeclared locally for the same reason `AmountCell` is. */
function Figure({
  label,
  value,
  hint,
  muted,
}: {
  label: string
  value: string
  hint?: string
  muted?: boolean
}) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      <p className={cn("mt-0.5 text-2xl font-semibold tabular", muted && "text-fg-subtle")}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}

/** `total`/`limit`/`offset` off the envelope, turned into page controls —
 *  matches `papers.tsx`'s `Pagination`, redeclared locally for the same
 *  reason as the two pieces above. */
function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
}) {
  if (total <= pageSize) return null

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const start = page * pageSize + 1
  const end = Math.min(total, (page + 1) * pageSize)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <Meta>
        {start}–{end} of {total}
      </Meta>
      <div className="flex items-center gap-1">
        <Button kind="quiet" size="sm" onClick={() => onChange(page - 1)} disabled={page === 0}>
          <ChevronLeft />
          Previous
        </Button>
        <Meta className="px-1 tabular">
          Page {page + 1} of {pageCount}
        </Meta>
        <Button
          kind="quiet"
          size="sm"
          onClick={() => onChange(page + 1)}
          disabled={page + 1 >= pageCount}
        >
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
