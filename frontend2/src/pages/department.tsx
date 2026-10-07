import { useMemo, useState } from "react"
import { Link, Navigate, useSearchParams } from "react-router-dom"
import { BellRing, Download, Pencil, Plus, Target as TargetIcon, Trash2, UserPlus, X } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { useApi, useApiMutation } from "@/lib/query"
import {
  KindBadge,
  STATUSES,
  StatusSelect,
  type Assignment,
  type AssignmentKind,
  type AssignmentStatus,
} from "@/pages/assignment-parts"
import {
  face,
  groupDraft,
  leadSentence,
  months,
  n,
  papersLink,
  PushEmpty,
  PushRows,
  RemindDialog,
  SILENT_KINDS,
  TargetPace,
  useBrief,
  type Brief,
  type BriefPerson,
  type Reminder,
} from "@/pages/hod-parts"
import { Lead } from "@/pages/principal-parts"
import { YearBars } from "@/pages/year-bars"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { DateInput, Field, Input, NumberInput, Radio, Textarea } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { AskTheData } from "@/pages/insights-link"
import { Avatar } from "@/ui/person"
import { Details, Rows, Section } from "@/ui/section"
import { Delayed, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { ColumnLabel, Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Due, When } from "@/ui/when"

/**
 * A head of department's own screen (docs/jtbd/hod.md): is the department on
 * track, who needs a push, and what do I tell the Principal. Four tabs keep the
 * page to one question at a time instead of one very long page:
 *
 *   On track          pace against the calendar, papers per year, who needs a push
 *   Faculty           every teacher's papers this year and last, and their target
 *   Targets and work  the vision, the targets, and the work handed out
 *   Records to fix    what an assessor would send back, with names
 *
 * Every figure is a count of papers from the college's publication record, the
 * record the Principal's pages read, so the two never disagree. Two rules, both
 * enforced on the server: no money anywhere, and no other department named.
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

type Target = {
  id: string
  year: number
  metric: string
  metric_label: string
  target: number
  done: number
  remaining: number
  fraction: number | null
  met: boolean
  person_id: string | null
  person_name: string | null
  note: string | null
  /** When it should be reached by; null means within the year. */
  due_date: string | null
  set_by: string | null
}

type TargetsPayload = {
  department: string
  year: number
  department_targets: Target[]
  personal_targets: Target[]
  metrics: { key: string; label: string }[]
  years: number[]
}

type Person = { id: string; name: string; designation?: string | null; staff_id?: string | null }

type Plan = {
  department: string
  vision: string
  research_areas: string[]
  updated_by: string | null
  updated_at: string | null
}

type Records = {
  department: string
  years: number[]
  papers_checked: number
  papers: { id: string; title: string; journal: string; year: number | null; authors: string[]; missing: string[] }[]
  no_scopus_id: { id: string; name: string; designation: string | null; photo_url: string | null }[]
}

