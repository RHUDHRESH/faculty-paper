import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ChevronDown, ChevronRight, Search, SearchX, UsersRound } from "lucide-react"

import { useAuth, type Role } from "@/app/auth"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { ClaimNo } from "@/ui/claim-number"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { PageHeader } from "@/ui/page-header"
import { Pagination } from "@/ui/pagination"
import { Avatar, initialsOf } from "@/ui/person"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import {
  STATUS_OPTIONS,
  studentsWord,
  type TeamRow,
  type TeamsPayload,
} from "@/pages/teams-types"

/**
 * Student teams: every final-year project team the reader may see, as one
 * table, with the people, the papers and the claim on each.
 *
 * The server decides who sees what. The research office, the Principal and
 * the Director see every team; a head of department sees their department's,
 * with no money; anybody else sees the teams they mentor, and for them this
 * page is "My teams".
 */

const PAGE_SIZES = [30, 50, 100]
const PAGE_SIZE = 30
/** Export: the API's largest page, and the most rows one file will carry. */
const EXPORT_PAGE = 100
const EXPORT_LIMIT = 5000

const count = (n: number) => n.toLocaleString("en-IN")

/** What the server will say the scope is, until it has: mirrors `student_teams.visible_teams`. */
function scopeFor(role: Role | undefined): TeamsPayload["scope"] {
  if (role === "HOD") return "department"
  const all: Role[] = ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR"]
  return role && all.includes(role) ? "college" : "mine"
}

