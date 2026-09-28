import { firstName } from "@/lib/names"
import { useEffect, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { ArrowLeft, Eye, FilePlus, UserPlus, KeyRound, Search, SearchX, Users } from "lucide-react"

import { can, useAuth, type Role } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { api, forgetCsrf } from "@/lib/api"
import { KindBadge } from "@/pages/assignment-parts"
import { Button } from "@/ui/button"
import { filterBar } from "@/ui/filter-bar"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ConfirmDialog,
} from "@/ui/dialog"
import { RankedBars, MixBar, Trend, type Point } from "@/ui/chart"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Checkbox, Field, Input, PasswordInput } from "@/ui/field"
import { money, Stage, stageOf } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { ScopusProfileCard, type ScopusProfile } from "@/ui/scopus"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows, SkeletonText } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { HeaderSpot } from "@/ui/page-header"
import { Avatar } from "@/ui/person"

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

/**
 * The role as the office picks it. A head of department is a faculty member
 * who also heads the department (the college's decision of 2026-09-23) and
 * keeps filing their own papers -- said on the option, because "Head of
 * department" alone reads like a desk that stops filing.
 */
const ROLE_CHOICE_LABEL: Record<Role, string> = {
  ...ROLE_LABEL,
  HOD: "Head of department (still files papers)",
}

