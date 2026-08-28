import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowUpRight, Plus, Target as TargetIcon, TriangleAlert } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
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
import { Field, Input, NumberInput } from "@/ui/field"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * A head of department's own screen: where the department stands, what it has
 * been asked to reach, and where it could realistically do more.
 *
 * A head could previously see what their department had published and had no
 * way at all to tell whether it was good. Forty papers is a triumph or a
 * disappointment depending entirely on what the rest of the college did, and
 * nothing in this system would say. So the first thing here is the comparison.
 *
 * Two rules this screen is built to, both enforced on the server rather than
 * by this file remembering:
 *
 * - **No money, anywhere.** Every metric is a count of work — papers,
 *   top-quartile papers, papers led from here. A head is money-blind
 *   throughout the app and a rupee target would be the one place it came back.
 * - **No other department is named.** The head sees where they sit — "3rd of
 *   22" — and what the college typically does. A ranked table of colleagues'
 *   departments is a different document with different politics, and it is not
 *   a head's to hold.
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

type Rates = {
  publications: number
  q1: number
  q1_rate: number | null
  first_author: number
  first_author_rate: number | null
}

type Standing = {
  department: string
  year: number | null
  mine: Rates & { faculty: number; per_head: number | null }
  college: Rates & { departments: number; faculty: number; per_head: number | null }
  share: number | null
  /** 1 is the largest by publications. No other department is named. */
  position: number | null
  of: number
  years: number[]
}

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

type Opportunities = {
  department: string
  groups: { key: string; title: string; blurb: string; count: number; people: Person[] }[]
  incomplete_records: {
    count: number
    blurb: string
    papers: {
      id: string
      paper_title: string
      journal_title: string | null
      publication_year: number | null
      owner_name: string | null
      missing: string[]
    }[]
  }
  lower_quartile_journals: { journal_title: string; quartile: string; count: number }[]
}

