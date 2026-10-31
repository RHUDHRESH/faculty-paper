import { Link, useParams, useSearchParams } from "react-router-dom"
import { Download, Mail, Search } from "lucide-react"

import { useCrumbLabel } from "@/app/crumbs"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import { Input, Select } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { PageHeader } from "@/ui/page-header"
import { Avatar, initialsOf } from "@/ui/person"
import { Details, Section } from "@/ui/section"
import { ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import {
  type Brief,
  change,
  type Dept,
  deptUrl,
  type Head,
  n,
  papersUrl,
  rupees,
} from "@/pages/principal-parts"
import { FiveYears, type YearColumn } from "@/pages/principal/five-years"

/**
 * Departments, as the Principal reads them (docs/jtbd/principal.md, Q2).
 *
 * `/department` is a head of department's own view of their own department.
 * She does not have one; she has all of them, and her question is "which
 * departments need a push?" -- per teacher, so a large department does not
 * win by size. `Departments` is that list, as one table with a column that
 * says which ones need a push and which are rising; `DepartmentPage` is one
 * department opened: its head, how it compares with the college, its five
 * years, its people and where they publish. The figures come from the year
 * brief's own service. The rules behind "needs a push" are one line away.
 */

function YearPick({ years, value, onChange }: { years: number[]; value: number | null; onChange: (v: string) => void }) {
  return (
    <div className="w-36 print:hidden">
      <Combobox
        aria-label="Year"
        value={value ? String(value) : null}
        onChange={onChange}
        options={years.map((y) => ({ value: String(y), label: String(y) }))}
      />
    </div>
  )
}

const pctChange = (d: Dept) =>
  d.change == null ? (d.papers ? "New this year" : "None") : `${d.change > 0 ? "+" : d.change < 0 ? "−" : ""}${Math.abs(d.change)}%`

function Face({ head }: { head: Head }) {
  if (!head) return null
  return (
    <Avatar size="sm" person={{ name: head.name, initials: head.initials ?? initialsOf(head.name), photo_url: head.photo_url ?? null }} />
  )
}

export function Departments() {
  const [params, setParams] = useSearchParams()
  const year = params.get("year") ?? ""
  const q = params.get("q") ?? ""
  const show = ["push", "rising"].includes(params.get("show") ?? "") ? (params.get("show") as string) : ""
  const brief = useApi<Brief>(["reports-brief", year], `/api/reports/brief${year ? `?year=${year}` : ""}`)
  const b = brief.data

  function set(key: string, value: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  const pushed = new Map((b?.push ?? []).map((d) => [d.department, d.reasons]))
  const rising = new Set((b?.rising ?? []).map((d) => d.department))
  const college = b?.totals.per_teacher ?? 0

  const rows = (b?.departments ?? []).filter((d) => {
    if (q && !d.department.toLowerCase().includes(q.toLowerCase())) return false
    if (show === "push") return pushed.has(d.department)
    if (show === "rising") return rising.has(d.department)
    return true
  })
  const anyBudget = (b?.departments ?? []).some((d) => d.budget != null)
  const y = b?.year ?? 0

  const columns: Column<Dept>[] = [
    {
      key: "department",
      header: "Department",
      exportValue: (d) => d.department,
      cell: (d) => (
        <span className="flex items-center gap-3">
          <Face head={d.head ?? null} />
          <span className="min-w-0">
            <Link to={deptUrl(d.department, y)} className="block text-base font-medium leading-snug hover:text-accent">
              {d.department}
            </Link>
            <span className="block text-sm text-fg-muted">{d.head ? `Head: ${d.head.name}` : "No head of department is set"}</span>
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Where it stands",
      label: "Where it stands",
      empty: "On track",
      exportValue: (d) => (pushed.has(d.department) ? `Needs a push: ${pushed.get(d.department)!.join(". ")}` : rising.has(d.department) ? "Rising" : "On track"),
      cell: (d) => {
        const why = pushed.get(d.department)
        if (why)
          return (
            <span className="block">
              <span className="font-medium text-caution">Needs a push</span>
              <span className="block text-sm text-fg-muted">{why.join(". ")}.</span>
            </span>
          )
        if (rising.has(d.department)) return <span className="font-medium text-positive">Rising</span>
        return <span className="text-fg-muted">On track</span>
      },
    },
    { key: "teachers", header: "Teachers", align: "right", exportKind: "number", exportValue: (d) => d.teachers, cell: (d) => n(d.teachers) },
    {
      key: "papers",
      header: `Papers ${y}`,
      align: "right",
      empty: "None",
      exportKind: "number",
      exportValue: (d) => d.papers,
      cell: (d) =>
        d.papers > 0 ? (
          <Link to={papersUrl({ year: y, department: d.department })} className="underline-offset-4 hover:underline">
            {n(d.papers)}
          </Link>
        ) : null,
    },
    { key: "prev", header: String(y - 1), align: "right", empty: "None", exportKind: "number", exportValue: (d) => d.papers_prev, cell: (d) => d.papers_prev || null },
    {
      key: "change",
      header: "Change",
      align: "right",
      exportValue: (d) => pctChange(d),
      cell: (d) => <span className={cn(d.change != null && d.change < 0 && "text-critical")}>{pctChange(d)}</span>,
    },
    {
      key: "per",
      header: "Per teacher",
      align: "right",
      exportKind: "number",
      exportValue: (d) => d.per_teacher,
      cell: (d) =>
        d.teachers ? (
          <span className={cn(d.teachers >= 3 && college > 0 && (d.per_teacher ?? 0) < college / 2 && "text-caution")}>{n(d.per_teacher)}</span>
        ) : (
          "No teachers on the roll"
        ),
    },
    {
      key: "five",
      header: "Five years, per teacher",
      align: "right",
      empty: "None",
      defaultHidden: true,
      exportKind: "number",
      exportValue: (d) => (d.teachers ? d.five_year_per_teacher : null),
      cell: (d) => (d.teachers ? d.five_year_per_teacher : null),
    },
    {
      key: "paid",
      header: `Paid, FY ${b?.financial_year ?? ""}`,
      label: "Paid",
      align: "right",
      exportKind: "money",
      exportValue: (d) => d.paid,
      cell: (d) => rupees(d.paid),
    },
    ...(anyBudget
      ? [
          {
            key: "budget",
            header: "Budget",
            align: "right" as const,
            empty: "Not set",
            exportKind: "money" as const,
            exportValue: (d: Dept) => d.budget,
            cell: (d: Dept) => (d.budget == null ? null : rupees(d.budget)),
          },
        ]
      : []),
  ]

  const filtered = Boolean(q || show)

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Departments"
        sub={
          b
            ? b.push.length === 0
              ? `No department is behind in ${b.year}.`
              : `${b.push.length} ${b.push.length === 1 ? "department needs" : "departments need"} a push in ${b.year}. Papers are counted per teacher, so a large department does not win by size.`
            : "How each department is publishing, and which ones need a push."
        }
        action={
          <Button kind="primary" asChild className="print:hidden">
            <a href={`/api/reports/brief/export?fmt=xlsx${b ? `&year=${b.year}` : ""}`} download>
              <Download />
              Download as Excel
            </a>
          </Button>
        }
      />

      {brief.isError ? (
        <ErrorState title="The departments could not be loaded" message="Try again in a moment." onRetry={() => brief.refetch()} />
      ) : !b ? (
        <SkeletonRows rows={8} />
      ) : (
        <>
          <Answer
            items={[
              { value: b.departments.length, label: "Departments" },
              {
                value: b.push.length,
                label: "Need a push",
                zero: "None need a push",
                tone: b.push.length ? "caution" : "neutral",
                to: "/reports/departments?show=push" + (year ? `&year=${year}` : ""),
              },
              {
                value: b.rising.length,
                label: "Rising",
                zero: "None rising",
                to: "/reports/departments?show=rising" + (year ? `&year=${year}` : ""),
              },
              { value: b.totals.papers, label: `Papers in ${b.year}`, to: papersUrl({ year: b.year }) },
            ]}
          />

          <div className={filterBar} role="search">
            <label className="relative sm:w-72">
              <span className="sr-only">Search departments</span>
              <Search aria-hidden className="pointer-events-none absolute top-3 left-2.5 size-4 text-fg-subtle" />
              <Input value={q} onChange={(e) => set("q", e.target.value)} placeholder="Search a department" className="pl-8" />
            </label>
            <YearPick years={b.years_available} value={b.year} onChange={(v) => set("year", v)} />
            <Select aria-label="Show" value={show} onChange={(e) => set("show", e.target.value)}>
              <option value="">All departments</option>
              <option value="push">Need a push</option>
              <option value="rising">Rising</option>
            </Select>
            {filtered && (
              <Button kind="quiet" onClick={() => setParams(year ? { year } : {})}>
                Clear
              </Button>
            )}
          </div>

          <Table
            rows={rows}
            columns={columns}
            getKey={(d) => d.department}
            maxHeight="none"
            caption={`Departments in ${b.year}, with ${b.year - 1} for comparison`}
            tools={{ id: "departments", title: `Departments, ${b.year}` }}
            empty={{
              art: "no-results",
              title: "No department matches",
              message: "Clear the search or choose all departments.",
              action: (
                <Button kind="default" onClick={() => setParams(year ? { year } : {})}>
                  Clear filters
                </Button>
              ),
            }}
          />

          <div className="space-y-2 text-sm text-fg-muted">
            <p>
              Needs a push means three teachers or more, and either no papers, a fall of a fifth or more from five papers, or under
              half the college&apos;s {n(b.totals.per_teacher)} per teacher.
            </p>
            {b.unassigned_papers > 0 && (
              <p>
                <Link
                  to={papersUrl({ year: b.year, department: "Department not recorded" })}
                  className="text-accent underline-offset-4 hover:underline"
                >
                  {n(b.unassigned_papers)} papers of {b.year}
                </Link>{" "}
                carry no department, so no row above holds them.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

type Person = {
  user_id: string
  name: string
  designation: string
  head: boolean
  papers: number
  papers_prev: number
  five_year: number
  photo_url?: string | null
  initials?: string
}

type DeptDetail = {
  department: string
  year: number
  financial_year: string
  partial: boolean
  row: Brief["departments"][number]
  rank: number | null
  of: number
  college: { per_teacher: number | null; papers: number; top_quartile_share: number | null }
  trend: { year: number; papers: number; per_teacher: number | null }[]
  running?: { year: number; papers: number; per_teacher: number | null } | null
  people: Person[]
  silent: number
  journals: { journal: string; papers: number }[]
  quartiles: Record<string, number>
  years_available: number[]
}

function columns(d: DeptDetail, measure: "papers" | "per_teacher"): YearColumn[] {
  const cols: YearColumn[] = d.trend.map((t) => {
    const v = measure === "papers" ? t.papers : t.per_teacher
    return { year: t.year, value: v, label: v == null ? "None" : n(v) }
  })
  if (d.running && !d.partial) {
    const v = measure === "papers" ? d.running.papers : d.running.per_teacher
    cols.push({ year: d.running.year, value: v, label: v == null ? "None" : n(v), running: true })
  }
  if (d.partial && cols.length) cols[cols.length - 1] = { ...cols[cols.length - 1], running: true }
  return cols
}

/** The person to call, as a face, a name and one button that writes to them. */
function HeadOf({ head, email }: { head: Head; email?: string | null }) {
  if (!head) return <p className="text-base text-fg-muted">No head of department is set.</p>
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Avatar size="md" person={{ name: head.name, initials: head.initials ?? initialsOf(head.name), photo_url: head.photo_url ?? null }} />
      <div className="min-w-0">
        <Link to={`/faculty/${head.user_id}`} className="block truncate text-base font-medium underline-offset-4 hover:underline">
          {head.name}
        </Link>
        <Meta className="block">Head of department</Meta>
      </div>
      {email && (
        <Button kind="default" size="sm" asChild className="print:hidden">
          <a href={`mailto:${email}`}>
            <Mail />
            Email
          </a>
        </Button>
      )}
    </div>
  )
}

export function DepartmentPage() {
  const { name = "" } = useParams()
  const [params, setParams] = useSearchParams()
  const year = params.get("year") ?? ""
  const dept = decodeURIComponent(name)
  const q = useApi<DeptDetail>(
    ["reports-department", dept, year],
    `/api/reports/department?name=${encodeURIComponent(dept)}${year ? `&year=${year}` : ""}`
  )
  const d = q.data
  const r = d?.row
  useCrumbLabel(dept)

  const peopleColumns: Column<Person>[] = d
    ? [
        {
          key: "name",
          header: "Teacher",
          exportValue: (p) => p.name,
          cell: (p) => (
            <span className="flex items-center gap-3">
              <Avatar size="md" person={{ name: p.name, initials: p.initials ?? initialsOf(p.name), photo_url: p.photo_url ?? null }} />
              <span className="min-w-0">
                <Link to={`/faculty/${p.user_id}`} className="block text-base font-medium hover:text-accent">
                  {p.name}
                </Link>
                {p.five_year === 0 && <span className="block text-sm text-fg-muted">No paper in five years</span>}
              </span>
            </span>
          ),
        },
        {
          key: "role",
          header: "Role",
          empty: "Teacher",
          exportValue: (p) => [p.head ? "Head of department" : "", p.designation].filter(Boolean).join(", ") || "Teacher",
          cell: (p) => [p.head ? "Head of department" : "", p.designation].filter(Boolean).join(", ") || null,
        },
        { key: "papers", header: `Papers ${d.year}`, align: "right", exportKind: "number", exportValue: (p) => p.papers, cell: (p) => p.papers },
        { key: "prev", header: String(d.year - 1), align: "right", exportKind: "number", exportValue: (p) => p.papers_prev, cell: (p) => p.papers_prev },
        { key: "five", header: "Five years", align: "right", exportKind: "number", exportValue: (p) => p.five_year, cell: (p) => p.five_year },
      ]
    : []

  const journalColumns: Column<{ journal: string; papers: number }>[] = [
    { key: "journal", header: "Journal", exportValue: (j) => j.journal, cell: (j) => j.journal },
    { key: "papers", header: "Papers", align: "right", exportKind: "number", exportValue: (j) => j.papers, cell: (j) => j.papers },
  ]

  return (
    <div className="page space-y-6">
      <PageHeader
        title={dept}
        sub={
          d && r
            ? `${n(r.papers)} ${r.papers === 1 ? "paper" : "papers"} in ${d.year}${
                r.change != null && !d.partial
                  ? `, ${r.change > 0 ? "up" : r.change < 0 ? "down" : "level"}${r.change === 0 ? "" : ` ${Math.abs(r.change)}%`} on ${d.year - 1}`
                  : ""
              }. ${
                r.teachers
                  ? `${n(r.per_teacher)} per teacher, against ${n(d.college.per_teacher)} for the college${d.rank ? `, ranked ${d.rank} of ${d.of}` : ""}.`
                  : "No teachers are on the roll."
              }${d.silent > 0 ? ` ${d.silent} of ${r.teachers} teachers ${d.silent === 1 ? "has" : "have"} no paper on record in five years.` : ""}`
            : "One department, its people and where they publish."
        }
        action={
          <Button kind="primary" asChild className="print:hidden">
            <a href={`/api/reports/papers/export?year=${d?.year ?? ""}&department=${encodeURIComponent(dept)}`} download>
              <Download />
              Download the papers of {d?.year ?? "the year"}
            </a>
          </Button>
        }
      />

      {q.isError ? (
        <ErrorState
          title="This department could not be loaded"
          message="It may not be on the roll or in the record. Go back to the list of departments."
          onRetry={() => q.refetch()}
        />
      ) : !d || !r ? (
        <div className="space-y-6">
          <Skeleton className="h-28 w-full" />
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <>
          <Answer
            items={[
              { value: r.papers, label: `Papers in ${d.year}, ${change(r.papers, r.papers_prev)}`, to: papersUrl({ year: d.year, department: dept }) },
              {
                value: r.teachers ? n(r.per_teacher) : "No teachers",
                label: `Papers per teacher, the college has ${n(d.college.per_teacher)}`,
                to: "#people",
              },
              {
                value: (d.quartiles.Q1 ?? 0) + (d.quartiles.Q2 ?? 0),
                label: `In Q1 or Q2 journals, quartile not recorded for ${n(d.quartiles.none ?? 0)}`,
                to: papersUrl({ year: d.year, department: dept, quartile: "top" }),
              },
              {
                value: rupees(r.paid),
                label: `Paid, FY ${d.financial_year}, ${r.budget != null ? `of a ${rupees(r.budget)} budget` : "no department budget is set"}`,
                to: "/budget",
              },
            ]}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <HeadOf head={r.head ?? null} email={r.head?.email} />
            <YearPick years={d.years_available} value={d.year} onChange={(v) => setParams(v ? { year: v } : {})} />
          </div>

          <Section title="Five years">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-2">
              <FiveYears title="Papers published" columns={columns(d, "papers")} current={d.year} />
              <FiveYears title="Papers per teacher" columns={columns(d, "per_teacher")} current={d.year} />
            </div>
            {d.running && !d.partial && (
              <p className="mt-3 text-sm text-fg-muted">{d.running.year} is to date, drawn hollow, and not compared with a whole year.</p>
            )}
          </Section>

          <Section id="people" title="Who is publishing" className="scroll-mt-6">
            <Table
              rows={d.people}
              columns={peopleColumns}
              getKey={(p) => p.user_id}
              maxHeight="none"
              caption={`Teachers of ${dept}`}
              tools={{ id: "department-people", title: `${dept}, who is publishing`, subtitle: String(d.year) }}
              empty={{ art: "no-results", title: "No teachers", message: "No teacher of this department is on the roll." }}
            />
          </Section>

          {d.journals.length > 0 && (
            <Details count={d.journals.length} label={`journals the ${d.year} papers appeared in`}>
              <div className="pt-2">
                <Table
                  rows={d.journals}
                  columns={journalColumns}
                  getKey={(j) => j.journal}
                  maxHeight="none"
                  caption={`Journals of ${dept} in ${d.year}`}
                  tools={{ id: "department-journals", title: `${dept}, journals`, subtitle: String(d.year) }}
                />
              </div>
            </Details>
          )}
        </>
      )}
    </div>
  )
}
