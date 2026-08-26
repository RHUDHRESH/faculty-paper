import { useEffect, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { ArrowLeft, KeyRound, Pencil, Search, SearchX, Users } from "lucide-react"

import { can, useAuth, type Role } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { RankedBars, MixBar, Trend, type Point } from "@/ui/chart"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Checkbox, Field, Input, PasswordInput } from "@/ui/field"
import { money, Stage, stageOf } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows, SkeletonText } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

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
  DIRECTOR: "Director",
  FINANCE: "Finance",
  RESEARCH_CELL: "Research cell",
  RESEARCH_COORDINATOR: "Research coordinator",
  SUPER_ADMIN: "Super admin",
}

function roleLabel(role: string): string {
  return ROLE_LABEL[role as Role] ?? role.replace(/_/g, " ").toLowerCase()
}

/** Mirrors `ASSIGNABLE_ROLES` in backend/core/api.py. A role offered here
 *  that the server will not assign is a guaranteed 400 on save. */
const ASSIGNABLE_ROLE_KEYS: Role[] = [
  "FACULTY",
  "HOD",
  "PRINCIPAL",
  "DIRECTOR",
  "RESEARCH_CELL",
  "RESEARCH_COORDINATOR",
  "FINANCE",
  "SUPER_ADMIN",
]

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
  const { me } = useAuth()
  // A head has neither `can_view_reports` nor `can_manage_users`, so
  // `/api/faculty/{id}/report` answers them 403 -- every name on their own
  // department screen was a link to a refusal. They get the same question
  // asked inside the two limits they work under: their own department, and
  // no money.
  if (can(me?.role).seeDepartment) return <HodPerson />
  return <CollegePerson />
}