/** The overview endpoint, for the per-person table. */
type Overview = {
  department: string
  people: {
    id: string
    name: string
    designation: string | null
    publications: number
    first_author: number
    q1: number
    active: boolean
  }[]
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Department() {
  const { me } = useAuth()
  const isHod = can(me?.role).seeDepartment

  const [searchParams, setSearchParams] = useSearchParams()
  const year = searchParams.get("year") ?? ""
  const [editing, setEditing] = useState<{ target: Target | null; person: Person | null } | null>(
    null
  )

  const q = year ? `?year=${year}` : ""
  const standing = useApi<Standing>(["hod", "standing", year], `/api/hod/standing${q}`, {
    enabled: isHod,
  })
  const targets = useApi<TargetsPayload>(["hod", "targets", year], `/api/hod/targets${q}`, {
    enabled: isHod,
  })
  const opportunities = useApi<Opportunities>(
    ["hod", "opportunities", year],
    `/api/hod/opportunities${q}`,
    { enabled: isHod }
  )
  const overview = useApi<Overview>(["hod", "overview"], "/api/hod/overview", { enabled: isHod })

  if (!isHod) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="This is a head of department's own view of their department. Everybody else has the college-wide reports."
        />
      </div>
    )
  }

  const yearOptions: ComboboxOption[] = [
    { value: "", label: "All years on record" },
    ...(standing.data?.years ?? []).map((y) => ({ value: String(y), label: String(y) })),
  ]

  return (
    <div className="page space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>{standing.data?.department || "My department"}</PageTitle>
          <Sub className="mt-1">
            Where the department stands, what it is aiming at, and where it could do more.
          </Sub>
        </div>
        <Combobox
          value={year}
          onChange={(v) =>
            setSearchParams(v ? new URLSearchParams({ year: v }) : new URLSearchParams())
          }
          options={yearOptions}
          aria-label="Publication year"
          className="w-44"
        />
      </header>

      {standing.isError ? (
        <ErrorState
          title="Could not load the department"
          message={
            standing.error?.status === 400
              ? "This account has no department set, so there is nothing to show. Ask the research cell to set it."
              : "The server did not answer."
          }
          onRetry={() => standing.refetch()}
        />
      ) : standing.isLoading || !standing.data ? (
        <SkeletonRows rows={6} rowHeight={48} />
      ) : (
        <StandingSection data={standing.data} />
      )}

      <TargetsSection
        data={targets.data}
        loading={targets.isLoading}
        failed={targets.isError}
        onRetry={() => void targets.refetch()}
        year={targets.data?.year ?? new Date().getFullYear()}
        onAdd={() => setEditing({ target: null, person: null })}
        onEdit={(t) => setEditing({ target: t, person: null })}
      />

      <PeopleSection
        overview={overview.data}
        targets={targets.data}
        loading={overview.isLoading}
        failed={overview.isError}
        onRetry={() => void overview.refetch()}
        onSetFor={(person) => setEditing({ target: null, person })}
      />

      <OpportunitiesSection data={opportunities.data} loading={opportunities.isLoading} />

      {editing && targets.data && (
        <TargetDialog
          existing={editing.target}
          person={editing.person}
          metrics={targets.data.metrics}
          defaultYear={targets.data.year}
          people={overview.data?.people ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Standing                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The comparison, which is the point of the page.
 *
 * Volume and quality are shown side by side deliberately. A department can be
 * first in the college by number of papers and below the college average for
 * Q1 at the same time — that is a real and common shape, and it is precisely
 * the thing a head needs to see rather than a single "you are doing well".
 */
function StandingSection({ data }: { data: Standing }) {
  const q1Delta =
    data.mine.q1_rate != null && data.college.q1_rate != null
      ? data.mine.q1_rate - data.college.q1_rate
      : null
  const headDelta =
    data.mine.per_head != null && data.college.per_head != null
      ? data.mine.per_head - data.college.per_head
      : null

  return (
    <section className="space-y-4">
      <SectionTitle>Against the college</SectionTitle>

      <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Publications"
          value={data.mine.publications.toLocaleString("en-IN")}
          hint={
            data.share != null
              ? `${Math.round(data.share * 100)}% of the college's ${data.college.publications.toLocaleString("en-IN")}`
              : undefined
          }
        />
        <Stat
          label="Position"
          value={data.position ? `${ordinal(data.position)} of ${data.of}` : "—"}
          hint="By number of publications"
        />
        <Compare
          label="Q1 rate"
          mine={data.mine.q1_rate}
          college={data.college.q1_rate}
          delta={q1Delta}
          percent
        />
        <Compare
          label="Papers per person"
          mine={data.mine.per_head}
          college={data.college.per_head}
          delta={headDelta}
        />
      </div>

      {q1Delta != null && q1Delta < 0 && data.position != null && data.position <= 3 && (
        // The specific shape worth calling out: high volume, lower quality
        // than the college average. It reads as success on every other screen.
        <Callout tone="caution" title="High output, below the college's Q1 rate">
          {data.department} is {ordinal(data.position)} of {data.of} by volume, and{" "}
          {Math.abs(Math.round(q1Delta * 1000) / 10)} points below the college's Q1 rate. The
          department is publishing a lot; the lift available is where, not how much.
        </Callout>
      )}

      <Meta className="block">
        {data.mine.faculty} faculty in the department, of {data.college.faculty} in the college
        across {data.college.departments} departments. No other department is named here.
      </Meta>
    </section>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <ColumnLabel className="block">{label}</ColumnLabel>
      <p className="mt-0.5 text-2xl font-semibold tabular">{value}</p>
      {hint && <Meta className="mt-0.5 block text-xs">{hint}</Meta>}
    </div>
  )
}

/** Ours against the college's, with the gap said out loud in both directions. */
function Compare({
  label,
  mine,
  college,
  delta,
  percent,
}: {
  label: string
  mine: number | null
  college: number | null
  delta: number | null
  percent?: boolean
}) {
  const fmt = (v: number | null) =>
    v == null ? "—" : percent ? `${Math.round(v * 1000) / 10}%` : String(Math.round(v * 100) / 100)

  return (
    <div>
      <ColumnLabel className="block">{label}</ColumnLabel>
      <p className="mt-0.5 text-2xl font-semibold tabular">{fmt(mine)}</p>
      <Meta className="mt-0.5 block text-xs">
        college {fmt(college)}
        {delta != null && delta !== 0 && (
          <span className={cn("ml-1 font-medium", delta > 0 ? "text-positive" : "text-critical")}>
            {delta > 0 ? "+" : "−"}
            {percent
              ? `${Math.abs(Math.round(delta * 1000) / 10)} pts`
              : Math.abs(Math.round(delta * 100) / 100)}
          </span>
        )}
      </Meta>
    </div>
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
      {!target.met && (
        <Meta className="block">
          {target.remaining} more to go
          {target.set_by ? ` · set by ${target.set_by}` : ""}
        </Meta>
      )}
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* The people                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Everybody in the department, what they have published, and their own
 * target if they have one.
 *
 * The personal target sits on the same row as the person's output on purpose:
 * a head setting a target for somebody is looking at what that person has
 * actually done while they set it, rather than at a number in a different
 * screen.
 */
function PeopleSection({
  overview,
  targets,
  loading,
  failed,
  onRetry,
  onSetFor,
}: {
  overview: Overview | undefined
  targets: TargetsPayload | undefined
  loading: boolean
  failed: boolean
  onRetry: () => void
  onSetFor: (person: Person) => void
}) {
  const byPerson = new Map<string, Target[]>()
  for (const t of targets?.personal_targets ?? []) {
    if (!t.person_id) continue
    byPerson.set(t.person_id, [...(byPerson.get(t.person_id) ?? []), t])
  }

  const people = (overview?.people ?? []).filter((p) => p.active)

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle>The department</SectionTitle>
        <Meta>{people.length} people</Meta>
      </div>

      {loading ? (
        <SkeletonRows rows={8} rowHeight={40} />
      ) : failed ? (
        // "Nobody is on the roster for this department" is a startling thing
        // to tell a head of department because a request timed out.
        <ErrorState
          title="Could not load the roster"
          message="The server did not answer. Nobody has been removed."
          onRetry={onRetry}
        />
      ) : people.length === 0 ? (
        <p className="border-y border-line py-8 text-center text-sm text-fg-muted">
          Nobody is on the roster for this department.
        </p>
      ) : (
        <TableScroller minWidth="46rem">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" className={stickyHeadCell}>
                  <ColumnLabel>Person</ColumnLabel>
                </th>
                <th scope="col" className={cn(stickyHeadCell, "w-24 text-right")}>
                  <ColumnLabel>Papers</ColumnLabel>
                </th>
                <th scope="col" className={cn(stickyHeadCell, "w-20 text-right")}>
                  <ColumnLabel>Q1</ColumnLabel>
                </th>
                <th scope="col" className={cn(stickyHeadCell, "w-24 text-right")}>
                  <ColumnLabel>Led</ColumnLabel>
                </th>
                <th scope="col" className={cn(stickyHeadCell, "w-56")}>
                  <ColumnLabel>Their target</ColumnLabel>
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const theirs = byPerson.get(p.id) ?? []
                return (
                  <tr key={p.id} className="row border-b border-line last:border-b-0">
                    <td className="p-0 align-middle">
                      <Link to={`/people/${p.id}`} className="block px-3 py-2">
                        <span className="block truncate">{p.name}</span>
                        <Meta className="block truncate">{p.designation || "Faculty"}</Meta>
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right align-middle tabular">{p.publications}</td>
                    <td className="px-3 py-2 text-right align-middle tabular">
                      {p.q1 || <Meta>—</Meta>}
                    </td>
                    <td className="px-3 py-2 text-right align-middle tabular">
                      {p.first_author || <Meta>—</Meta>}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      {theirs.length === 0 ? (
                        <Button
                          kind="quiet"
                          size="sm"
                          className="reveal"
                          onClick={() => onSetFor(p)}
                        >
                          <TargetIcon />
                          Set one
                        </Button>
                      ) : (
                        <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                          {theirs.map((t) => (
                            <span
                              key={t.id}
                              className={cn("text-sm tabular", t.met && "text-positive")}
                            >
                              {t.metric_label}: {t.done}/{t.target}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableScroller>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Opportunities                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Where the department could realistically do more.
 *
 * Every group carries the names behind it, not just a count: "eleven papers
 * would fail accreditation" is a statistic, and the list of which eleven is a
 * task somebody can finish this week.
 */
function OpportunitiesSection({
  data,
  loading,
}: {
  data: Opportunities | undefined
  loading: boolean
}) {
  if (loading) return <SkeletonRows rows={5} rowHeight={44} />
  if (!data) return null

  return (
    <section className="space-y-4">
      <SectionTitle>Where the lift is</SectionTitle>

      {data.groups
        .filter((g) => g.count > 0)
        .map((g) => (
          <div key={g.key} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-base font-medium">{g.title}</p>
              <Meta className="tabular">{g.count}</Meta>
            </div>
            <p className="max-w-2xl text-sm text-fg-muted">{g.blurb}</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 border-y border-line py-2">
              {g.people.slice(0, 18).map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/people/${p.id}`}
                    className="text-sm underline-offset-4 hover:underline"
                  >
                    {p.name}
                  </Link>
                </li>
              ))}
              {g.people.length > 18 && (
                <li>
                  <Meta>+{g.people.length - 18} more</Meta>
                </li>
              )}
            </ul>
          </div>
        ))}

      {data.incomplete_records.count > 0 && (
        <div className="space-y-2">
          <Callout
            tone="caution"
            title={`${data.incomplete_records.count.toLocaleString("en-IN")} papers are missing an ISSN or a DOI`}
          >
            {data.incomplete_records.blurb}
          </Callout>
          <ul className="divide-y divide-line border-y border-line">
            {data.incomplete_records.papers.slice(0, 10).map((c) => (
              <li key={c.id} className="row">
                <Link to={`/papers/${c.id}`} className="flex items-center gap-3 px-1 py-2 sm:px-2">
                  <TriangleAlert className="size-4 shrink-0 text-caution" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{c.paper_title || "Untitled"}</span>
                    <Meta className="block truncate">
                      {[c.owner_name, c.journal_title, c.publication_year]
                        .filter(Boolean)
                        .join(" · ")}
                    </Meta>
                  </span>
                  <span className="shrink-0 text-sm text-critical">
                    no {c.missing.join(", no ")}
                  </span>
                  <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.lower_quartile_journals.length > 0 && (
        <div className="space-y-2">
          <p className="text-base font-medium">Where the department publishes lowest</p>
          <p className="max-w-2xl text-sm text-fg-muted">
            Q3 and Q4 journals the department already uses. The realistic next move is usually a
            better journal in a field somebody is already working in, rather than a new field.
          </p>
          <ul className="divide-y divide-line border-y border-line">
            {data.lower_quartile_journals.map((j) => (
              <li key={`${j.journal_title}-${j.quartile}`} className="flex items-baseline justify-between gap-3 py-2">
                <Link
                  to={`/journals/${encodeURIComponent(j.journal_title)}`}
                  className="min-w-0 truncate text-sm underline-offset-4 hover:underline"
                >
                  {j.journal_title}
                </Link>
                <span className="shrink-0 text-sm tabular text-fg-muted">
                  {j.quartile} · {j.count} {j.count === 1 ? "paper" : "papers"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
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
  people: Overview["people"]
  onClose: () => void
}) {
  const [metric, setMetric] = useState(existing?.metric ?? metrics[0]?.key ?? "PUBLICATIONS")
  const [value, setValue] = useState(existing ? String(existing.target) : "")
  const [note, setNote] = useState(existing?.note ?? "")
  const [personId, setPersonId] = useState(existing?.person_id ?? person?.id ?? "")
  const [confirmDelete, setConfirmDelete] = useState(false)

  const save = useApiMutation<
    { year: number; metric: string; target: number; person_id?: string; note?: string },
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
    ...people.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name })),
  ]

  const who = personId
    ? people.find((p) => p.id === personId)?.name || "them"
    : "the department"

  async function submit() {
    if (!valid) return
    try {
      const result = await save.mutateAsync({
        year: existing?.year ?? defaultYear,
        metric,
        target: parsed,
        person_id: personId || undefined,
        note: note.trim() || undefined,
      })
      toast.ok(
        `${result.created ? "Set" : "Updated"} — ${who}: ${parsed} ${metrics
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

            <Field label="Note" hint="Optional — where the number came from.">
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
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`
}
