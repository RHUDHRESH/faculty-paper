import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import {
  ArrowUpRight,
  BellRing,
  Pencil,
  Plus,
  Target as TargetIcon,
  Trash2,
  TriangleAlert,
  UserPlus,
  X,
} from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import {
  KindBadge,
  STATUSES,
  StatusSelect,
  type Assignment,
  type AssignmentKind,
  type AssignmentStatus,
} from "@/pages/assignment-parts"
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
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Due, When } from "@/ui/when"

/**
 * A head of department's own screen: where the department stands, what it has
 * been asked to reach, and where it could realistically do more.
 *
 * A head could previously see what their department had published and had no
 * way at all to tell whether it was good. Forty papers is a triumph or a
 * disappointment depending entirely on what the rest of the college did, and
 * nothing in this system would say. So the first thing here is the comparison.
 *
 * After it comes the part of the job that is steering rather than reading:
 * what the department is for (its vision and research areas), who has been
 * asked to do what (tasks, co-authors paired to write together, research
 * areas handed to somebody), and a reminder to people who have gone quiet.
 * Each of those reaches the people it is about on their own home screen.
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

type OpportunityGroup = {
  key: string
  title: string
  blurb: string
  count: number
  people: Person[]
}

type Opportunities = {
  department: string
  groups: OpportunityGroup[]
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
  const [editingPlan, setEditingPlan] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [reminding, setReminding] = useState<OpportunityGroup | null>(null)

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
  const plan = useApi<Plan>(["hod", "plan"], "/api/hod/plan", { enabled: isHod })
  const assignments = useApi<Assignment[]>(["hod", "assignments"], "/api/hod/assignments", {
    enabled: isHod,
  })

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
            Where the department stands, what it is aiming at, who is doing what, and where it
            could do more.
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

      <VisionSection
        plan={plan.data}
        loading={plan.isLoading}
        failed={plan.isError}
        onRetry={() => void plan.refetch()}
        onEdit={() => setEditingPlan(true)}
      />

      <TargetsSection
        data={targets.data}
        loading={targets.isLoading}
        failed={targets.isError}
        onRetry={() => void targets.refetch()}
        year={targets.data?.year ?? new Date().getFullYear()}
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

      <PeopleSection
        overview={overview.data}
        targets={targets.data}
        loading={overview.isLoading}
        failed={overview.isError}
        onRetry={() => void overview.refetch()}
        onSetFor={(person) => setEditing({ target: null, person })}
      />

      <OpportunitiesSection
        data={opportunities.data}
        loading={opportunities.isLoading}
        onRemind={setReminding}
      />

      {editingPlan && <PlanDialog plan={plan.data} onClose={() => setEditingPlan(false)} />}

      {assigning && (
        <AssignDialog
          people={(overview.data?.people ?? []).filter((p) => p.active)}
          areas={plan.data?.research_areas ?? []}
          onClose={() => setAssigning(false)}
        />
      )}

      {reminding && <ReminderDialog group={reminding} onClose={() => setReminding(null)} />}

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
          value={data.position && data.of > 1 ? `${ordinal(data.position)} of ${data.of}` : "—"}
          hint={data.of > 1 ? "By number of publications" : "The only department on record, so there is nothing to rank against"}
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
        across {data.college.departments} department{data.college.departments === 1 ? "" : "s"}. No other department is named here.
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
      toast.ok(`Withdrawn — “${a.title}”`)
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
  onRemind,
}: {
  data: Opportunities | undefined
  loading: boolean
  onRemind: (group: OpportunityGroup) => void
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
              <span className="flex items-baseline gap-3">
                <Meta className="tabular">{g.count}</Meta>
                <Button
                  kind="quiet"
                  size="sm"
                  onClick={() => onRemind(g)}
                  // Each group's button says whose reminder it is: three
                  // controls all called "Send a reminder" are one control to
                  // somebody listening to the page.
                  aria-label={`Send a reminder: ${g.title}`}
                >
                  <BellRing />
                  Send a reminder
                </Button>
              </span>
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
        // Saving a target replaces it whole, so a blank field here clears a
        // deadline it had -- which is why the field starts pre-filled.
        due_date: dueDate || undefined,
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

            <Field label="Deadline" hint="Optional — when it should be reached by.">
              <DateInput value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
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
      toast.ok("Department vision saved — the department's faculty can read it")
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
                  ? `A short label — ${MAX_AREA_LENGTH} characters at most. The description belongs in the vision.`
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
  people: Overview["people"]
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
          ? `Paired — ${nameOf(assignee)} and ${nameOf(partner)}, and both have been told`
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

          <Field label="Notes" hint="Optional — anything they need to know to start.">
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

/* ------------------------------------------------------------------------ */
/* A reminder                                                                */
/* ------------------------------------------------------------------------ */

const REMINDER_OPENING = "A reminder from your head of department: "

/** A starting sentence for each group, which the head is expected to edit. */
const REMINDER_SUGGESTION: Record<string, string> = {
  silent:
    "nothing has been filed for you yet. If you have published, please file it so the department's record includes your work.",
  no_q1:
    "the department is aiming for more Q1 papers. Talk to me if you would like help choosing a journal for your next one.",
  never_led:
    "the department is credited with the papers it leads. Please consider leading your next paper as first author.",
}

const REMINDER_MIN = 10
const REMINDER_MAX = 500

function ReminderDialog({ group, onClose }: { group: OpportunityGroup; onClose: () => void }) {
  const [message, setMessage] = useState(
    REMINDER_OPENING + (REMINDER_SUGGESTION[group.key] ?? "")
  )
  const send = useApiMutation<
    { user_ids: string[]; message: string },
    { sent: number; skipped: { id: string; name: string }[] }
  >("/api/hod/nudge")

  const length = message.trim().length
  const valid = length >= REMINDER_MIN && length <= REMINDER_MAX
  const shown = group.people.slice(0, 8)

  async function submit() {
    if (!valid) return
    try {
      const result = await send.mutateAsync({
        user_ids: group.people.map((p) => p.id),
        message: message.trim(),
      })
      toast.ok(
        result.sent
          ? `Reminder sent to ${result.sent} ${result.sent === 1 ? "person" : "people"}`
          : "No reminder sent"
      )
      if (result.skipped.length) {
        // Said, not hidden: the head should know who did not get this one.
        toast.info(
          `Already reminded in the last day, so not sent again: ${result.skipped
            .map((s) => s.name)
            .join(", ")}`
        )
      }
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Send a reminder</DialogTitle>
          <DialogDescription>
            An in-app notification to each person below. Somebody reminded in the last day is
            skipped, whoever sent it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm">
            <span className="text-fg-muted">To </span>
            {shown.map((p) => p.name).join(", ")}
            {group.people.length > shown.length && (
              <span className="text-fg-muted"> and {group.people.length - shown.length} more</span>
            )}
          </p>
          <Field
            label="Message"
            hint={`${length} of ${REMINDER_MAX} characters${length < REMINDER_MIN ? ` — at least ${REMINDER_MIN}` : ""}.`}
          >
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              maxRows={10}
              maxLength={REMINDER_MAX}
              autoFocus
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={send.isPending}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void submit()} disabled={!valid || send.isPending}>
            {send.isPending ? "Sending…" : "Send reminder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