const TABS = [
  { key: "pace", label: "On track" },
  { key: "faculty", label: "Faculty" },
  { key: "plan", label: "Targets and work" },
  { key: "records", label: "Records to fix" },
] as const
type TabKey = (typeof TABS)[number]["key"]

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Department() {
  const { me } = useAuth()
  const isHod = can(me?.role).seeDepartment

  const [params, setParams] = useSearchParams()
  const thisYear = new Date().getFullYear()
  const year = Number(params.get("year")) || thisYear
  const tabParam = params.get("tab") as TabKey | null
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : "pace"

  const [editing, setEditing] = useState<{ target: Target | null; person: Person | null } | null>(null)
  const [editingPlan, setEditingPlan] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [reminding, setReminding] = useState<Reminder | null>(null)

  const brief = useBrief(year)
  const targets = useApi<TargetsPayload>(["hod", "targets", year], `/api/hod/targets?year=${year}`, { enabled: isHod })
  const plan = useApi<Plan>(["hod", "plan"], "/api/hod/plan", { enabled: isHod && tab === "plan" })
  const assignments = useApi<Assignment[]>(["hod", "assignments"], "/api/hod/assignments", {
    enabled: isHod && tab === "plan",
  })
  const records = useApi<Records>(["hod", "records", year], `/api/hod/department/records?year=${year}`, {
    enabled: isHod && tab === "records",
  })

  // The Principal has every department, not one: the list of them is her page.
  if (!isHod && me?.role === "PRINCIPAL") return <Navigate to="/reports/departments" replace />
  if (!isHod) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="This is a head of department's own view of their department. Everybody else has the college-wide reports."
          onRetry={false}
        />
      </div>
    )
  }

  const b = brief.data
  const people: Person[] = (b?.people ?? []).map((p) => ({ id: p.id, name: p.name, designation: p.designation }))
  const setTab = (t: TabKey) => {
    const next = new URLSearchParams(params)
    if (t === "pace") next.delete("tab")
    else next.set("tab", t)
    setParams(next, { replace: true })
  }
  const setYear = (v: string) => {
    const next = new URLSearchParams(params)
    if (Number(v) === thisYear) next.delete("year")
    else next.set("year", v)
    setParams(next, { replace: true })
  }
  const yearOptions: ComboboxOption[] = Array.from(new Set([thisYear, ...(b?.years ?? [])]))
    .sort((a, c) => c - a)
    .map((y) => ({ value: String(y), label: String(y) }))

  const noDepartment = brief.error?.status === 400 || brief.error?.status === 403
  const silent = b ? b.push.filter((r) => SILENT_KINDS.includes(r.kind)) : []

  return (
    <div className="page space-y-8">
      <PageHeader
        title={b?.department ?? "Department"}
        sub="Is the department on track, who needs a push, and what to tell the Principal."
        action={
          <Button kind="primary" asChild>
            <a href={`/api/hod/report?fmt=pdf&year=${year}`} download>
              <Download />
              Download the note for the Principal
            </a>
          </Button>
        }
      />

      {brief.isError ? (
        <ErrorState
          what="the department"
          message={
            noDepartment
              ? "This account has no department set, so there is nothing to show. Ask the research office to set it."
              : "The server did not answer."
          }
          onRetry={noDepartment ? false : () => void brief.refetch()}
        />
      ) : !b ? (
        <Delayed>
          <SkeletonRows rows={6} rowHeight={48} />
        </Delayed>
      ) : (
        <>
          <div className="w-32 print:hidden">
            <ColumnLabel className="mb-1 block">Year</ColumnLabel>
            <Combobox aria-label="Year" value={String(year)} onChange={setYear} options={yearOptions} />
          </div>

          <Lead>{leadSentence(b)}</Lead>

          <Answer
            items={[
              {
                value: b.totals.publications,
                label: `papers in ${year}`,
                zero: `No papers on record for ${year}`,
                to: papersLink({ year }),
              },
              {
                value: `${n(b.totals.faculty_published)} of ${n(b.totals.faculty)}`,
                label: `faculty have a paper in ${year}`,
                to: "?tab=faculty",
              },
              {
                value: silent.length,
                label: `have no paper in ${year}`,
                zero: `Everyone has a paper in ${year}`,
                to: "#push",
                tone: silent.length ? "caution" : "neutral",
              },
              {
                value: b.totals.per_teacher,
                label: b.college?.per_teacher != null ? `papers per teacher; the college has ${b.college.per_teacher}` : "papers per teacher",
              },
            ]}
          />

          <AskTheData about={`A question about ${b.department} this page does not answer? Ask it in plain English.`} />

          <nav aria-label="Department views" className="-mx-1 flex flex-wrap gap-1 border-b border-line print:hidden">
            {TABS.map((t) => {
              const count =
                t.key === "faculty" ? b.totals.faculty : t.key === "records" ? b.totals.missing_issn_or_doi + b.totals.without_scopus_id : null
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-current={tab === t.key ? "page" : undefined}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "-mb-px min-h-10 rounded-t-control border-b-2 px-3 text-sm font-medium",
                    tab === t.key ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"
                  )}
                >
                  {t.label}
                  {count ? <span className="tabular ml-1.5 text-fg-subtle">({n(count)})</span> : null}
                </button>
              )
            })}
          </nav>

          {tab === "pace" && <PaceTab b={b} year={year} onRemind={setReminding} onSetTarget={() => setTab("plan")} />}
          {tab === "faculty" && (
            <FacultyTab
              b={b}
              targets={targets.data}
              onSetTarget={(p) => setEditing({ target: null, person: { id: p.id, name: p.name, designation: p.designation } })}
            />
          )}
          {tab === "plan" && (
            <div className="space-y-10">
              <TargetsSection
                data={targets.data}
                loading={targets.isLoading}
                failed={targets.isError}
                onRetry={() => void targets.refetch()}
                year={year}
                onAdd={() => setEditing({ target: null, person: null })}
                onEdit={(t) => setEditing({ target: t, person: null })}
              />
              <AssignmentsSection
                data={assignments.data}
                loading={assignments.isLoading}
                failed={assignments.isError}
                onRetry={() => void assignments.refetch()}
                onAssign={() => setAssigning(true)}
              />
              <VisionSection
                plan={plan.data}
                loading={plan.isLoading}
                failed={plan.isError}
                onRetry={() => void plan.refetch()}
                onEdit={() => setEditingPlan(true)}
              />
            </div>
          )}
          {tab === "records" && (
            <RecordsTab
              b={b}
              data={records.data}
              loading={records.isLoading}
              failed={records.isError}
              onRetry={() => void records.refetch()}
              onRemind={setReminding}
            />
          )}
        </>
      )}

      {editingPlan && <PlanDialog plan={plan.data} onClose={() => setEditingPlan(false)} />}

      {assigning && (
        <AssignDialog people={people} areas={plan.data?.research_areas ?? []} onClose={() => setAssigning(false)} />
      )}

      {reminding && <RemindDialog reminder={reminding} onClose={() => setReminding(null)} />}

      {editing && targets.data && (
        <TargetDialog
          existing={editing.target}
          person={editing.person}
          metrics={targets.data.metrics}
          defaultYear={targets.data.year}
          people={people}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* On track                                                                  */
/* ------------------------------------------------------------------------ */

function PaceTab({
  b,
  year,
  onRemind,
  onSetTarget,
}: {
  b: Brief
  year: number
  onRemind: (r: Reminder) => void
  onSetTarget: () => void
}) {
  const t = b.totals
  const running = year >= new Date(b.as_of).getFullYear()
  const silent = b.push.filter((r) => SILENT_KINDS.includes(r.kind))
  const quality = b.push.filter((r) => !SILENT_KINDS.includes(r.kind))
  const rows = b.by_year.map((r) => ({ year: r.year, publications: r.publications, q1: r.q1, partial: r.partial }))

  return (
    <div className="space-y-10">
      <Section
        title={b.targets.length ? "Pace against the year" : `${year} against ${year - 1}`}
        action={
          <button type="button" onClick={onSetTarget} className="text-accent underline-offset-4 hover:underline">
            {b.targets.length ? "Change the targets" : "Set a target"}
          </button>
        }
      >
        {b.targets.length ? (
          <ul className="divide-y divide-line">
            {b.targets.map((x) => (
              <TargetPace key={x.metric} t={x} elapsed={b.elapsed} />
            ))}
          </ul>
        ) : (
          <div className="space-y-1">
            <p className="text-base">
              {running
                ? `${n(t.this_year_to_date)} papers by today against ${n(t.last_year_to_date)} by the same date in ${year - 1}, and ${n(t.last_year_full)} in all of ${year - 1}.`
                : `${n(t.publications)} papers in ${year} against ${n(t.last_year_full)} in ${year - 1}.`}
            </p>
            <p className="text-sm text-fg-muted">
              No target is set for {year}. A target lets this page say how many papers a month the rest of the year needs
              {running && b.months_left ? ` (${months(b.months_left)} are left)` : ""}.
            </p>
          </div>
        )}
        {b.college && b.college.rank != null && (
          <p className="mt-3 text-sm text-fg-muted">
            {ordinal(b.college.rank)} of {b.college.of} departments on papers per teacher: {t.per_teacher ?? 0} here, {b.college.per_teacher ?? 0} for the
            college. No other department is named.
          </p>
        )}
      </Section>

      <Section
        title="Papers per year"
        sub={
          t.quartile_known
            ? `Quartile is recorded for ${n(t.quartile_known)} of the ${n(t.publications)} papers of ${year}, so ${n(t.q1)} in Q1 is a floor.`
            : undefined
        }
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-2">
          <YearBars
            title="All papers"
            rows={rows}
            value={(r) => r.publications}
            label={(r) => n(r.publications)}
            axis={(r) => `${r.year}${r.partial ? " so far" : ""}`}
            highlight={year}
          />
          <YearBars
            title="Papers in Q1 journals"
            rows={rows}
            value={(r) => r.q1}
            label={(r) => n(r.q1)}
            axis={(r) => `${r.year}${r.partial ? " so far" : ""}`}
            highlight={year}
          />
        </div>
      </Section>

      <Section
        id="push"
        title="Who needs a push"
        sub={`No paper on record in ${year}, the ones who slipped first. Each has a reason and a next step.`}
        className="scroll-mt-6"
      >
        {silent.length === 0 && quality.length === 0 ? (
          <PushEmpty year={year} />
        ) : (
          <div className="space-y-4">
            {silent.length > 0 ? (
              <>
                <PushRows rows={silent.slice(0, 8)} pairs={b.pairs} onRemind={onRemind} />
                {silent.length > 8 && (
                  <Details count={silent.length - 8} label="more people with no paper">
                    <PushRows rows={silent.slice(8)} pairs={b.pairs} onRemind={onRemind} />
                  </Details>
                )}
                {silent.length > 1 && (
                  <Button
                    kind="quiet"
                    size="sm"
                    onClick={() =>
                      onRemind({
                        people: silent.map((r) => ({ id: r.person.id, name: r.person.name })),
                        draft: groupDraft(year),
                      })
                    }
                  >
                    <BellRing />
                    Remind all {n(silent.length)} who have no paper in {year}
                  </Button>
                )}
              </>
            ) : (
              <p className="text-base text-fg-muted">Everyone has a paper on record for {year}.</p>
            )}
            {quality.length > 0 && (
              <Details count={quality.length} label="people to talk to about the quality of their papers">
                <PushRows rows={quality} pairs={b.pairs} onRemind={onRemind} />
              </Details>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

function ordinal(k: number): string {
  const rem100 = k % 100
  if (rem100 >= 11 && rem100 <= 13) return `${k}th`
  return `${k}${["th", "st", "nd", "rd"][k % 10] ?? "th"}`
}

/* ------------------------------------------------------------------------ */
/* Faculty                                                                   */
/* ------------------------------------------------------------------------ */

type SortKey = "name" | "this_year" | "last_year" | "q1_this_year" | "led_this_year" | "total"

function FacultyTab({
  b,
  targets,
  onSetTarget,
}: {
  b: Brief
  targets: TargetsPayload | undefined
  onSetTarget: (p: BriefPerson) => void
}) {
  const [sort, setSort] = useState<SortKey>("this_year")
  const [dir, setDir] = useState<"asc" | "desc">("desc")
  const mine = useMemo(() => {
    const m = new Map<string, Target[]>()
    for (const t of targets?.personal_targets ?? []) {
      if (t.person_id) m.set(t.person_id, [...(m.get(t.person_id) ?? []), t])
    }
    return m
  }, [targets])
  const rows = useMemo(() => {
    const sign = dir === "asc" ? 1 : -1
    return [...b.people].sort((x, y) =>
      sort === "name" ? sign * x.name.localeCompare(y.name) : sign * (x[sort] - y[sort]) || x.name.localeCompare(y.name)
    )
  }, [b.people, sort, dir])
  const onSort = (key: string) => {
    if (key === sort) setDir((d) => (d === "asc" ? "desc" : "asc"))
    else {
      setSort(key as SortKey)
      setDir(key === "name" ? "asc" : "desc")
    }
  }

  const columns: Column<BriefPerson>[] = [
    {
      key: "name",
      header: "Faculty",
      sortable: true,
      cell: (p) => (
        <span className="flex items-center gap-3">
          <Avatar person={face(p)} size="md" />
          <span className="min-w-0">
            <Link to={`/faculty/${p.id}`} className="block truncate font-medium underline-offset-4 hover:underline">
              {p.name}
              {p.is_you && <span className="font-normal text-fg-muted"> (you)</span>}
            </Link>
            <Meta className="block truncate">{[p.designation, p.area].filter(Boolean).join(", ") || "Designation not recorded"}</Meta>
          </span>
        </span>
      ),
    },
    { key: "this_year", header: String(b.year), align: "right", sortable: true, empty: "None", cell: (p) => (p.this_year ? n(p.this_year) : null) },
    { key: "last_year", header: String(b.year - 1), align: "right", sortable: true, empty: "None", cell: (p) => (p.last_year ? n(p.last_year) : null) },
    { key: "q1_this_year", header: "Q1", align: "right", sortable: true, empty: "None", cell: (p) => (p.q1_this_year ? n(p.q1_this_year) : null) },
    { key: "led_this_year", header: "Led", align: "right", sortable: true, empty: "None", cell: (p) => (p.led_this_year ? n(p.led_this_year) : null) },
    { key: "total", header: "All years", align: "right", sortable: true, empty: "None", cell: (p) => (p.total ? n(p.total) : null) },
    {
      key: "target",
      header: "Their target",
      cell: (p) => {
        const theirs = mine.get(p.id) ?? []
        if (theirs.length === 0) {
          return (
            <Button kind="quiet" size="sm" onClick={() => onSetTarget(p)} aria-label={`Set a target for ${p.name}`}>
              <TargetIcon />
              Set target
            </Button>
          )
        }
        return (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            {theirs.map((t) => (
              <span key={t.id} className={cn("text-sm tabular", t.met && "text-positive")}>
                {t.metric_label}: {t.done} of {t.target}
                {t.met ? ", met" : ""}
              </span>
            ))}
          </span>
        )
      },
    },
  ]

  return (
    <Section
      title={`Every faculty member, ${b.year}`}
      sub="Papers on the college record matched to each person. A paper with two authors here counts for each. Open a name for the whole record."
    >
      <Table
        rows={rows}
        columns={columns}
        getKey={(p) => p.id}
        sortKey={sort}
        sortDir={dir}
        onSort={onSort}
        caption={`Papers by faculty member, ${b.year}`}
        empty={{ title: "Nobody is on the department's roll", message: "Faculty appear here once the research office adds them to the department." }}
      />
    </Section>
  )
}

/* ------------------------------------------------------------------------ */
/* Records to fix                                                            */
/* ------------------------------------------------------------------------ */

function RecordsTab({
  b,
  data,
  loading,
  failed,
  onRetry,
  onRemind,
}: {
  b: Brief
  data: Records | undefined
  loading: boolean
  failed: boolean
  onRetry: () => void
  onRemind: (r: Reminder) => void
}) {
  if (failed) return <ErrorState what="the records to fix" onRetry={onRetry} />
  if (loading || !data)
    return (
      <Delayed>
        <SkeletonRows rows={6} rowHeight={48} />
      </Delayed>
    )
  const first = data.years[0]
  const last = data.years[data.years.length - 1]
  return (
    <div className="space-y-10">
      <Section
        title={`Papers missing a DOI or an ISSN (${n(data.papers.length)})`}
        sub={`Papers of ${first} to ${last}, the five years NAAC 3.3 and NBA look at. A paper needs a DOI; a journal article also needs an ISSN. An assessor sends the rest back, so fix them now.`}
        action={
          data.papers.length > 0 ? (
            <Link to={papersLink({ missing: "doi" })} className="text-accent underline-offset-4 hover:underline">
              Open the papers with no DOI
            </Link>
          ) : undefined
        }
      >
        {data.papers.length === 0 ? (
          <p className="border-y border-line py-6 text-base text-fg-muted">
            Nothing to fix: all {n(data.papers_checked)} papers of {first} to {last} have an ISSN and a DOI.
          </p>
        ) : (
          <Rows>
            {data.papers.slice(0, 15).map((p) => (
              <li key={p.id}>
                <Link to={`/department/papers/${p.id}`} className="row flex items-center gap-3 px-1 py-2.5 sm:px-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base underline-offset-4 hover:underline">{paperTitle(p.title)}</span>
                    <Meta className="block truncate">
                      {[p.authors.join(", "), p.journal, p.year].filter(Boolean).join(" · ") || "Details not recorded"}
                    </Meta>
                  </span>
                  <span className="shrink-0 text-sm text-critical">no {p.missing.join(" or ")}</span>
                </Link>
              </li>
            ))}
          </Rows>
        )}
        {data.papers.length > 15 && (
          <Meta className="mt-2 block">
            {n(data.papers.length - 15)} more. The NBA and NAAC workbook lists every one on its Missing data sheet.
          </Meta>
        )}
      </Section>

      <Section
        title={`Faculty with no Scopus ID on file (${n(data.no_scopus_id.length)})`}
        sub="Without it their papers may not be matched to them, so they can look like they have published nothing."
        action={
          data.no_scopus_id.length > 1 ? (
            <button
              type="button"
              className="text-accent underline-offset-4 hover:underline"
              onClick={() =>
                onRemind({
                  people: data.no_scopus_id.map((p) => ({ id: p.id, name: p.name })),
                  draft:
                    "A reminder from your head of department: your Scopus ID is not on your profile, so your papers may not be matched to you. Please add it under your profile. If you do not have one, tell me and I will ask the research office.",
                })
              }
            >
              Remind all {n(data.no_scopus_id.length)}
            </button>
          ) : undefined
        }
      >
        {data.no_scopus_id.length === 0 ? (
          <p className="border-y border-line py-6 text-base text-fg-muted">Every faculty member has a Scopus ID on file.</p>
        ) : (
          <Rows>
            {data.no_scopus_id.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-1 py-2.5 sm:px-2">
                <Avatar person={face(p)} size="md" />
                <span className="min-w-0 flex-1">
                  <Link to={`/faculty/${p.id}`} className="block truncate text-base font-medium underline-offset-4 hover:underline">
                    {p.name}
                  </Link>
                  <Meta className="block truncate">{p.designation || "Designation not recorded"}</Meta>
                </span>
                <Button
                  kind="quiet"
                  size="sm"
                  aria-label={`Remind ${p.name} to add a Scopus ID`}
                  onClick={() =>
                    onRemind({
                      people: [{ id: p.id, name: p.name }],
                      draft:
                        "A reminder from your head of department: your Scopus ID is not on your profile, so your papers may not be matched to you. Please add it under your profile.",
                    })
                  }
                >
                  <BellRing />
                  Remind
                </Button>
              </li>
            ))}
          </Rows>
        )}
      </Section>
      <p className="text-sm text-fg-muted">{b.totals.scopus_indexed ? `${n(b.totals.scopus_indexed)} of ${n(b.totals.record_papers)} papers of ${b.year} are listed in Scopus.` : ""}</p>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The department's vision                                                   */
/* ------------------------------------------------------------------------ */

/**
 * What the department is for, and the areas it wants to be known for.
 *
 * A target says how much; nothing on this page said what. A new colleague
 * asking "what should I work on here" got whichever answer the person they
 * asked happened to give. Written here, it is the same answer for everybody
 * -- the department's own faculty can read it too.
 */
function VisionSection({
  plan,
  loading,
  failed,
  onRetry,
  onEdit,
}: {
  plan: Plan | undefined
  loading: boolean
  failed: boolean
  onRetry: () => void
  onEdit: () => void
}) {
  const empty = !plan || (!plan.vision && plan.research_areas.length === 0)

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle>Department vision</SectionTitle>
        {!loading && !failed && (
          <Button
            kind={empty ? "primary" : "quiet"}
            size="sm"
            onClick={onEdit}
            aria-label={empty ? undefined : "Edit the vision"}
          >
            <Pencil />
            {empty ? "Write the vision" : "Edit"}
          </Button>
        )}
      </div>

      {loading ? (
        <SkeletonRows rows={2} rowHeight={40} />
      ) : failed ? (
        // Not the empty state: a head told "no vision written down yet"
        // because a request failed would write one again over their own.
        <ErrorState
          title="Could not load the vision"
          message="The server did not answer. Nothing written here has been lost."
          onRetry={onRetry}
        />
      ) : empty ? (
        <div className="rounded-lg bg-sunken px-6 py-8 text-center">
          <p className="text-base">No vision written down yet.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-fg-muted">
            A few sentences on what the department is for, and the areas it wants to be known
            for, give every colleague the same answer to “what should I work on here?”
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {plan.vision && (
            <p className="max-w-3xl whitespace-pre-line text-base">{plan.vision}</p>
          )}
          {plan.research_areas.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Research areas">
              {plan.research_areas.map((area) => (
                <li
                  key={area}
                  className="rounded-sm bg-accent-wash px-2 py-0.5 text-sm text-accent"
                >
                  {area}
                </li>
              ))}
            </ul>
          )}
          {plan.updated_at && (
            <Meta className="block">
              Last changed <When iso={plan.updated_at} />
              {plan.updated_by ? ` by ${plan.updated_by}` : ""}
            </Meta>
          )}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Targets                                                                   */
/* ------------------------------------------------------------------------ */

function TargetsSection({
  data,
  loading,
  failed,
  onRetry,
  year,
  onAdd,
  onEdit,
}: {
  data: TargetsPayload | undefined
  loading: boolean
  failed: boolean
  onRetry: () => void
  year: number
  onAdd: () => void
  onEdit: (t: Target) => void
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle>Targets for {year}</SectionTitle>
        <Button kind="primary" size="sm" onClick={onAdd}>
          <Plus />
          Set a target
        </Button>
      </div>

      {loading ? (
        <SkeletonRows rows={3} rowHeight={52} />
      ) : failed ? (
        // Not the empty state below. A head whose request failed was told
        // their department had agreed no targets at all this year.
        <ErrorState
          title="Could not load the targets"
          message="The server did not answer. Any target already agreed is still there."
          onRetry={onRetry}
        />
      ) : !data || data.department_targets.length === 0 ? (
        <div className="border-y border-line py-10 text-center">
          <TargetIcon className="mx-auto mb-2 size-7 text-fg-subtle" aria-hidden />
          <p className="text-base">No target set for the department this year.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-fg-muted">
            A target written down is the difference between “we should do better” and “we
            agreed eleven Q1 papers and we are at four”.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {data.department_targets.map((t) => (
            <TargetRow key={t.id} target={t} onEdit={() => onEdit(t)} />
          ))}
        </ul>
      )}
    </section>
  )
}

function TargetRow({ target, onEdit }: { target: Target; onEdit: () => void }) {
  const share = target.fraction == null ? 0 : Math.min(1, target.fraction)

  return (
    <li className="row space-y-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-base">
            {target.metric_label}
            {target.person_name && <span className="text-fg-muted"> · {target.person_name}</span>}
          </p>
          {target.note && <Meta className="block">{target.note}</Meta>}
        </div>
        <div className="flex items-baseline gap-3">
          <span
            className={cn(
              "text-base font-medium tabular",
              target.met ? "text-positive" : "text-fg"
            )}
          >
            {target.done} / {target.target}
          </span>
          <Button kind="quiet" size="sm" className="reveal" onClick={onEdit}>
            Change
          </Button>
        </div>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"
        role="progressbar"
        aria-valuenow={target.done}
        aria-valuemin={0}
        aria-valuemax={target.target}
        aria-label={`${target.metric_label}: ${target.done} of ${target.target}`}
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-500",
            target.met ? "bg-positive" : "bg-accent"
          )}
          style={{ width: `${share * 100}%` }}
        />
      </div>
      {(!target.met || target.due_date) && (
        <Meta className="block">
          {target.met ? "Reached" : `${target.remaining} more to go`}
          {target.due_date && (
            <>
              {" · "}
              <Due day={target.due_date} done={target.met} />
            </>
          )}
          {target.set_by ? ` · set by ${target.set_by}` : ""}
        </Meta>
      )}
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Work assigned                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Who has been asked to do what, grouped by how far along it is.
 *
 * An instruction given in a corridor has no record: nobody can tell a month
 * later whether it was done, or whether it was ever given. Each one written
 * here is also on the home screen of the people it is for, and they move its
 * status themselves -- so this list is the head's view of answers, not a
 * list of things the head has to chase to find out about.
 */
function AssignmentsSection({
  data,
  loading,
  failed,
  onRetry,
  onAssign,
}: {
  data: Assignment[] | undefined
  loading: boolean
  failed: boolean
  onRetry: () => void
  onAssign: () => void
}) {
  return (
    <section className="space-y-4" aria-label="Work assigned">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle>Work assigned</SectionTitle>
        <Button kind="primary" size="sm" onClick={onAssign}>
          <UserPlus />
          Assign work
        </Button>
      </div>

      {loading ? (
        <SkeletonRows rows={3} rowHeight={52} />
      ) : failed ? (
        <ErrorState
          title="Could not load the work assigned"
          message="The server did not answer. Nothing handed out has been lost."
          onRetry={onRetry}
        />
      ) : !data || data.length === 0 ? (
        <div className="rounded-lg bg-sunken px-6 py-8 text-center">
          <p className="text-base">Nothing handed out yet.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-fg-muted">
            A task, two colleagues paired to write together, or a research area for somebody to
            take up. The people it is for see it on their home screen.
          </p>
        </div>
      ) : (
        STATUSES.map(({ value, label }) => {
          const rows = data.filter((a) => a.status === value)
          if (rows.length === 0) return null
          return (
            <div key={value} className="space-y-1.5">
              <div className="flex items-baseline gap-2">
                <h3 className="text-base font-medium">{label}</h3>
                <Meta className="tabular">{rows.length}</Meta>
              </div>
              <ul className="divide-y divide-line border-y border-line">
                {rows.map((a) => (
                  <AssignmentRow key={a.id} assignment={a} />
                ))}
              </ul>
            </div>
          )
        })
      )}
    </section>
  )
}

function AssignmentRow({ assignment: a }: { assignment: Assignment }) {
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)
  const move = useApiMutation<{ status: AssignmentStatus }, Assignment>(
    `/api/hod/assignments/${a.id}`,
    { method: "PATCH", invalidates: [["hod", "assignments"]] }
  )
  const withdraw = useApiMutation<void, { ok: boolean }>(`/api/hod/assignments/${a.id}`, {
    method: "DELETE",
    invalidates: [["hod", "assignments"]],
  })

  const who = a.partner_name ? `${a.assignee_name} & ${a.partner_name}` : a.assignee_name

  async function changeStatus(status: AssignmentStatus) {
    try {
      await move.mutateAsync({ status })
      const label = STATUSES.find((s) => s.value === status)?.label ?? status
      toast.ok(`“${a.title}” is now ${label.toLowerCase()}`)
    } catch (err) {
      toast.fail(err)
    }
  }

  async function withdrawIt() {
    try {
      await withdraw.mutateAsync(undefined as never)
      toast.ok(`Withdrew “${a.title}”`)
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  return (
    <li className="row flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 py-2.5 sm:px-2">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          <KindBadge label={a.kind_label} />
          <span className="truncate text-base">{a.title}</span>
        </p>
        <Meta className="mt-0.5 block">
          {who}
          {a.due_date && (
            <>
              {" · "}
              <Due day={a.due_date} done={a.status === "DONE"} />
            </>
          )}
        </Meta>
        {a.notes && <p className="mt-0.5 text-sm text-fg-muted">{a.notes}</p>}
      </div>
      <StatusSelect
        value={a.status}
        title={a.title}
        disabled={move.isPending}
        onChange={(status) => void changeStatus(status)}
      />
      <Button
        kind="quiet"
        size="icon"
        className="reveal"
        aria-label={`Withdraw ${a.title}`}
        onClick={() => setConfirmWithdraw(true)}
      >
        <Trash2 />
      </Button>
      <ConfirmDialog
        open={confirmWithdraw}
        onOpenChange={setConfirmWithdraw}
        danger
        title="Withdraw this assignment?"
        description={`${who} will no longer see “${a.title}” on their home screen.`}
        confirmLabel="Withdraw it"
        onConfirm={withdrawIt}
      />
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Setting a target                                                          */
/* ------------------------------------------------------------------------ */

function TargetDialog({
  existing,
  person,
  metrics,
  defaultYear,
  people,
  onClose,
}: {
  existing: Target | null
  person: Person | null
  metrics: { key: string; label: string }[]
  defaultYear: number
  people: Person[]
  onClose: () => void
}) {
  const [metric, setMetric] = useState(existing?.metric ?? metrics[0]?.key ?? "PUBLICATIONS")
  const [value, setValue] = useState(existing ? String(existing.target) : "")
  const [note, setNote] = useState(existing?.note ?? "")
  const [personId, setPersonId] = useState(existing?.person_id ?? person?.id ?? "")
  const [dueDate, setDueDate] = useState(existing?.due_date ?? "")
  const [confirmDelete, setConfirmDelete] = useState(false)

  const save = useApiMutation<
    {
      year: number
      metric: string
      target: number
      person_id?: string
      note?: string
      due_date?: string
    },
    { ok: boolean; created: boolean }
  >("/api/hod/targets", { invalidates: [["hod", "targets"]] })

  const remove = useApiMutation<void, { ok: boolean }>(
    () => `/api/hod/targets/${existing?.id ?? ""}`,
    { method: "DELETE", invalidates: [["hod", "targets"]] }
  )

  const parsed = Number.parseInt(value, 10)
  const valid = Number.isFinite(parsed) && parsed >= 0

  const personOptions: ComboboxOption[] = [
    { value: "", label: "The whole department" },
    ...people.map((p) => ({ value: p.id, label: p.name })),
  ]

  const who = personId
    ? people.find((p) => p.id === personId)?.name || "them"
    : "the department"

  async function submit() {
    if (!valid) return
    try {
      await save.mutateAsync({
        year: existing?.year ?? defaultYear,
        metric,
        target: parsed,
        person_id: personId || undefined,
        note: note.trim() || undefined,
        // Saving a target replaces it whole, so a blank field here clears a
        // deadline it had -- which is why the field starts pre-filled.
        due_date: dueDate || undefined,
      })
      toast.ok(
        `Target saved for ${who}: ${parsed} ${metrics
          .find((m) => m.key === metric)
          ?.label.toLowerCase()} for ${existing?.year ?? defaultYear}`
      )
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  async function deleteTarget() {
    try {
      await remove.mutateAsync(undefined as never)
      toast.ok(`Target removed for ${who}`)
      onClose()
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{existing ? "Change this target" : "Set a target"}</DialogTitle>
            <DialogDescription>
              For {existing?.year ?? defaultYear}. Progress is counted from filed papers, so it
              moves on its own as work comes in.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="For">
              <Combobox
                value={personId}
                onChange={setPersonId}
                options={personOptions}
                placeholder="The whole department"
                disabled={Boolean(existing)}
              />
            </Field>

            <Field label="Measure">
              <Combobox
                value={metric}
                onChange={setMetric}
                options={metrics.map((m) => ({ value: m.key, label: m.label }))}
                disabled={Boolean(existing)}
              />
            </Field>

            <Field label="Target" hint="A count of papers, not an amount.">
              <NumberInput
                value={value}
                onChange={(e) => setValue(e.target.value)}
                min={0}
                step="1"
                autoFocus
              />
            </Field>

            <Field label="Deadline" hint="Optional. When it should be reached by.">
              <DateInput value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>

            <Field label="Note" hint="Optional. Where the number came from.">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Agreed at the September department meeting"
              />
            </Field>
          </DialogBody>
          <DialogFooter className="justify-between">
            {existing ? (
              <Button kind="danger" onClick={() => setConfirmDelete(true)} disabled={save.isPending}>
                Remove
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button kind="quiet" onClick={onClose} disabled={save.isPending}>
                Cancel
              </Button>
              <Button kind="primary" disabled={!valid || save.isPending} onClick={() => void submit()}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title="Remove this target?"
        description={`The work stays on record; only the number ${who} was asked to reach goes away.`}
        confirmLabel="Remove the target"
        onConfirm={deleteTarget}
      />
    </>
  )
}

/* ------------------------------------------------------------------------ */
/* Writing the vision                                                        */
/* ------------------------------------------------------------------------ */

/** Mirrors the server's limits, so the head hears about them before Save. */
const MAX_AREAS = 20
const MAX_AREA_LENGTH = 80
const MAX_VISION_LENGTH = 5000

function PlanDialog({ plan, onClose }: { plan: Plan | undefined; onClose: () => void }) {
  const [vision, setVision] = useState(plan?.vision ?? "")
  const [areas, setAreas] = useState<string[]>(plan?.research_areas ?? [])
  const [draft, setDraft] = useState("")

  const save = useApiMutation<{ vision: string; research_areas: string[] }, Plan>(
    "/api/hod/plan",
    { method: "PUT", invalidates: [["hod", "plan"]] }
  )

  const pending = draft.split(/\s+/).filter(Boolean).join(" ")
  const duplicate = areas.some((a) => a.toLowerCase() === pending.toLowerCase())
  const tooLong = pending.length > MAX_AREA_LENGTH
  const full = areas.length >= MAX_AREAS
  const canAdd = Boolean(pending) && !duplicate && !tooLong && !full

  function add() {
    if (!canAdd) return
    setAreas([...areas, pending])
    setDraft("")
  }

  async function submit() {
    // An area typed and not yet added is what the head meant to keep;
    // dropping it on Save loses the last thing they did.
    const finalAreas = canAdd ? [...areas, pending] : areas
    try {
      await save.mutateAsync({ vision: vision.trim(), research_areas: finalAreas })
      toast.ok("Department vision saved. The department's faculty can read it")
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Department vision</DialogTitle>
          <DialogDescription>
            What the department is for, and the areas it wants to be known for. Everybody in the
            department can read this.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Vision" hint="A few sentences, in your own words.">
            <Textarea
              value={vision}
              onChange={(e) => setVision(e.target.value)}
              rows={4}
              maxRows={12}
              maxLength={MAX_VISION_LENGTH}
              autoFocus
            />
          </Field>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">Research areas</p>
            {areas.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {areas.map((area) => (
                  <li
                    key={area}
                    className="inline-flex items-center gap-1 rounded-sm bg-accent-wash py-0.5 pl-2 pr-0.5 text-sm text-accent"
                  >
                    {area}
                    <button
                      type="button"
                      onClick={() => setAreas(areas.filter((a) => a !== area))}
                      aria-label={`Remove ${area}`}
                      className="grid size-5 place-items-center rounded-sm hover:bg-hover"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Meta className="block">None yet.</Meta>
            )}
            <div className="flex gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    add()
                  }
                }}
                aria-label="Add a research area"
                placeholder="Photonics"
                disabled={full}
              />
              <Button onClick={add} disabled={!canAdd}>
                <Plus />
                Add
              </Button>
            </div>
            <p className="text-xs text-fg-muted">
              {full
                ? `${MAX_AREAS} areas is the most a department can name.`
                : tooLong
                  ? `A short label, ${MAX_AREA_LENGTH} characters at most. The description belongs in the vision.`
                  : duplicate
                    ? "Already listed."
                    : "Short labels, one at a time. Press Enter to add."}
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void submit()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Handing out work                                                          */
/* ------------------------------------------------------------------------ */

const KINDS: { value: AssignmentKind; label: string; what: string; placeholder: string }[] = [
  {
    value: "TASK",
    label: "Task",
    what: "What needs doing",
    placeholder: "Draft the NAAC criterion 3 narrative",
  },
  {
    value: "PAIRING",
    label: "Pair co-authors",
    what: "What they should write together",
    placeholder: "A joint paper on thin-film sensors",
  },
  {
    value: "RESEARCH_AREA",
    label: "Research area",
    what: "The area",
    placeholder: "Photonics",
  },
]

type AssignmentBody = {
  kind: AssignmentKind
  title: string
  notes?: string
  assignee_id: string
  partner_id?: string
  due_date?: string
}

function AssignDialog({
  people,
  areas,
  onClose,
}: {
  people: Person[]
  areas: string[]
  onClose: () => void
}) {
  const [kind, setKind] = useState<AssignmentKind>("TASK")
  const [title, setTitle] = useState("")
  const [notes, setNotes] = useState("")
  const [assignee, setAssignee] = useState("")
  const [partner, setPartner] = useState("")
  const [dueDate, setDueDate] = useState("")

  const create = useApiMutation<AssignmentBody, Assignment>("/api/hod/assignments", {
    invalidates: [["hod", "assignments"]],
  })

  const pairing = kind === "PAIRING"
  const current = KINDS.find((k) => k.value === kind) ?? KINDS[0]
  const valid =
    Boolean(title.trim()) && Boolean(assignee) && (!pairing || (Boolean(partner) && partner !== assignee))

  const options: ComboboxOption[] = people.map((p) => ({ value: p.id, label: p.name }))
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "them"

  async function submit() {
    if (!valid) return
    try {
      await create.mutateAsync({
        kind,
        title: title.trim(),
        notes: notes.trim() || undefined,
        assignee_id: assignee,
        partner_id: pairing ? partner : undefined,
        due_date: dueDate || undefined,
      })
      toast.ok(
        pairing
          ? `Assigned: ${nameOf(assignee)} and ${nameOf(partner)} will write together, and both have been told`
          : `Assigned to ${nameOf(assignee)}, who has been told`
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
          <DialogTitle>Assign work</DialogTitle>
          <DialogDescription>
            Only people in the department. They see it on their home screen and move its status
            themselves.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Kind</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {KINDS.map((k) => (
                <Radio
                  key={k.value}
                  name="assignment-kind"
                  value={k.value}
                  checked={kind === k.value}
                  onChange={() => {
                    setKind(k.value)
                    if (k.value !== "PAIRING") setPartner("")
                  }}
                  label={k.label}
                />
              ))}
            </div>
          </fieldset>

          <Field label={current.what}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={current.placeholder}
              maxLength={200}
            />
          </Field>

          {kind === "RESEARCH_AREA" && areas.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Meta>From the department's vision:</Meta>
              {areas.map((area) => (
                <Button key={area} kind="quiet" size="sm" onClick={() => setTitle(area)}>
                  {area}
                </Button>
              ))}
            </div>
          )}

          <Field label={pairing ? "First author" : "Who"}>
            <Combobox
              value={assignee}
              onChange={setAssignee}
              options={options}
              placeholder="Somebody in the department"
            />
          </Field>

          {pairing && (
            <Field label="Co-author" hint="Somebody else in the department.">
              <Combobox
                value={partner}
                onChange={setPartner}
                options={options.filter((o) => o.value !== assignee)}
                placeholder="Somebody in the department"
              />
            </Field>
          )}

          <Field label="Deadline" hint="Optional.">
            <DateInput value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>

          <Field label="Notes" hint="Optional. Anything they need to know to start.">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void submit()} disabled={!valid || create.isPending}>
            {create.isPending ? "Assigning…" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