const RESEARCH_OPTIONS: ComboboxOption[] = [
  { value: "", label: "Any post" },
  { value: "RESEARCH", label: "Research faculty" },
  { value: "REGULAR", label: "Regular faculty" },
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
  faculty_type?: "REGULAR" | "RESEARCH"
  research_quota?: number | null
  photo_url?: string | null
  initials?: string
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
  const { me } = useAuth()
  const [creating, setCreating] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const role = searchParams.get("role") ?? ""
  const department = searchParams.get("department") ?? ""
  const research = searchParams.get("research") ?? ""
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

  function selectResearch(next: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next) p.set("research", next)
      else p.delete("research")
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
  if (research) listQuery.set("faculty_type", research)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<PeoplePayload>(
    ["people", q, department, role, research, page],
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
  const filtered = Boolean(q) || Boolean(role) || Boolean(department) || Boolean(research)

  const columns: Column<PersonRow>[] = [
    {
      key: "person",
      header: "Person",
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar person={{ name: p.name || p.email, initials: p.initials ?? "", photo_url: p.photo_url ?? null }} size="sm" />
          <span className="block min-w-0">
            <span className={cn("block truncate text-base", !p.active && "text-fg-muted")}>{p.name || p.email}</span>
            <Meta className="mt-0.5 block truncate">
              {[p.department, p.designation].filter(Boolean).join(" · ") || "No department"}
            </Meta>
          </span>
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      className: "w-48",
      // The three things the office records per person, readable at a
      // glance: faculty or an office role, whether they head their
      // department, and whether they hold a research post. A head is
      // faculty first, so they read as "Faculty" with the post beside it.
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm">{p.role === "HOD" ? ROLE_LABEL.FACULTY : roleLabel(p.role)}</span>
          {p.role === "HOD" && <KindBadge label="HOD" />}
          {p.faculty_type === "RESEARCH" && (
            <>
              <KindBadge label="Research" />
              <Meta>
                {p.research_quota == null ? "No quota set" : `Quota ${p.research_quota} a year`}
              </Meta>
            </>
          )}
        </span>
      ),
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
      <header className="page-head">
        <div>
          <PageTitle>People</PageTitle>
          <Sub className="mt-1">
            Every account on the roster, searchable by name, email, role and department.
          </Sub>
        </div>
        {can(me?.role).manageUsers && (
          <Button kind="default" size="md" onClick={() => setCreating(true)}>
            <UserPlus />
            New account
          </Button>
        )}
        <HeaderSpot name="spot-people" />
      </header>

      {creating && <NewAccount onClose={() => setCreating(false)} />}

      <div className={filterBar}>
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
        <Combobox
          value={research}
          onChange={selectResearch}
          options={RESEARCH_OPTIONS}
          placeholder="Any post"
          aria-label="Filter by research faculty"
          className="w-44"
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
  photo_url?: string | null
  initials?: string
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
  /** From the office's Scopus profile import; null when none is loaded. */
  scopus_profile?: ScopusProfile | null
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
  const { refresh } = useAuth()
  const navigate = useNavigate()

  // A super admin sees exactly what this person sees. The server records the
  // start and the end in the audit log, and the banner says so throughout.
  async function viewAs() {
    try {
      await api(`/api/admin/impersonate/${id}`, { method: "POST" })
      forgetCsrf() // the server logged us in as them, which rotates the token
      await refresh()
      navigate("/")
    } catch (err) {
      toast.fail(err)
    }
  }
  const showMoney = can(me?.role).seeMoney
  const manages = can(me?.role).manageUsers
  const [resetting, setResetting] = useState(false)
  const [viewing, setViewing] = useState(false)

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

      <header className="page-head">
        <div className="flex min-w-0 items-center gap-4">
        <Avatar
          person={{ name: faculty.name || faculty.email, initials: faculty.initials ?? "", photo_url: faculty.photo_url ?? null }}
          size="lg"
        />
        <div className="min-w-0 space-y-1">
          <PageTitle>{faculty.name || faculty.email}</PageTitle>
          <Sub>
            {roleLabel(faculty.role)}
            {[faculty.department, faculty.designation].filter(Boolean).length > 0
              ? ` · ${[faculty.department, faculty.designation].filter(Boolean).join(" · ")}`
              : ""}
          </Sub>
          <Meta className="block break-all">
            {faculty.email}
            {!faculty.active && <span className="ml-2 text-critical">Inactive</span>}
          </Meta>
        </div>
        </div>
        {manages && id && (
          <div className="flex flex-wrap gap-2">
            {/* Claimants only -- faculty, and a head of department, who is
                faculty too. A claim belongs to the person who published the
                paper, and the server refuses an owner who is not one
                (`rbac.CLAIMANT_ROLES`). */}
            {can(faculty.role).fileOwnPapers && (
              <Button kind="default" size="md" asChild>
                <Link to={`/papers/new?for=${id}`}>
                  <FilePlus />
                  File a paper for them
                </Link>
              </Button>
            )}
          </div>
        )}
        <HeaderSpot name="spot-profile" />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {/* One person's record as a file: what an appraisal or a promotion
            panel asks the office for. */}
        {id && (
          <>
            <Button kind="default" size="sm" asChild>
              <a href={`/api/faculty/${id}/report/export?fmt=xlsx`}>Download record (Excel)</a>
            </Button>
            <Button kind="quiet" size="sm" asChild>
              <a href={`/api/faculty/${id}/report/export?fmt=csv`}>CSV</a>
            </Button>
          </>
        )}
      </div>

      {manages && id && (
        <section className="space-y-2" aria-labelledby="person-account">
          <SectionTitle>
            <span id="person-account">Account</span>
          </SectionTitle>
          <AccountForm
            userId={id}
            onResetPassword={() => setResetting(true)}
            onViewAs={() => setViewing(true)}
            canViewAs={me?.role === "SUPER_ADMIN" && faculty.role !== "SUPER_ADMIN" && me?.id !== id}
          />
        </section>
      )}
      {manages && id && <PersonAudit userId={id} />}
      <ConfirmDialog
        open={viewing}
        onOpenChange={setViewing}
        title={`View the app as ${firstName(faculty.name) || "them"}?`}
        description="You see exactly what they see, read-only in spirit: anything you do is done as them. The start and the end are written to the audit log, and a banner stays up until you stop."
        confirmLabel={`View as ${firstName(faculty.name) || "them"}`}
        onConfirm={() => viewAs()}
      />
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

      {manages && (
        <SectionTitle>Publication record</SectionTitle>
      )}
      <section className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
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

      <section className="space-y-3" aria-labelledby="person-scopus">
        <SectionTitle>
          <span id="person-scopus">Scopus profile</span>
        </SectionTitle>
        <ScopusProfileCard profile={report.scopus_profile} />
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
  /** Academic figures, not money, so a head is shown them too. */
  scopus_profile?: ScopusProfile | null
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

      <section className="space-y-3" aria-labelledby="hod-person-scopus">
        <SectionTitle>
          <span id="hod-person-scopus">Scopus profile</span>
        </SectionTitle>
        <ScopusProfileCard profile={data.scopus_profile} />
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
/* One head per department                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The college's rule: exactly one head per department, and never a head of no
 * department. The server enforces it (409 naming the head in post, and a
 * `replace_hod` flag to demote them in the same write); this surfaces it
 * before the save, where the office can decide rather than read an error.
 *
 * `replacing` is the id of the head the office agreed to replace, not a
 * boolean, so a tick given for one department's head does not carry over to
 * another's when the department is changed afterwards.
 */
function useHeadInPost(role: string, department: string, excludeId?: string) {
  const dept = department.trim()
  const wantsHead = role === "HOD"
  const query = new URLSearchParams({ role: "HOD", active: "true", department: dept, limit: "5" })
  const heads = useApi<PeoplePayload>(
    ["people", "heads", dept.toLowerCase()],
    `/api/admin/users?${query.toString()}`,
    { enabled: wantsHead && Boolean(dept) }
  )
  const current =
    wantsHead && dept ? (heads.data?.results.find((u) => u.id !== excludeId) ?? null) : null
  const [replacing, setReplacing] = useState<string | null>(null)
  return {
    dept,
    current,
    noDepartment: wantsHead && !dept,
    replace: current !== null && replacing === current.id,
    setReplace: (yes: boolean) => setReplacing(yes && current ? current.id : null),
  }
}

const HEAD_NEEDS_DEPARTMENT = "A head needs a department. Choose one, or pick another role."

function ReplaceHead({
  current,
  department,
  newHead,
  checked,
  onChange,
}: {
  current: PersonRow
  department: string
  newHead: string
  checked: boolean
  onChange: (yes: boolean) => void
}) {
  const name = current.name || current.email
  return (
    <Callout tone="caution" title={`${name} is HOD of ${department}. Replace them?`}>
      <p>
        A department has one head. Replacing makes {newHead} head of {department}, and {name}{" "}
        goes back to being faculty. Both happen in the same save, and both go in the audit log.
      </p>
      <div className="mt-2">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
          label={`Replace ${name}`}
        />
      </div>
    </Callout>
  )
}

/* ------------------------------------------------------------------------ */
/* AccountForm — the one place a person's details are changed               */
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
  orcid_id?: string | null
  must_change_password: boolean
  stats: {
    claims: number
    paid_claims: number
    drafts: number
    in_review: number
    last_claim_at: string | null
  }
}

/** Mirrors `PRIVILEGED_ROLES` in core/api/admin.py: only a super admin
 *  appoints a role that decides whether money moves. */
const PRIVILEGED: Role[] = ["SUPER_ADMIN", "DIRECTOR", "FINANCE"]

const FIELD_NAME: Record<string, string> = {
  name: "Full name",
  department: "Department",
  designation: "Designation",
  staff_id: "Staff ID",
  biometric_id: "Biometric ID",
  scopus_author_url: "Scopus link",
  scopus_author_id: "Scopus ID",
  role: "Role",
  active: "Active",
  faculty_type: "Research faculty",
  research_quota: "Quota",
  research_quota_note: "Quota note",
}

/** One section of the form: a title and a sentence on the left, the fields
 *  on the right, a hairline between sections. */
function FormSection({
  title,
  sentence,
  children,
}: {
  title: string
  sentence: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-3 border-t border-line pt-6 md:grid-cols-[15rem_minmax(0,1fr)]">
      <div>
        <h3 className="text-base font-medium">{title}</h3>
        <p className="mt-1 text-sm text-fg-muted">{sentence}</p>
      </div>
      <div className="min-w-0 max-w-xl space-y-4">{children}</div>
    </section>
  )
}

/**
 * Two tiers of field, and the split is the point of the screen.
 *
 * **Routing** (role, department, whether the account is active) is the office's
 * ordinary work. **Identity** (name, designation, staff ID, biometric ID, the
 * Scopus link) is a super admin's alone, and the server refuses everyone else
 * field by field. The research post and its quota belong to the research
 * coordinator as well (`may_set_field` in core/api/auth.py).
 *
 * Fields a role may not set are shown disabled with the reason beside them:
 * hiding them would make the page look like it was missing something, and
 * offering them would be a guaranteed 403.
 */
function AccountForm({
  userId,
  onResetPassword,
  onViewAs,
  canViewAs,
}: {
  userId: string
  onResetPassword: () => void
  onViewAs: () => void
  canViewAs: boolean
}) {
  const { me } = useAuth()
  const isSuperAdmin = can(me?.role).admin
  const mayEditPost = isSuperAdmin || me?.role === "RESEARCH_COORDINATOR"
  const editingSelf = me?.id === userId

  const { data, isLoading, error } = useApi<AccountDetail>(
    ["admin", "user", userId],
    `/api/admin/users/${userId}`
  )
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments")

  const [form, setForm] = useState<AccountFields | null>(null)
  const [confirming, setConfirming] = useState(false)
  function fromData(d: AccountDetail): AccountFields {
    return {
      name: d.name || "",
      department: d.department || "",
      designation: d.designation || "",
      staff_id: d.staff_id || "",
      biometric_id: d.biometric_id || "",
      scopus_author_url: d.scopus_author_url || "",
      scopus_author_id: d.scopus_author_id || "",
      role: d.role,
      active: d.active,
      faculty_type: d.faculty_type || "REGULAR",
      research_quota: d.research_quota,
      research_quota_note: d.research_quota_note || "",
    }
  }
  useEffect(() => {
    if (data) setForm(fromData(data))
  }, [data])

  const save = useApiMutation<Partial<AccountFields> & { replace_hod?: boolean }, AccountDetail>(
    `/api/admin/users/${userId}`,
    {
      method: "PATCH",
      invalidates: [
        ["admin", "user", userId],
        ["people"],
        ["faculty-report", userId],
        ["person-audit", userId],
      ],
    }
  )

  const head = useHeadInPost(form?.role ?? "", form?.department ?? "", userId)
  // The server checks the post only when a save changes who holds it, and
  // only for an account left on: one switched off holds no post.
  const takesPost =
    !!form &&
    !!data &&
    form.active &&
    (form.role !== data.role ||
      form.department !== (data.department || "") ||
      form.active !== data.active)
  const mustReplace = takesPost && head.current !== null
  const blocked = takesPost && (head.noDepartment || (mustReplace && !head.replace))

  function set<K extends keyof AccountFields>(key: K, value: AccountFields[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  // Only what actually moved. The server refuses the whole request for a
  // non-admin the moment an identity field is present, even unchanged, and
  // an empty quota (null) must compare equal to an empty string.
  const patch: Partial<AccountFields> & { replace_hod?: boolean } = {}
  if (form && data) {
    for (const key of Object.keys(form) as (keyof AccountFields)[]) {
      if ((form[key] ?? "") !== (data[key] ?? "")) {
        // @ts-expect-error narrowed by the key loop, which TS cannot follow
        patch[key] = form[key]
      }
    }
  }
  const changes = Object.keys(patch).length
  const roleChanged = "role" in patch
  const deactivating = patch.active === false
  const dangerous = roleChanged || deactivating
  const verb = deactivating ? "Deactivate" : roleChanged ? "Change role" : "Save changes"

  async function submit() {
    if (!form || !data || changes === 0) return
    const body = { ...patch }
    if (mustReplace && head.replace) body.replace_hod = true
    const who = data.name || data.email
    try {
      await save.mutateAsync(body)
      toast.ok(
        deactivating
          ? `Deactivated ${who}`
          : roleChanged
            ? `Changed role: ${who} is now ${roleLabel(form.role)}`
            : `Saved ${changes} ${changes === 1 ? "change" : "changes"} to ${who}`
      )
    } catch (err) {
      toast.fail(err)
    }
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load this account"
        message={
          error.status === 403
            ? "Only the office and a super admin can edit accounts."
            : "The server did not answer. Nothing has been lost."
        }
      />
    )
  }
  if (isLoading || !form || !data) return <SkeletonRows rows={6} rowHeight={40} />

  const targetPrivileged = PRIVILEGED.includes(data.role)
  const roleLocked = editingSelf || (!isSuperAdmin && targetPrivileged)
  const roleOptions: ComboboxOption[] = ASSIGNABLE_ROLE_KEYS.filter(
    (r) => isSuperAdmin || !PRIVILEGED.includes(r) || r === data.role
  ).map((r) => ({ value: r, label: ROLE_CHOICE_LABEL[r] }))
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "No department" },
    ...(departments.data ?? []).map((d) => ({ value: d, label: d })),
  ]
  const identityHint = isSuperAdmin
    ? undefined
    : "Only a super admin can change this."

  return (
    <form
      aria-label="Account"
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        if (dangerous) setConfirming(true)
        else void submit()
      }}
    >
      {data.stats.claims > 0 && (
        <Callout tone="info" title="This account has a record behind it">
          {data.stats.claims} papers, {data.stats.paid_claims} of them paid. Changing the staff or
          biometric ID changes what future payments are made against; it does not rewrite what
          has already been paid.
        </Callout>
      )}

      <FormSection
        title="Identity"
        sentence={
          isSuperAdmin
            ? "Who they are on paper. The staff ID is what a payment is made against."
            : "A super admin's to change. The office clears the claims these decide, so it cannot also set them."
        }
      >
        <Field label="Full name" hint={identityHint}>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} disabled={!isSuperAdmin} />
        </Field>
        <Field label="Designation">
          <Input
            value={form.designation}
            onChange={(e) => set("designation", e.target.value)}
            disabled={!isSuperAdmin}
          />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <Field label="Staff ID">
            <Input value={form.staff_id} onChange={(e) => set("staff_id", e.target.value)} disabled={!isSuperAdmin} />
          </Field>
          <Field label="Biometric ID">
            <Input
              value={form.biometric_id}
              onChange={(e) => set("biometric_id", e.target.value)}
              disabled={!isSuperAdmin}
            />
          </Field>
        </div>
        {data.employee_id && <Meta className="block">Employee ID {data.employee_id}</Meta>}
      </FormSection>

      <FormSection
        title="Role and department"
        sentence="What this account may do, and which head sees their work. A department has one head."
      >
        <Field
          label="Role"
          hint={
            editingSelf
              ? "You cannot change your own role. Ask another admin."
              : roleLocked
                ? "Only a super admin can change a role that decides whether money moves."
                : "A head of department is faculty who also heads the department."
          }
        >
          <Combobox
            value={form.role}
            onChange={(v) => set("role", v as Role)}
            options={roleOptions}
            disabled={roleLocked}
          />
        </Field>
        <Field
          label="Department"
          error={takesPost && head.noDepartment ? HEAD_NEEDS_DEPARTMENT : undefined}
        >
          <Combobox
            value={form.department}
            onChange={(v) => set("department", v)}
            options={departmentOptions}
            placeholder="No department"
          />
        </Field>
        {mustReplace && head.current && (
          <ReplaceHead
            current={head.current}
            department={head.dept}
            newHead={data.name || data.email}
            checked={head.replace}
            onChange={head.setReplace}
          />
        )}
      </FormSection>

      <FormSection
        title="Research faculty and quota"
        sentence={
          mayEditPost
            ? "A research post is paid to do research, so the scheme rewards only what exceeds the quota."
            : "Set by the research coordinator or a super admin. The office clears the claims the quota decides."
        }
      >
        <Checkbox
          checked={form.faculty_type === "RESEARCH"}
          onCheckedChange={(v) => set("faculty_type", v === true ? "RESEARCH" : "REGULAR")}
          disabled={!mayEditPost}
          label="Research faculty"
          hint="Their first papers each year, up to the quota, carry no remuneration."
        />
        {form.faculty_type === "RESEARCH" && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Field label="Papers a year before any incentive">
              <Input
                value={form.research_quota == null ? "" : String(form.research_quota)}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  set("research_quota", Number.isFinite(n) && n >= 0 ? n : null)
                }}
                inputMode="numeric"
                placeholder="No quota"
                disabled={!mayEditPost}
              />
            </Field>
            <Field label="Where the number came from">
              <Input
                value={form.research_quota_note}
                onChange={(e) => set("research_quota_note", e.target.value)}
                placeholder="Agreed in the appointment letter"
                disabled={!mayEditPost}
              />
            </Field>
          </div>
        )}
        {form.faculty_type === "RESEARCH" && form.research_quota != null && (
          <Meta className="block">
            With a quota of {form.research_quota}, paper {form.research_quota + 1} onwards each year is
            paid. Leave it empty and nothing is zeroed.
          </Meta>
        )}
      </FormSection>

      <FormSection
        title="Scopus and ORCID"
        sentence="The profile a paper is checked against. The wrong one attributes their work to somebody else."
      >
        <Field label="Scopus author ID" hint={identityHint}>
          <Input
            value={form.scopus_author_id}
            onChange={(e) => set("scopus_author_id", e.target.value)}
            disabled={!isSuperAdmin}
            inputMode="numeric"
          />
        </Field>
        <Field label="Scopus author link">
          <Input
            value={form.scopus_author_url}
            onChange={(e) => set("scopus_author_url", e.target.value)}
            disabled={!isSuperAdmin}
          />
        </Field>
        <p className="text-sm">
          <span className="text-fg-muted">ORCID </span>
          {data.orcid_id ? (
            <a
              className="underline decoration-line underline-offset-2 hover:decoration-fg"
              href={`https://orcid.org/${data.orcid_id}`}
              target="_blank"
              rel="noreferrer"
            >
              {data.orcid_id}
            </a>
          ) : (
            <span className="text-fg-muted">not added yet. They add it on their own profile.</span>
          )}
        </p>
      </FormSection>

      <FormSection
        title="Account and sign-in"
        sentence="An inactive account cannot sign in. Its papers and payments stay on record."
      >
        <Checkbox
          checked={form.active}
          onCheckedChange={(v) => set("active", v === true)}
          disabled={editingSelf}
          label="Active"
          hint={editingSelf ? "You cannot deactivate the account you are signed in as." : undefined}
        />
        <p className="text-sm text-fg-muted">
          {data.must_change_password
            ? "They will be asked to choose a new password the next time they sign in."
            : "They sign in with their own password or their college Google account."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" kind="default" size="sm" onClick={onResetPassword}>
            <KeyRound />
            Reset password
          </Button>
          {canViewAs && (
            <Button type="button" kind="quiet" size="sm" onClick={onViewAs}>
              <Eye />
              View the app as {firstName(data.name) || "them"}
            </Button>
          )}
          {(
            <Button type="button" kind="quiet" size="sm" asChild>
              <Link to="/people/matches?tab=duplicates">
                <Users />
                Link a duplicate account
              </Link>
            </Button>
          )}
        </div>
      </FormSection>

      <div
        className={cn(
          "sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur",
          changes === 0 && "static"
        )}
      >
        <Meta className="mr-auto" aria-live="polite">
          {changes === 0
            ? "No unsaved changes."
            : `${changes} unsaved ${changes === 1 ? "change" : "changes"}: ${Object.keys(patch)
                .map((k) => FIELD_NAME[k] ?? k)
                .join(", ")}`}
        </Meta>
        <Button
          type="button"
          kind="quiet"
          disabled={changes === 0 || save.isPending}
          onClick={() => setForm(fromData(data))}
        >
          Discard
        </Button>
        <Button type="submit" kind="primary" disabled={changes === 0 || save.isPending || blocked}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={
          deactivating
            ? `Deactivate ${data.name || data.email}?`
            : `Change ${firstName(data.name) || "their"}'s role to ${roleLabel(form.role)}?`
        }
        description={
          deactivating
            ? "They will not be able to sign in. Their papers and payments stay on record, and you can switch the account back on."
            : `From ${roleLabel(data.role)} to ${roleLabel(form.role)}. What they can see and approve changes the moment you save. It is written to the audit log.`
        }
        confirmLabel={verb}
        danger
        onConfirm={() => submit()}
      />
    </form>
  )
}