function CollegePerson() {
  const { id } = useParams<{ id: string }>()
  const { me } = useAuth()
  const showMoney = can(me?.role).seeMoney
  const [editing, setEditing] = useState(false)
  const [resetting, setResetting] = useState(false)

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

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <PageTitle>{faculty.name || faculty.email}</PageTitle>
          <Sub>
            {roleLabel(faculty.role)}
            {[faculty.department, faculty.designation].filter(Boolean).length > 0
              ? ` · ${[faculty.department, faculty.designation].filter(Boolean).join(" · ")}`
              : ""}
          </Sub>
          <Meta className="block">{faculty.email}</Meta>
        </div>
        {can(me?.role).manageUsers && id && (
          <div className="flex shrink-0 gap-2">
            <Button kind="default" size="md" onClick={() => setEditing(true)}>
              <Pencil />
              Edit account
            </Button>
            <Button kind="quiet" size="md" onClick={() => setResetting(true)}>
              <KeyRound />
              Set a password
            </Button>
          </div>
        )}
      </header>

      {editing && id && <AccountEditor userId={id} onClose={() => setEditing(false)} />}
      {resetting && id && (
        <PasswordReset
          userId={id}
          name={faculty.name || faculty.email}
          onClose={() => setResetting(false)}
        />
      )}

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


/* ------------------------------------------------------------------------ */
/* HodPerson - one member of a head's own department                        */
/* ------------------------------------------------------------------------ */

type HodPersonPayload = {
  person: {
    id: string
    name: string
    email: string
    department: string | null
    designation: string | null
    staff_id: string | null
    active: boolean
  }
  totals: { publications: number; q1: number; first_author: number; under_review: number }
  by_year: Point[]
  by_quartile: Point[]
  by_journal: Point[]
  targets: {
    id: string
    year: number
    metric_label: string
    target: number
    done: number
    remaining: number
    met: boolean
    fraction: number | null
  }[]
  papers: {
    id: string
    paper_title: string
    journal_title: string | null
    publication_year: number | null
    quartile: string | null
    author_position: number | null
    total_authors: number | null
    /** Already translated server-side: a head is told a ticket finished, not
     *  that a colleague was paid. */
    progress: string
  }[]
}

/**
 * What a head sees when they open somebody in their department.
 *
 * There is not a rupee on this page and none in the endpoint behind it: the
 * server strips every money key before serialising, so no carelessness here
 * can leak one. What is left is the part that is genuinely a head's business
 * - what this person publishes, where, how often they lead it, and whether
 * they are meeting the target they were given.
 */
function HodPerson() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, error, refetch } = useApi<HodPersonPayload>(
    ["hod", "person", id],
    `/api/hod/people/${id}`,
    { enabled: !!id }
  )

  if (isLoading) {
    return (
      <div className="page space-y-8 py-8">
        <SkeletonText lines={2} className="max-w-xs" />
        <SkeletonRows rows={6} />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="page py-8">
        <Button kind="quiet" size="sm" asChild className="-ml-2 mb-4">
          <Link to="/department">
            <ArrowLeft />
            My department
          </Link>
        </Button>
        <ErrorState
          title={error?.status === 403 ? "Not in your department" : "Could not load this person"}
          message={
            error?.status === 403
              ? error.message
              : "The server did not answer. Nothing has been lost."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      </div>
    )
  }

  const person = data.person

  return (
    <div className="page space-y-8">
      <div>
        <Button kind="quiet" size="sm" asChild className="-ml-2">
          <Link to="/department">
            <ArrowLeft />
            My department
          </Link>
        </Button>
        <PageTitle className="mt-2">{person.name}</PageTitle>
        <Sub className="mt-1">
          {[person.designation, person.department, person.staff_id].filter(Boolean).join(" · ")}
        </Sub>
      </div>

      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        <PersonFigure label="Publications" value={data.totals.publications} />
        <PersonFigure label="Q1 papers" value={data.totals.q1} hint="Top-quartile journals" />
        <PersonFigure
          label="First author"
          value={data.totals.first_author}
          hint="Papers they led"
        />
        <PersonFigure
          label="Under review"
          value={data.totals.under_review}
          hint="Filed, not yet finished"
        />
      </section>

      {data.targets.length > 0 && (
        <section className="space-y-2">
          <SectionTitle>Their targets</SectionTitle>
          <ul className="divide-y divide-line border-y border-line">
            {data.targets.map((t) => (
              <li key={t.id} className="space-y-1.5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-base">
                    {t.metric_label} <span className="text-fg-muted">· {t.year}</span>
                  </span>
                  <span
                    className={cn(
                      "text-base font-medium tabular",
                      t.met ? "text-positive" : "text-fg"
                    )}
                  >
                    {t.done} / {t.target}
                  </span>
                </div>
                <span className="block h-1.5 w-full overflow-hidden rounded-full bg-sunken">
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      t.met ? "bg-positive" : "bg-accent"
                    )}
                    style={{ width: `${Math.min(1, t.fraction ?? 0) * 100}%` }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.by_year.length > 1 && (
        <Trend
          title="Publications over time"
          dimension="Year"
          points={data.by_year}
          unit="count"
        />
      )}

      {data.by_quartile.length > 0 && (
        <MixBar title="Quartile mix" dimension="Quartile" points={data.by_quartile} unit="count" />
      )}

      {data.by_journal.length > 0 && (
        <RankedBars
          title="Where they publish"
          dimension="Journal"
          points={data.by_journal}
          unit="count"
        />
      )}

      <section className="space-y-2">
        <SectionTitle>Papers</SectionTitle>
        {data.papers.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="Nothing filed yet"
            message="Nothing has been filed under this account. That is not the same as having published nothing - a paper nobody filed a claim for does not appear anywhere in this system."
          />
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {data.papers.map((c) => (
              <li key={c.id} className="row">
                <Link
                  to={`/papers/${c.id}`}
                  className="flex items-center gap-4 px-1 py-2.5 sm:px-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base">
                      {c.paper_title || "Untitled"}
                    </span>
                    <Meta className="block truncate">
                      {[
                        c.journal_title,
                        c.publication_year,
                        c.author_position && c.total_authors
                          ? `author ${c.author_position} of ${c.total_authors}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Meta>
                  </span>
                  {c.quartile && (
                    <span className="w-12 shrink-0 text-right text-sm tabular text-fg-muted">
                      {c.quartile}
                    </span>
                  )}
                  <span className="w-28 shrink-0 text-right text-sm text-fg-muted">
                    {c.progress}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function PersonFigure({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint?: string
}) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular">{value.toLocaleString("en-IN")}</p>
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}


/* ------------------------------------------------------------------------ */
/* AccountEditor — the one place a person's details are changed             */
/* ------------------------------------------------------------------------ */

/** Everything `PATCH /api/admin/users/{id}` will take. */
type AccountFields = {
  name: string
  department: string
  designation: string
  staff_id: string
  biometric_id: string
  scopus_author_url: string
  scopus_author_id: string
  role: Role
  active: boolean
  faculty_type: "REGULAR" | "RESEARCH"
  research_quota: number | null
  research_quota_note: string
}

type AccountDetail = AccountFields & {
  id: string
  email: string
  employee_id: string | null
  must_change_password: boolean
  stats: {
    claims: number
    paid_claims: number
    drafts: number
    in_review: number
    last_claim_at: string | null
  }
}

/**
 * Two tiers of field, and the split is the point of the screen.
 *
 * **Routing** — role, department, whether the account is active — is the
 * research cell's ordinary work. People move between departments as a matter
 * of course.
 *
 * **Identity** — name, designation, staff ID, biometric ID, the Scopus link —
 * is a super admin's alone, and the server refuses everyone else field by
 * field. The reason is not seniority: the research cell processes the claims
 * these fields decide the outcome of, so it cannot also set them. A Scopus
 * link pointed at the wrong profile is how a paper gets attributed to another
 * author, and a staff ID is what the payment is made against.
 *
 * So the identity fields are shown to the research cell and disabled, with
 * that sentence beside them. Hiding them would make the page look like it was
 * missing something; offering them would be a guaranteed 403.
 */
function AccountEditor({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { me } = useAuth()
  const isSuperAdmin = can(me?.role).admin
  const editingSelf = me?.id === userId

  const { data, isLoading, error } = useApi<AccountDetail>(
    ["admin", "user", userId],
    `/api/admin/users/${userId}`
  )
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments")

  const [form, setForm] = useState<AccountFields | null>(null)
  useEffect(() => {
    if (!data) return
    setForm({
      name: data.name || "",
      department: data.department || "",
      designation: data.designation || "",
      staff_id: data.staff_id || "",
      biometric_id: data.biometric_id || "",
      scopus_author_url: data.scopus_author_url || "",
      scopus_author_id: data.scopus_author_id || "",
      role: data.role,
      active: data.active,
      faculty_type: data.faculty_type || "REGULAR",
      research_quota: data.research_quota,
      research_quota_note: data.research_quota_note || "",
    })
  }, [data])

  const save = useApiMutation<Partial<AccountFields>, AccountDetail>(
    `/api/admin/users/${userId}`,
    {
      method: "PATCH",
      invalidates: [["admin", "user", userId], ["people"], ["faculty-report", userId]],
    }
  )

  function set<K extends keyof AccountFields>(key: K, value: AccountFields[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  async function submit() {
    if (!form || !data) return
    // Only what actually moved. Sending the whole form would put every
    // identity field in the request, and the server refuses the request for
    // a research-cell account the moment one of them is present — even
    // unchanged.
    const patch: Partial<AccountFields> = {}
    for (const key of Object.keys(form) as (keyof AccountFields)[]) {
      if (form[key] !== (data[key] ?? (typeof form[key] === "boolean" ? false : ""))) {
        // @ts-expect-error — narrowed by the key loop, which TS cannot follow
        patch[key] = form[key]
      }
    }
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    try {
      await save.mutateAsync(patch)
      toast.ok(
        `Saved — ${Object.keys(patch).length} ${Object.keys(patch).length === 1 ? "change" : "changes"} to ${data.name || data.email}`
      )
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  const roleOptions: ComboboxOption[] = ASSIGNABLE_ROLE_KEYS.map((r) => ({
    value: r,
    label: ROLE_LABEL[r],
  }))
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "No department" },
    ...(departments.data ?? []).map((d) => ({ value: d, label: d })),
  ]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Edit this account</DialogTitle>
          <DialogDescription>
            {data?.email}
            {data?.employee_id ? ` · ${data.employee_id}` : ""}. Every change is written to
            the audit log with what it was before.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {isLoading || !form ? (
            <SkeletonRows rows={5} rowHeight={40} />
          ) : error ? (
            <ErrorState
              title="Could not load this account"
              message={
                error.status === 403
                  ? "Only the research cell and a super admin can edit accounts."
                  : "The server did not answer."
              }
            />
          ) : (
            <>
              {data && data.stats.claims > 0 && (
                <Callout tone="info" title="This account has a record behind it">
                  {data.stats.claims} papers, {data.stats.paid_claims} of them paid. Changing the
                  staff or biometric ID changes what future payments are made against; it does
                  not rewrite what has already been paid.
                </Callout>
              )}

              {/* ---- routing: the research cell's ordinary work ---- */}
              <fieldset className="space-y-4">
                <legend className="text-sm font-medium">Where they sit</legend>

                <Field
                  label="Department"
                  hint="Decides which head sees them and which department their output counts towards."
                >
                  <Combobox
                    value={form.department}
                    onChange={(v) => set("department", v)}
                    options={departmentOptions}
                    placeholder="No department"
                  />
                </Field>

                <Field
                  label="Role"
                  hint={
                    editingSelf
                      ? "You cannot change your own role — ask another admin."
                      : "What this account may do."
                  }
                >
                  <Combobox
                    value={form.role}
                    onChange={(v) => set("role", v as Role)}
                    options={roleOptions}
                    disabled={editingSelf}
                  />
                </Field>

                <Checkbox
                  checked={form.active}
                  onCheckedChange={(v) => set("active", v === true)}
                  disabled={editingSelf}
                  label="Active"
                  hint={
                    editingSelf
                      ? "You cannot deactivate the account you are signed in as."
                      : "An inactive account cannot sign in. Its papers and payments stay on record."
                  }
                />
              </fieldset>

              {/* ---- identity: super admin only ---- */}
              <fieldset className="space-y-4 border-t border-line pt-4">
                <legend className="text-sm font-medium">Who they are</legend>

                {!isSuperAdmin && (
                  <Callout tone="caution" title="Only a super admin can change these">
                    They decide who gets paid and whose record a paper is checked against — and
                    the research cell processes the claims they decide the outcome of, so it
                    cannot also set them.
                  </Callout>
                )}

                <Field label="Full name">
                  <Input
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                    disabled={!isSuperAdmin}
                  />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Designation">
                    <Input
                      value={form.designation}
                      onChange={(e) => set("designation", e.target.value)}
                      disabled={!isSuperAdmin}
                    />
                  </Field>
                  <Field label="Staff ID" hint="What the payment is made against.">
                    <Input
                      value={form.staff_id}
                      onChange={(e) => set("staff_id", e.target.value)}
                      disabled={!isSuperAdmin}
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Biometric ID">
                    <Input
                      value={form.biometric_id}
                      onChange={(e) => set("biometric_id", e.target.value)}
                      disabled={!isSuperAdmin}
                    />
                  </Field>
                  <Field label="Scopus author ID">
                    <Input
                      value={form.scopus_author_id}
                      onChange={(e) => set("scopus_author_id", e.target.value)}
                      disabled={!isSuperAdmin}
                    />
                  </Field>
                </div>

                <Field
                  label="Scopus author link"
                  hint="Points at the profile a paper is checked against. The wrong one attributes their work to somebody else."
                >
                  <Input
                    value={form.scopus_author_url}
                    onChange={(e) => set("scopus_author_url", e.target.value)}
                    disabled={!isSuperAdmin}
                  />
                </Field>
              </fieldset>

              {/* ---- what the post is expected to produce ---- */}
              <fieldset className="space-y-4 border-t border-line pt-4">
                <legend className="text-sm font-medium">What the post expects</legend>

                <Field
                  label="Faculty type"
                  hint="A research post is already paid to do research, so the scheme rewards only what exceeds the quota."
                >
                  <Combobox
                    value={form.faculty_type}
                    onChange={(v) => set("faculty_type", v as "REGULAR" | "RESEARCH")}
                    options={[
                      { value: "REGULAR", label: "Regular faculty" },
                      { value: "RESEARCH", label: "Research faculty" },
                    ]}
                    disabled={!isSuperAdmin}
                  />
                </Field>

                {form.faculty_type === "RESEARCH" && (
                  <>
                    <Callout tone="caution" title="Papers up to the quota are paid nothing">
                      With a quota of four, their first four papers each year carry no
                      remuneration and only the fifth onwards is reimbursed. Leave it empty
                      and nothing is zeroed.
                    </Callout>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Papers a year before any incentive">
                        <Input
                          value={form.research_quota == null ? "" : String(form.research_quota)}
                          onChange={(e) => {
                            const n = Number.parseInt(e.target.value, 10)
                            set("research_quota", Number.isFinite(n) && n >= 0 ? n : null)
                          }}
                          inputMode="numeric"
                          placeholder="No quota"
                          disabled={!isSuperAdmin}
                        />
                      </Field>
                      <Field label="Where the number came from">
                        <Input
                          value={form.research_quota_note}
                          onChange={(e) => set("research_quota_note", e.target.value)}
                          placeholder="Agreed in the appointment letter"
                          disabled={!isSuperAdmin}
                        />
                      </Field>
                    </div>
                  </>
                )}
              </fieldset>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={!form || save.isPending}
            onClick={() => void submit()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* PasswordReset                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Give an account a password, without the admin having to reach for a
 * terminal.
 *
 * The server always sets `must_change_password` on a reset, so whatever is
 * typed here is a handover value and not a password anybody keeps. It also
 * clears a login lockout, which is how somebody locked out actually gets
 * back in.
 */
function PasswordReset({
  userId,
  name,
  onClose,
}: {
  userId: string
  name: string
  onClose: () => void
}) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")

  const reset = useApiMutation<{ password: string }, { ok: boolean }>(
    `/api/admin/users/${userId}/reset-password`,
    { invalidates: [["admin", "user", userId]] }
  )

  const short = password.length > 0 && password.length < 8
  const mismatch = confirm.length > 0 && password !== confirm
  const canSubmit = password.length >= 8 && password === confirm && !reset.isPending

  async function submit() {
    try {
      await reset.mutateAsync({ password })
      toast.ok(`Password set for ${name} — they must change it when they sign in`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Set a password</DialogTitle>
          <DialogDescription>For {name}.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="info" title="They will have to change it">
            This is a handover value, not a password they keep. They are asked to choose their
            own the moment they sign in, and setting one also clears a lockout.
          </Callout>
          <Field label="New password" error={short ? "At least 8 characters." : undefined}>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
            />
          </Field>
          <Field
            label="Confirm"
            error={mismatch ? "The two do not match." : undefined}
          >
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={reset.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {reset.isPending ? "Setting…" : "Set the password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
