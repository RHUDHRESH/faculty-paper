import { Link, useParams, useSearchParams } from "react-router-dom"
import { Download } from "lucide-react"

import { useCrumbLabel } from "@/app/crumbs"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import { PageHeader } from "@/ui/page-header"
import { Avatar, initialsOf } from "@/ui/person"
import { Rows, Section } from "@/ui/section"
import { ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, Sub } from "@/ui/text"
import { PrintButton, PrintStamp } from "@/pages/reports-print"
import {
  type Brief,
  change,
  DeptTable,
  Lead,
  n,
  papersUrl,
  PushList,
  RisingList,
  rupees,
  tone,
} from "@/pages/principal-parts"
import { YearBars } from "@/pages/year-bars"

/**
 * Departments, as the Principal reads them (docs/jtbd/principal.md, Q2).
 *
 * `/department` is a head of department's own view of their own department.
 * She does not have one; she has all of them, and her question is "which
 * departments need a push?" -- per teacher, so a large department does not
 * win by size. `Departments` is that list; `DepartmentPage` is one department
 * opened: how it compares with the college, its five years, its people and
 * where they publish. The figures come from the year brief's own service.
 */

function YearPick({ years, value, onChange }: { years: number[]; value: number | null; onChange: (v: string) => void }) {
  return (
    <div className="w-36">
      <ColumnLabel className="mb-1 block">Year</ColumnLabel>
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
      <PrintStamp title="Departments, papers per teacher" scope={b ? String(b.year) : ""} />
      <PageHeader
        title="Departments"
        sub="Which departments carry the research and which need a push. Papers per teacher, so size does not decide."
        action={<PrintButton />}
      />
      <div className="-mt-6 print:hidden">
        <YearPick
          years={b?.years_available ?? []}
          value={b?.year ?? null}
          onChange={(v) => setParams(v ? { year: v } : {})}
        />
      </div>

      {q.isError ? (
        <ErrorState title="The departments could not be loaded" message="Try again in a moment." onRetry={() => q.refetch()} />
      ) : !b ? (
        <SkeletonRows rows={8} />
      ) : (
        <>
          <Lead>
            {b.push.length === 0
              ? `No department stands out as behind in ${b.year}.`
              : `${b.push.length} ${b.push.length === 1 ? "department needs" : "departments need"} a push in ${b.year}: ${b.push
                  .slice(0, 3)
                  .map((d) => d.department)
                  .join(", ")}${b.push.length > 3 ? " and others" : ""}.`}
          </Lead>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
            <Section
              title="Needs a push"
              sub={`Three teachers or more, and either no papers, a fall of a fifth or more, or under half the college's ${n(b.totals.per_teacher)} per teacher.`}
            >
              <PushList rows={b.push} year={b.year} empty="No department is behind on papers per teacher or on change since last year." />
            </Section>
            <Section title="Rising" sub={`The biggest gain on ${b.year - 1}, from five papers or more.`}>
              <RisingList rows={b.rising} year={b.year} />
            </Section>
          </div>

          <Section title="Every department">
            <DeptTable b={b} />
            {b.unassigned_papers > 0 && (
              <Sub className="mt-2 text-sm">
                <Link
                  to={papersUrl({ year: b.year, department: "Department not recorded" })}
                  className="text-accent underline-offset-4 hover:underline"
                >
                  {n(b.unassigned_papers)} papers of {b.year}
                </Link>{" "}
                carry no department, so no row above holds them.
              </Sub>
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
  people: Person[]
  silent: number
  journals: { journal: string; papers: number }[]
  quartiles: Record<string, number>
  years_available: number[]
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
      <PrintStamp title={`${dept} department`} scope={d ? String(d.year) : ""} />
      <PageHeader
        title={dept}
        sub={
          d && r
            ? `${n(r.teachers)} teachers on today's roll.${d.rank ? ` Ranked ${d.rank} of ${d.of} on papers per teacher in ${d.year}.` : ""}`
            : "How this department compares with the college, and who is publishing."
        }
        action={
          <Button asChild className="print:hidden">
            <a href={`/api/reports/papers/export?year=${d?.year ?? ""}&department=${encodeURIComponent(dept)}`} download>
              <Download />
              Download the papers of {d?.year ?? "the year"}
            </a>
          </Button>
        }
      />
      <div className="-mt-6 flex flex-wrap items-end gap-3 print:hidden">
        <YearPick years={d?.years_available ?? []} value={d?.year ?? null} onChange={(v) => setParams(v ? { year: v } : {})} />
        <PrintButton />
      </div>

      {q.isError ? (
        <ErrorState
          title="This department could not be loaded"
          message="It may not be on the roll or in the record. Go back to the list of departments."
          onRetry={() => q.refetch()}
        />
      ) : !d || !r ? (
        <div className="space-y-6">
          <Skeleton className="h-16 w-full max-w-3xl" />
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <>
          <Lead>
            {dept} published {n(r.papers)} {r.papers === 1 ? "paper" : "papers"} in {d.year}
            {r.change != null && !d.partial
              ? `, ${r.change > 0 ? "up" : r.change < 0 ? "down" : "level"}${r.change === 0 ? "" : ` ${Math.abs(r.change)}%`} on ${d.year - 1}`
              : ""}
            {r.teachers ? `: ${n(r.per_teacher)} per teacher, against ${n(d.college.per_teacher)} for the college` : ""}.
            {d.silent > 0
              ? ` ${d.silent} of ${r.teachers} teachers ${d.silent === 1 ? "has" : "have"} no paper on record in five years.`
              : ""}
          </Lead>

          <Answer
            items={[
              {
                value: r.papers,
                label: `papers in ${d.year}, ${change(r.papers, r.papers_prev)}`,
                zero: `No papers in ${d.year}`,
                to: papersUrl({ year: d.year, department: dept }),
                tone: d.partial ? "neutral" : tone(r.papers, r.papers_prev),
              },
              {
                value: r.teachers ? n(r.per_teacher) : "No teachers",
                label: `papers per teacher; the college has ${n(d.college.per_teacher)}`,
                to: "#people",
              },
              {
                value: (d.quartiles.Q1 ?? 0) + (d.quartiles.Q2 ?? 0),
                label: `papers in Q1 or Q2 journals; quartile not recorded for ${n(d.quartiles.none ?? 0)}`,
                zero: "None in Q1 or Q2 journals",
                to: papersUrl({ year: d.year, department: dept, quartile: "top" }),
              },
              {
                value: rupees(r.paid),
                label: `paid in FY ${d.financial_year}${r.budget != null ? `, of a ${rupees(r.budget)} budget` : "; no department budget is set"}`,
                to: "/budget",
              },
            ]}
          />

          <Section title="Five years">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-2">
              <YearBars
                title="Papers published"
                rows={d.trend}
                value={(t) => t.papers}
                label={(t) => n(t.papers)}
                axis={(t) => String(t.year)}
                highlight={d.year}
              />
              <YearBars
                title="Papers per teacher"
                rows={d.trend}
                value={(t) => t.per_teacher ?? 0}
                label={(t) => (t.per_teacher == null ? "None" : n(t.per_teacher))}
                axis={(t) => String(t.year)}
                highlight={d.year}
              />
            </div>
          </Section>

          <Section
            id="people"
            title="Who is publishing"
            sub="Papers matched to each person on the publication record. A paper with two authors here counts for each."
            className="scroll-mt-6"
          >
            {d.people.length === 0 ? (
              <p className="text-base text-fg-muted">No teacher of this department is on the roll.</p>
            ) : (
              <Rows>
                {d.people.map((p) => (
                  <li key={p.user_id} className="row flex items-center gap-3 px-1 py-2.5 sm:px-2">
                    <Avatar
                      size="md"
                      person={{ name: p.name, initials: p.initials ?? initialsOf(p.name), photo_url: p.photo_url ?? null }}
                    />
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
            <Section title={`Where the ${d.year} papers were published`}>
              <Rows>
                {d.journals.map((j) => (
                  <li key={j.journal} className="flex items-baseline justify-between gap-3 px-1 py-2 sm:px-2">
                    <span className="min-w-0 truncate text-base">{j.journal}</span>
                    <span className="shrink-0 text-sm tabular text-fg-muted">
                      {j.papers} {j.papers === 1 ? "paper" : "papers"}
                    </span>
                  </li>
                ))}
              </Rows>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