/* ------------------------------------------------------------------------ */
/* PersonAudit — who changed what on this account                           */
/* ------------------------------------------------------------------------ */

type AuditRow = {
  id: string
  action: string
  entity: string
  entity_id: string
  actor: string | null
  detail_json: string | null
  created_at: string
}

const AUDIT_VERB: Record<string, string> = {
  USER_CREATE: "created the account",
  USER_UPDATE: "changed",
  USER_RESET_PASSWORD: "reset the password",
  IMPERSONATE_START: "started viewing the app as them",
  IMPERSONATE_STOP: "stopped viewing the app as them",
}

function showValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty"
  if (key === "role") return roleLabel(String(v))
  if (key === "active") return v ? "on" : "off"
  if (key === "faculty_type") return v === "RESEARCH" ? "yes" : "no"
  return String(v)
}

function PersonAudit({ userId }: { userId: string }) {
  const { data, isLoading, isError } = useApi<{ results: AuditRow[] }>(
    ["person-audit", userId],
    `/api/admin/audit?${new URLSearchParams({ q: userId, limit: "30" })}`
  )
  const rows = (data?.results ?? []).filter((r) => r.entity === "User" && r.entity_id === userId)
  return (
    <section className="space-y-3" aria-labelledby="person-history">
      <SectionTitle>
        <span id="person-history">Who changed what</span>
      </SectionTitle>
      {isError ? (
        <Meta>The audit log is not open to this account.</Meta>
      ) : isLoading ? (
        <SkeletonRows rows={3} />
      ) : rows.length === 0 ? (
        <Meta>No changes recorded for this account yet.</Meta>
      ) : (
        <ol className="divide-y divide-line">
          {rows.map((r) => {
            let diff: Record<string, { from: unknown; to: unknown }> = {}
            try {
              diff = r.detail_json ? JSON.parse(r.detail_json) : {}
            } catch {
              diff = {}
            }
            const lines = r.action === "USER_UPDATE" ? Object.entries(diff) : []
            return (
              <li key={r.id} className="py-2.5 text-sm">
                <p>
                  <span className="font-medium">{r.actor ?? "The system"}</span>{" "}
                  {AUDIT_VERB[r.action] ?? r.action.replace(/_/g, " ").toLowerCase()}
                  {r.action === "USER_UPDATE" && lines.length === 0 ? " nothing" : ""}
                  <Meta className="ml-2">
                    {new Date(r.created_at).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </Meta>
                </p>
                {lines.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-fg-muted">
                    {lines.map(([k, v]) => (
                      <li key={k}>
                        {FIELD_NAME[k] ?? k}: {showValue(k, v?.from)} to {showValue(k, v?.to)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
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
      toast.ok(`Password reset for ${name}. They must change it when they sign in.`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
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
            {reset.isPending ? "Resetting…" : "Reset password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


/* ------------------------------------------------------------------------ */
/* NewAccount                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Put somebody on the roster.
 *
 * No password field, deliberately. A password chosen on somebody else's
 * behalf and typed into a form has been read by the person who typed it and
 * is usually still in their sent items — and these accounts decide who gets
 * paid. The account is created with no usable password at all, and there are
 * two honest ways in from there: whoever created it uses "Set a password" and
 * hands the value over, or the person signs in with the Google account the
 * college gave them, which never consults a password.
 *
 * The role is asked for up front rather than defaulted quietly. A faculty
 * account and a finance account differ by what they can approve and what they
 * are shown of the money, and picking that by accident is not a mistake the
 * screen should make easy.
 */
function NewAccount({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState<string>("FACULTY")
  const [department, setDepartment] = useState("")
  const [staffId, setStaffId] = useState("")
  const [designation, setDesignation] = useState("")

  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments")
  const create = useApiMutation<
    Record<string, unknown>,
    { id: string; email: string; needs_password: boolean }
  >("/api/admin/users", { invalidates: [["people"]] })

  const head = useHeadInPost(role, department)

  const looksLikeEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  const canSubmit =
    looksLikeEmail &&
    name.trim().length > 1 &&
    !!role &&
    !head.noDepartment &&
    (head.current === null || head.replace) &&
    !create.isPending

  async function submit() {
    try {
      const created = await create.mutateAsync({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role,
        department: department.trim() || null,
        staff_id: staffId.trim() || null,
        designation: designation.trim() || null,
        ...(head.current && head.replace ? { replace_hod: true } : {}),
      })
      toast.ok(
        `${created.email} created. Set a password for them, or they can sign in with Google.`
      )
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
          <DialogDescription>
            Someone who needs to sign in to this system.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="info" title="No password is set here">
            The account is created without one. Use "Reset password" on their
            record afterwards and hand the value over, or let them sign in with
            the Google account for their email.
          </Callout>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Email"
              error={
                email.trim().length > 0 && !looksLikeEmail
                  ? "That does not look like an email address."
                  : undefined
              }
            >
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
                autoFocus
              />
            </Field>
            <Field label="Full name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Role"
              hint="What they can see and approve. Changeable later."
            >
              <Combobox
                value={role}
                onChange={setRole}
                options={(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({
                  value: r,
                  label: ROLE_CHOICE_LABEL[r],
                }))}
              />
            </Field>
            <Field
              label="Department"
              error={head.noDepartment ? HEAD_NEEDS_DEPARTMENT : undefined}
            >
              <Combobox
                value={department}
                onChange={setDepartment}
                options={[
                  { value: "", label: "None" },
                  ...(departments.data || []).map((d) => ({ value: d, label: d })),
                ]}
              />
            </Field>
          </div>

          {head.current && (
            <ReplaceHead
              current={head.current}
              department={head.dept}
              newHead={name.trim() || "the new account"}
              checked={head.replace}
              onChange={head.setReplace}
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Staff ID" hint="Optional.">
              <Input value={staffId} onChange={(e) => setStaffId(e.target.value)} />
            </Field>
            <Field label="Designation" hint="Optional.">
              <Input
                value={designation}
                onChange={(e) => setDesignation(e.target.value)}
              />
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {create.isPending ? "Creating…" : "Create the account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