export function Teams() {
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const q = params.get("q") ?? ""
  const year = params.get("year") ?? ""
  const department = params.get("department") ?? ""
  const status = params.get("status") ?? ""
  const mentor = params.get("mentor") ?? ""
  const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0)
  const limitParam = Number.parseInt(params.get("limit") ?? "", 10)
  const limit = PAGE_SIZES.includes(limitParam) ? limitParam : PAGE_SIZE

  function set(changes: Record<string, string | null>) {
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
  }

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
  if (year) filters.set("academic_year", year)
  if (department) filters.set("department", department)
  if (status) filters.set("status", status)
  if (mentor) filters.set("mentor", mentor)
  const listQuery = new URLSearchParams(filters)
  listQuery.set("limit", String(limit))
  listQuery.set("offset", String(page * limit))

  const list = useApi<TeamsPayload>(["teams", "list", listQuery.toString()], `/api/teams?${listQuery.toString()}`, {
    placeholderData: (prev) => prev,
  })
  const data = list.data
  const rows = data?.results ?? []
  const scope = data?.scope ?? scopeFor(me?.role)
  const mineOnly = scope === "mine"
  const title = mineOnly ? "My teams" : "Student teams"
  const filtered = Boolean(q || year || department || status || mentor)

  function clear() {
    setDraft("")
    setParams(new URLSearchParams(), { replace: true })
  }

  /** Every team the filters match, page by page (capped), for the export. */
  async function fetchAllRows(): Promise<TeamRow[]> {
    const out: TeamRow[] = []
    let offset = 0
    let total = Number.POSITIVE_INFINITY
    while (offset < total && out.length < EXPORT_LIMIT) {
      const qs = new URLSearchParams(filters)
      qs.set("limit", String(EXPORT_PAGE))
      qs.set("offset", String(offset))
      const res = await api<TeamsPayload>(`/api/teams?${qs.toString()}`)
      total = res.total
      if (res.results.length === 0) break
      out.push(...res.results)
      offset += res.results.length
    }
    return out.slice(0, EXPORT_LIMIT)
  }

  const yearOptions: ComboboxOption[] = [
    { value: "", label: "Every year" },
    ...(data?.years ?? []).map((y) => ({ value: y, label: y })),
  ]
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "All departments" },
    ...(data?.departments ?? []).map((d) => ({ value: d, label: d })),
  ]
  const statusOptions: ComboboxOption[] = STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))
  // A head has one department and a mentor a few teams; a department filter is for the many.
  const showDepartment = scope === "college" && (data?.departments.length ?? 0) > 1
  const showYear = (data?.years.length ?? 0) > 1 || Boolean(year)

  const words: string[] = []
  if (q) words.push(`search "${q}"`)
  if (year) words.push(year)
  if (department) words.push(department)
  if (status) words.push(STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status)
  if (mentor) words.push(`mentor ${mentor}`)
  const headline = data ? `${count(data.total)} ${data.total === 1 ? "team" : "teams"}` : title
  const subtitle =
    (words.length ? `${headline}, filtered by ${words.join(", ")}.` : `${headline}.`) +
    (data && data.total > EXPORT_LIMIT ? ` The file holds the first ${count(EXPORT_LIMIT)}.` : "")

  const sub = mineOnly
    ? "The final-year project teams you mentor, the papers they have written, and whether each has been claimed."
    : scope === "department"
      ? "The final-year project teams in your department, with their papers and where each claim stands."
      : "Every final-year project team, who is on it, the papers it has written and where its claim stands."

  return (
    <div className="page space-y-6">
      <PageHeader title={title} sub={sub} />

      <Answer
        items={[
          { value: data?.counts.teams, label: mineOnly ? "Your teams" : "Teams", zero: "No teams here" },
          { value: data?.counts.students, label: "Students" },
          {
            value: data?.counts.with_publication,
            label: "Teams with a paper",
            to: "/teams?status=with_publication",
            zero: "No team has a paper yet",
          },
          {
            value: data?.counts.claimed,
            label: "Teams claimed",
            to: "/teams?status=claimed",
            zero: "No team claimed yet",
          },
        ]}
      />

      <div className={filterBar}>
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Team number, register number or name"
            aria-label="Search teams"
            className="pl-8"
          />
        </div>
        {showYear && (
          <Combobox
            value={year}
            onChange={(v) => set({ year: v || null })}
            options={yearOptions}
            placeholder="Every year"
            aria-label="Filter by year"
            className="w-40"
          />
        )}
        {showDepartment && (
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
          value={status}
          onChange={(v) => set({ status: v || null })}
          options={statusOptions}
          placeholder="Any status"
          aria-label="Filter by status"
          className="w-56"
        />
        {filtered && (
          <Button kind="quiet" onClick={clear}>
            Clear
          </Button>
        )}
      </div>

      {list.isLoading ? (
        <SkeletonRows rows={8} rowHeight={64} />
      ) : list.isError ? (
        <ErrorState
          title="Could not load the teams"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => list.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : UsersRound}
          title={filtered ? "No team matches" : mineOnly ? "You mentor no team on the roster" : "No teams yet"}
          message={
            filtered
              ? "Try clearing a filter, or search a team number or a register number."
              : mineOnly
                ? "If you do mentor one, ask the research office to check the roster names you by your staff ID."
                : "Teams appear here once the research office imports the final-year project roster."
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
          <Table<TeamRow>
            caption={title}
            rows={rows}
            columns={teamColumns({ money: data?.money ?? false, mineOnly, scope })}
            getKey={(r) => r.id}
            stack
            minWidth="56rem"
            tools={{ id: "student-teams", title, subtitle, getAllRows: fetchAllRows }}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Pagination
              page={page}
              pageSize={limit}
              total={data?.total ?? 0}
              onChange={(p) => set({ page: p ? String(p) : null })}
            />
            <Combobox
              value={String(limit)}
              onChange={(v) => set({ limit: v === String(PAGE_SIZE) ? null : v, page: null })}
              options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} per page` }))}
              aria-label="Rows per page"
              className="w-36"
            />
          </div>
        </>
      )}
    </div>
  )
}

/** The mentor's name and staff ID, for a file. */
function mentorWords(r: TeamRow): string | null {
  return r.mentor?.name ?? null
}

function teamColumns(o: { money: boolean; mineOnly: boolean; scope: TeamsPayload["scope"] }): Column<TeamRow>[] {
  const cols: Column<TeamRow>[] = [
    {
      key: "code",
      header: "Team number",
      exportValue: (r) => r.code,
      exportKind: "text",
      cell: (r) => (
        <div className="min-w-0">
          <Link to={`/teams/${encodeURIComponent(r.code)}`} className="block font-medium tabular hover:underline">
            {r.code}
          </Link>
          {r.academic_year && <Meta className="block">{r.academic_year}</Meta>}
        </div>
      ),
    },
  ]
  if (o.scope === "college") {
    cols.push({
      key: "department",
      header: "Department",
      empty: "No department",
      exportValue: (r) => r.department,
      exportKind: "text",
      cell: (r) => r.department,
    })
  }
  if (!o.mineOnly) {
    cols.push({
      key: "mentor",
      header: "Mentor",
      empty: "No mentor on the roster",
      exportValue: mentorWords,
      exportKind: "text",
      cell: (r) =>
        r.mentor ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar
              person={{
                name: r.mentor.name ?? "",
                initials: r.mentor.initials ?? initialsOf(r.mentor.name ?? ""),
                photo_url: r.mentor.photo_url ?? null,
              }}
              size="sm"
            />
            <div className="min-w-0">
              <span className="block truncate">{r.mentor.name}</span>
              {r.mentor.staff_id && <Meta className="block truncate">{r.mentor.staff_id}</Meta>}
            </div>
          </div>
        ) : null,
    })
  }
  cols.push(
    {
      key: "students",
      header: "Students",
      exportValue: (r) => r.student_count,
      exportKind: "number",
      cell: (r) => <StudentsCell row={r} />,
    },
    {
      key: "register_numbers",
      header: "Register numbers",
      defaultHidden: true,
      exportValue: (r) => r.students.map((s) => s.reg_no || s.name).join(", ") || null,
      exportKind: "text",
      cell: (r) => <span className="tabular break-words">{r.students.map((s) => s.reg_no).filter(Boolean).join(", ")}</span>,
    },
    {
      key: "project",
      header: "Project",
      truncate: true,
      empty: "No title on the roster",
      exportValue: (r) => r.project_title,
      exportKind: "text",
      cell: (r) => r.project_title,
    },
    {
      key: "papers",
      header: "Papers",
      align: "right",
      exportValue: (r) => r.publications_count,
      exportKind: "number",
      cell: (r) => <span className={cn("tabular", r.publications_count === 0 && "text-fg-muted")}>{count(r.publications_count)}</span>,
    },
    {
      key: "claim",
      header: "Claim",
      exportValue: (r) => (r.claim ? `${r.claim.ticket_number ?? "No claim no. yet"}, ${r.claim.stage}` : "Not claimed"),
      exportKind: "text",
      cell: (r) => <ClaimCell row={r} />,
    }
  )
  return cols
}

/** "4 students", with the names a hover or a press away. */
function StudentsCell({ row: r }: { row: TeamRow }) {
  const [open, setOpen] = useState(false)
  if (r.student_count === 0) return <span className="text-caution">No students listed</span>
  const names = r.students.map((s) => (s.reg_no ? `${s.name} (${s.reg_no})` : s.name))
  const Icon = open ? ChevronDown : ChevronRight
  return (
    <div className="min-w-0" title={names.join("\n")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-ml-1 inline-flex items-center gap-1 rounded px-1 text-left hover:bg-sunken"
      >
        <Icon aria-hidden className="size-3.5 text-fg-subtle" />
        <span className="tabular">{studentsWord(r.student_count)}</span>
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 text-sm text-fg-muted">
          {r.students.map((s, i) => (
            <li key={`${s.reg_no ?? ""}-${i}`} className="break-words">
              {s.name}
              {s.reg_no && <span className="tabular text-fg-subtle"> · {s.reg_no}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Where the team's claim stands, with its number as a link. */
function ClaimCell({ row: r }: { row: TeamRow }) {
  if (!r.claim) return <span className="text-fg-muted">Not claimed</span>
  return (
    <div className="min-w-0 space-y-0.5">
      <Link to={r.claim.url} className="inline-block hover:underline" aria-label={`Open claim ${r.claim.ticket_number ?? ""}`.trim()}>
        <ClaimNo value={r.claim.ticket_number} copy={false} />
      </Link>
      <div>
        <Chip tone="neutral">{r.claim.stage}</Chip>
      </div>
    </div>
  )
}

