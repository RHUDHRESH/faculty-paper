import { Link, useParams, useSearchParams } from "react-router-dom"
import { Download, Mail } from "lucide-react"

import { useCrumbLabel } from "@/app/crumbs"
import { useApi } from "@/lib/query"
import { AnswerLine, AnswerWord } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import { PageHeader } from "@/ui/page-header"
import { Avatar, initialsOf } from "@/ui/person"
import { Details, Rows, Section } from "@/ui/section"
import { ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { PrintButton } from "@/pages/reports-print"
import {
  type Brief,
  change,
  DeptTable,
  type Head,
  n,
  NoHeads,
  papersUrl,
  PushList,
  RisingList,
  rupees,
} from "@/pages/principal-parts"
import { FiveYears, type YearColumn } from "@/pages/principal/five-years"

/**
 * Departments, as the Principal reads them (docs/jtbd/principal.md, Q2).
 *
 * `/department` is a head of department's own view of their own department.
 * She does not have one; she has all of them, and her question is "which
 * departments need a push?" -- per teacher, so a large department does not
 * win by size. `Departments` is that list; `DepartmentPage` is one department
 * opened: its head, how it compares with the college, its five years, its
 * people and where they publish. The figures come from the year brief's own
 * service. The rules behind "needs a push" are one step away, not on the page.
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

export function Departments() {
  const [params, setParams] = useSearchParams()
  const year = params.get("year") ?? ""
  const q = useApi<Brief>(["reports-brief", year], `/api/reports/brief${year ? `?year=${year}` : ""}`)
  const b = q.data

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Departments"
        action={
          <>
            <Button kind="primary" asChild className="print:hidden">
              <a href={`/api/reports/brief/export?fmt=xlsx${b ? `&year=${b.year}` : ""}`} download>
                <Download />
                Download as Excel
              </a>
            </Button>
            <PrintButton />
          </>
        }
      />
      <div className="-mt-6">
        <YearPick years={b?.years_available ?? []} value={b?.year ?? null} onChange={(v) => setParams(v ? { year: v } : {})} />
      </div>

      {q.isError ? (
        <ErrorState title="The departments could not be loaded" message="Try again in a moment." onRetry={() => q.refetch()} />
      ) : !b ? (
        <SkeletonRows rows={8} />
      ) : (
        <>
          <AnswerLine>
            {b.push.length === 0 ? (
              <>
                No department is <AnswerWord tone="sage">behind</AnswerWord> in {b.year}.
              </>
            ) : (
              <>
                {b.push.length} {b.push.length === 1 ? "department needs" : "departments need"} a push in {b.year}:{" "}
                {b.push
                  .slice(0, 3)
                  .map((d) => d.department)
                  .join(", ")}
                {b.push.length > 3 ? " and others" : ""}.
              </>
            )}
          </AnswerLine>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
            <Section title="Needs a push">
              <PushList rows={b.push} year={b.year} empty="No department is behind on papers per teacher or on change since last year." />
              <NoHeads depts={b.push} />
              <Details label="why these" className="mt-3">
                <p className="max-w-prose pt-2 text-sm text-fg-muted">
                  Three teachers or more, and either no papers, a fall of a fifth or more from five papers, or under half the
                  college&apos;s {n(b.totals.per_teacher)} per teacher.
                </p>
              </Details>
            </Section>
            <Section title="Rising">
              <RisingList rows={b.rising} year={b.year} />
              <NoHeads depts={b.rising} />
            </Section>
          </div>

          <Section title="Every department">
            <DeptTable b={b} />
            {b.unassigned_papers > 0 && (
              <p className="mt-3 text-sm text-fg-muted">
                <Link
                  to={papersUrl({ year: b.year, department: "Department not recorded" })}
                  className="text-accent underline-offset-4 hover:underline"
                >
                  {n(b.unassigned_papers)} papers of {b.year}
                </Link>{" "}
                carry no department, so no row above holds them.
              </p>
            )}
          </Section>
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
  if (!head) return <p className="text-sm text-fg-muted">No head of department is set.</p>
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

  return (
    <div className="page space-y-10">
      <PageHeader
        title={dept}
        action={
          <>
            <Button kind="primary" asChild className="print:hidden">
              <a href={`/api/reports/papers/export?year=${d?.year ?? ""}&department=${encodeURIComponent(dept)}`} download>
                <Download />
                Download the papers of {d?.year ?? "the year"}
              </a>
            </Button>
            <PrintButton />
          </>
        }
      />
      <div className="-mt-6">
        <YearPick years={d?.years_available ?? []} value={d?.year ?? null} onChange={(v) => setParams(v ? { year: v } : {})} />
      </div>

      {q.isError ? (
        <ErrorState
          title="This department could not be loaded"
          message="It may not be on the roll or in the record. Go back to the list of departments."
          onRetry={() => q.refetch()}
        />
      ) : !d || !r ? (
        <div className="space-y-6">
          <Skeleton className="h-28 w-full max-w-3xl" />
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <>
          <div className="space-y-4">
            <AnswerLine className="max-w-[26ch] sm:max-w-[30ch]">
              {dept} published {n(r.papers)} {r.papers === 1 ? "paper" : "papers"} in {d.year}
              {r.change != null && !d.partial
                ? `, ${r.change > 0 ? "up" : r.change < 0 ? "down" : "level"}${r.change === 0 ? "" : ` ${Math.abs(r.change)}%`} on ${d.year - 1}`
                : ""}
              .
            </AnswerLine>
            <p className="max-w-[40rem] text-lead text-fg-muted">
              {r.teachers
                ? `${n(r.per_teacher)} per teacher, against ${n(d.college.per_teacher)} for the college${d.rank ? `, ranked ${d.rank} of ${d.of}` : ""}.`
                : "No teachers are on the roll."}
              {d.silent > 0
                ? ` ${d.silent} of ${r.teachers} teachers ${d.silent === 1 ? "has" : "have"} no paper on record in five years.`
                : ""}
            </p>
          </div>

          <HeadOf head={r.head ?? null} email={r.head?.email} />

          <Section title="The figures, each opening its list">
            <Rows className="max-w-xl">
              {[
                { label: `Papers in ${d.year}`, value: n(r.papers), note: change(r.papers, r.papers_prev), to: papersUrl({ year: d.year, department: dept }) },
                { label: "Papers per teacher", value: r.teachers ? n(r.per_teacher) : "No teachers", note: `the college has ${n(d.college.per_teacher)}`, to: "#people" },
                {
                  label: "In Q1 or Q2 journals",
                  value: String((d.quartiles.Q1 ?? 0) + (d.quartiles.Q2 ?? 0)),
                  note: `quartile not recorded for ${n(d.quartiles.none ?? 0)}`,
                  to: papersUrl({ year: d.year, department: dept, quartile: "top" }),
                },
                { label: `Paid, FY ${d.financial_year}`, value: rupees(r.paid), note: r.budget != null ? `of a ${rupees(r.budget)} budget` : "no department budget is set", to: "/budget" },
              ].map((x) => (
                <li key={x.label}>
                  <Link to={x.to} className="row flex items-baseline justify-between gap-4 px-1 py-2.5 sm:px-2">
                    <span className="min-w-0">
                      <span className="block text-base">{x.label}</span>
                      <span className="block text-sm text-fg-muted">{x.note}</span>
                    </span>
                    <span className="tabular text-base font-medium">{x.value}</span>
                  </Link>
                </li>
              ))}
            </Rows>
          </Section>

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
            {d.people.length === 0 ? (
              <p className="text-base text-fg-muted">No teacher of this department is on the roll.</p>
            ) : (
              <Rows>
                {d.people.map((p) => (
                  <li key={p.user_id} className="row flex items-center gap-3 px-1 py-2.5 sm:px-2">
                    <Avatar size="md" person={{ name: p.name, initials: p.initials ?? initialsOf(p.name), photo_url: p.photo_url ?? null }} />
                    <span className="min-w-0 flex-1">
                      <Link to={`/faculty/${p.user_id}`} className="block truncate text-base font-medium underline-offset-4 hover:underline">
                        {p.name}
                      </Link>
                      <Meta className="block truncate">
                        {p.five_year === 0
                          ? "No paper in five years"
                          : [p.head ? "Head of department" : "", p.designation].filter(Boolean).join(" · ") || "Teacher"}
                      </Meta>
                    </span>
                    <dl className="flex shrink-0 gap-4 text-right text-sm tabular sm:gap-6">
                      <div>
                        <dt className="text-fg-muted">{d.year}</dt>
                        <dd className="font-medium">{p.papers}</dd>
                      </div>
                      <div>
                        <dt className="text-fg-muted">{d.year - 1}</dt>
                        <dd>{p.papers_prev}</dd>
                      </div>
                      <div className="max-sm:hidden">
                        <dt className="text-fg-muted">Five years</dt>
                        <dd>{p.five_year}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </Rows>
            )}
          </Section>

          {d.journals.length > 0 && (
            <Details count={d.journals.length} label={`journals the ${d.year} papers appeared in`}>
              <Rows className="pt-2">
                {d.journals.map((j) => (
                  <li key={j.journal} className="flex items-baseline justify-between gap-3 px-1 py-2 sm:px-2">
                    <span className="min-w-0 truncate text-base">{j.journal}</span>
                    <span className="shrink-0 text-sm tabular text-fg-muted">
                      {j.papers} {j.papers === 1 ? "paper" : "papers"}
                    </span>
                  </li>
                ))}
              </Rows>
            </Details>
          )}
        </>
      )}
    </div>
  )
}
