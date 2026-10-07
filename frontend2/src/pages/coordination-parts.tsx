import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"

import { cn } from "@/lib/cn"
import { ClaimNo, ClaimNoLegend, useHashScroll } from "@/pages/cell/parts"
import { Answer } from "@/ui/answer"
import { useApi, useApiMutation } from "@/lib/query"
import { AssigneeBadge, type Assignee } from "@/ui/assignee"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import { Section } from "@/ui/section"
import { Table, type Column } from "@/ui/table"
import { CopyButton } from "@/ui/copy"
import { Avatar, initialsOf } from "@/ui/person"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { unshout } from "@/lib/names"

/**
 * The pieces of /coordination. Server: backend/core/api/coordination.py.
 * Everything here is a count or a name. There is no money and no flag on
 * this page, on purpose.
 */

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

type Person = { user_id: string; name: string; initials?: string; photo_url?: string | null }

export type Reviewer = Person & {
  role_label: string
  open: number
  cleared_this_week: number
  decided_this_week: number
  median_days: number | null
}

export type DeskRow = {
  id: string
  ticket_number: string | null
  origin?: string | null
  paper_title: string | null
  owner_id: string
  owner_name: string
  owner_department: string | null
  owner_photo_url?: string | null
  waiting_days: number
  on_hold: boolean
  assigned_to: Assignee | null
}

export type Overview = {
  sla_days: number
  desk_open: number
  unassigned: number
  held: number
  reviewers: Reviewer[]
  throughput: { week_start: string; received: number; decided: number; cleared: number }[]
  ageing: { bucket: string; count: number; breach: boolean }[]
  breaches: { count: number; oldest_days: number; rows: DeskRow[] }
  stages: { key: string; label: string; count: number; over_sla: number; oldest_days: number; on_hold: number }[]
}

type Assignable = Person & { role_label: string; desks: string[] }

type AssignResult = {
  assigned: number
  unassigned: number
  skipped: { claim_id: string; ticket_number: string | null; reason: string }[]
}

const face = (p: Person) => ({ name: p.name, initials: p.initials || initialsOf(p.name), photo_url: p.photo_url ?? null })
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`

/* ------------------------------------------------------------------------ */
/* Summary                                                                   */
/* ------------------------------------------------------------------------ */

/** The desk in four figures. Each opens the list it counts. */
export function Summary({ o }: { o: Overview }) {
  return (
    <Answer
      items={[
        { label: "Waiting at the research office", value: o.desk_open, to: "/clearing", zero: "Nothing is waiting" },
        { label: "Not given to anyone", value: o.unassigned, to: "/coordination?scope=unassigned#assign", zero: "Every claim is given", tone: "caution" },
        {
          label: o.breaches.count > 0 ? `Waiting over ${o.sla_days} days, oldest ${days(o.breaches.oldest_days)}` : `Waiting over ${o.sla_days} days`,
          value: o.breaches.count,
          to: "/coordination?scope=breach#assign",
          zero: `None past ${o.sla_days} days`,
          tone: "critical",
        },
        { label: "On hold", value: o.held, to: "/clearing", zero: "Nothing on hold" },
      ]}
    />
  )
}

/** A figure that is not a link (the research tab's teams and mentors). */
function Stat({ label, value, note, tone }: { label: string; value: number; note?: string; tone?: "caution" | "critical" }) {
  return (
    <div className="min-w-0">
      <ColumnLabel className="block">{label}</ColumnLabel>
      <p className={cn("mt-0.5 text-2xl font-semibold tabular", tone === "critical" && "text-critical", tone === "caution" && "text-caution")}>
        {value.toLocaleString("en-IN")}
      </p>
      {note && <Meta className="block text-xs">{note}</Meta>}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Workload per reviewer                                                     */
/* ------------------------------------------------------------------------ */

export function Workload({ o }: { o: Overview }) {
  const most = Math.max(1, ...o.reviewers.map((r) => r.open))
  return (
    <section aria-labelledby="workload-h" className="min-w-0">
      <SectionTitle id="workload-h">Workload per reviewer</SectionTitle>
      <p className="mt-1 text-sm text-fg-muted">
        Open is what has been given to the person and is still waiting at the research office. Median days is from filing to
        decision over the last 30 days.
      </p>
      {o.reviewers.length === 0 ? (
        <p className="mt-3 text-sm text-fg-muted">No reviewer has an account yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {o.reviewers.map((r) => (
            <li key={r.user_id} className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-center">
              <span className="flex min-w-0 items-center gap-2.5">
                <Avatar person={face(r)} size="sm" />
                <span className="min-w-0">
                  <Link to={`/people/${r.user_id}`} className="block truncate text-sm font-medium hover:underline">
                    {r.name}
                  </Link>
                  <span className="block text-xs text-fg-muted">
                    {r.role_label} · {r.cleared_this_week} cleared this week ·{" "}
                    {r.median_days == null ? "no decisions yet" : `median ${r.median_days} days`}
                  </span>
                </span>
              </span>
              <span className="flex items-center gap-2" aria-label={`${r.open} open`}>
                <span aria-hidden className="h-2 min-w-0 flex-1 rounded-sm bg-hover">
                  <span className="block h-2 rounded-sm bg-accent" style={{ width: `${(r.open / most) * 100}%` }} />
                </span>
                <span className="w-16 text-right text-sm tabular">
                  <span className="font-semibold">{r.open}</span> open
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Throughput per week                                                       */
/* ------------------------------------------------------------------------ */

function niceCeiling(n: number): number {
  if (n <= 5) return 5
  const step = n <= 20 ? 5 : n <= 50 ? 10 : n <= 100 ? 20 : 50
  return Math.ceil(n / step) * step
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const weekLabel = (iso: string) => {
  const d = new Date(iso + "T00:00:00")
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** Two series a week: claims that came in, claims the desk decided. When the
 *  first is taller than the second for long, the queue is growing. Plain
 *  columns from zero, one accent for what the desk did and a quiet grey for
 *  what arrived, named once in the legend and not with colour alone. */
export function Throughput({ o }: { o: Overview }) {
  const pts = o.throughput
  const top = niceCeiling(Math.max(0, ...pts.map((p) => Math.max(p.received, p.decided))))
  const total = pts.reduce((s, p) => ({ r: s.r + p.received, d: s.d + p.decided }), { r: 0, d: 0 })
  const ticks = [top, top / 2, 0]
  return (
    <section aria-labelledby="through-h" className="min-w-0 overflow-x-clip">
      <SectionTitle id="through-h">Throughput per week</SectionTitle>
      <p className="mt-1 text-sm text-fg-muted">
        In the last {pts.length} weeks {total.r} claims came in and the research office decided {total.d}. Decided is cleared,
        sent back or not accepted.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-sm bg-fg-subtle/45" /> Came in
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-sm bg-accent" /> Decided
        </span>
      </div>
      <div
        role="img"
        aria-label={`Claims that came in and claims decided, each week for ${pts.length} weeks. The figures are in the table below.`}
        className="mt-2 grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2"
      >
        <div className="relative h-44" aria-hidden>
          {ticks.map((t, i) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 text-xs tabular text-fg-muted"
              style={{ top: `${(i / 2) * 100}%` }}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="min-w-0 pr-3">
          <div className="relative flex h-44 items-end gap-1 sm:gap-1.5">
            {ticks.map((t, i) => (
              <span key={t} aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-line" style={{ top: `${(i / 2) * 100}%` }} />
            ))}
            {pts.map((p) => (
              <div
                key={p.week_start}
                title={`Week of ${weekLabel(p.week_start)}: ${p.received} came in, ${p.decided} decided`}
                className="relative flex h-full min-w-0 flex-1 items-end justify-center gap-px"
              >
                <span className="w-1/2 rounded-t-sm bg-fg-subtle/45" style={{ height: `${(p.received / top) * 100}%`, minHeight: p.received ? 2 : 0 }} />
                <span className="w-1/2 rounded-t-sm bg-accent" style={{ height: `${(p.decided / top) * 100}%`, minHeight: p.decided ? 2 : 0 }} />
              </div>
            ))}
          </div>
          <div aria-hidden className="mt-1 flex gap-1 sm:gap-1.5">
            {pts.map((p, i) => (
              <span key={p.week_start} className="min-w-0 flex-1 text-center text-[11px] leading-4 text-fg-muted">
                <span className={cn("whitespace-nowrap", (pts.length - 1 - i) % 2 === 0 ? "" : "invisible")}>
                  {weekLabel(p.week_start)}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-fg-muted hover:text-fg">Show the numbers</summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-fg-muted">
              <th className="py-1 font-medium">Week of</th>
              <th className="py-1 text-right font-medium">Came in</th>
              <th className="py-1 text-right font-medium">Decided</th>
              <th className="py-1 text-right font-medium">Cleared</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.week_start} className="border-b border-line last:border-0">
                <td className="py-1">{weekLabel(p.week_start)}</td>
                <td className="py-1 text-right tabular">{p.received}</td>
                <td className="py-1 text-right tabular">{p.decided}</td>
                <td className="py-1 text-right tabular">{p.cleared}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Ageing and stuck claims                                                   */
/* ------------------------------------------------------------------------ */

export function Ageing({ o }: { o: Overview }) {
  const top = Math.max(1, ...o.ageing.map((a) => a.count))
  return (
    <section aria-labelledby="age-h" className="min-w-0">
      <SectionTitle id="age-h">How long they have waited</SectionTitle>
      <p className="mt-1 text-sm text-fg-muted">
        Claims waiting at the research office. Anything past {o.sla_days} days is over the service level.
      </p>
      <ul className="mt-3 space-y-2">
        {o.ageing.map((a) => (
          <li key={a.bucket} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_2rem] items-center gap-3 text-sm">
            <span className="truncate">{cap(a.bucket)}</span>
            <span aria-hidden className="h-3 rounded-sm bg-hover">
              <span
                className={cn("block h-3 rounded-sm", a.breach ? "bg-critical" : "bg-fg-subtle/55")}
                style={{ width: `${(a.count / top) * 100}%`, minWidth: a.count ? 4 : 0 }}
              />
            </span>
            <span className="text-right tabular font-medium">{a.count}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-fg-muted">
        <span aria-hidden className="size-2.5 rounded-sm bg-critical" /> Past the service level <span aria-hidden className="ml-3 size-2.5 rounded-sm bg-fg-subtle/55" /> Within it
      </p>
    </section>
  )
}

export function Stuck({ o }: { o: Overview }) {
  const top = Math.max(1, ...o.stages.map((s) => s.count))
  return (
    <section aria-labelledby="stuck-h" className="min-w-0">
      <SectionTitle id="stuck-h">Where claims are waiting</SectionTitle>
      <p className="mt-1 text-sm text-fg-muted">
        Counts at each step of the chain. Open the queue of that step to see the claims.
      </p>
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {o.stages.map((s) => (
          <li key={s.key} className="py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <span className="text-sm font-medium">{s.label}</span>
              <span className="text-sm tabular">
                <span className="font-semibold">{s.count}</span>
                {s.count > 0 && (
                  <span className="text-fg-muted">
                    {" "}
                    · oldest {days(s.oldest_days)}
                  </span>
                )}
              </span>
            </div>
            <div aria-hidden className="mt-1.5 flex h-2 overflow-hidden rounded-sm bg-hover">
              <span className="block h-2 bg-fg-subtle/55" style={{ width: `${((s.count - s.over_sla) / top) * 100}%` }} />
              <span className="block h-2 bg-critical" style={{ width: `${(s.over_sla / top) * 100}%` }} />
            </div>
            {s.over_sla > 0 && (
              <p className="mt-1 text-xs text-critical">
                {s.over_sla} past {o.sla_days} days
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Assigning                                                                 */
/* ------------------------------------------------------------------------ */

const SCOPES = [
  { id: "all", label: "All" },
  { id: "unassigned", label: "Not given to anyone" },
  { id: "breach", label: "Past 14 days" },
  { id: "assigned", label: "Given" },
] as const
type Scope = (typeof SCOPES)[number]["id"]

export function Assign({ slaDays }: { slaDays: number }) {
  // The desk's figures link here as ?scope=unassigned or ?scope=breach.
  const [params] = useSearchParams()
  const fromUrl = params.get("scope")
  const [scope, setScope] = useState<Scope>(SCOPES.some((s) => s.id === fromUrl) ? (fromUrl as Scope) : "unassigned")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [to, setTo] = useState<string>("")
  const list = useApi<{ total: number; results: DeskRow[] }>(["coordination", "claims", scope], `/api/coordination/claims?scope=${scope}`, {
    placeholderData: (prev) => prev,
  })
  const people = useApi<Assignable[]>(["coordination", "reviewers"], "/api/coordination/reviewers")
  const assign = useApiMutation<{ claim_ids: string[]; assignee_id: string | null }, AssignResult>("/api/coordination/assign", {
    invalidates: [["coordination"], ["clearing-queue"]],
  })

  const options = useMemo(
    () =>
      (people.data ?? [])
        .filter((p) => p.desks.includes("supervisor"))
        .map((p) => ({ value: p.user_id, label: p.name, hint: p.role_label })),
    [people.data]
  )
  const rows = list.data?.results ?? []

  async function run(ids: string[], assignee: string | null) {
    if (ids.length === 0) return
    try {
      const r = await assign.mutateAsync({ claim_ids: ids, assignee_id: assignee })
      const done = assignee ? r.assigned : r.unassigned
      const who = options.find((o) => o.value === assignee)?.label
      if (done > 0) {
        toast.ok(assignee ? `Assigned ${done} ${done === 1 ? "claim" : "claims"} to ${who}.` : `Took back ${done} ${done === 1 ? "claim" : "claims"}. Nobody holds them now.`)
      }
      if (r.skipped.length > 0) {
        toast.fail(new Error(`${r.skipped.length} skipped. ${r.skipped[0].ticket_number ?? "A claim"}: ${r.skipped[0].reason}`))
      }
      setPicked(new Set())
    } catch (e) {
      toast.fail(e)
    }
  }

  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.id))
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  useHashScroll(!list.isLoading)
  return (
    <section id="assign" aria-labelledby="assign-h" className="scroll-mt-6 space-y-3">
      <div>
        <SectionTitle id="assign-h">Assign claims to reviewers</SectionTitle>
        <p className="mt-1 max-w-prose text-sm text-fg-muted">
          The person you choose sees these first under Assigned to me in the clearing queue. Anyone at the desk can still clear
          them. A claim can never go to the person who filed it.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Which claims">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={scope === s.id}
            onClick={() => {
              setScope(s.id)
              setPicked(new Set())
            }}
            className={cn(
              "h-7 rounded-full px-3 text-sm ring-1 ring-inset transition-colors duration-[var(--dur-1)] ease-out max-sm:h-10",
              scope === s.id ? "bg-accent-wash font-medium text-accent ring-accent-line" : "bg-surface text-fg-muted ring-line hover:text-fg"
            )}
          >
            {s.id === "breach" ? `Past ${slaDays} days` : s.label}
          </button>
        ))}
      </div>

      {scope === "unassigned" && rows.length > 1 && options.length > 0 && (
        <ShareEvenly
          rows={rows}
          options={options}
          busy={assign.isPending}
          onShare={async (plan) => {
            let total = 0
            let people = 0
            for (const [who, ids] of plan) {
              if (ids.length === 0) continue
              try {
                const r = await assign.mutateAsync({ claim_ids: ids, assignee_id: who })
                total += r.assigned
                people += r.assigned > 0 ? 1 : 0
                if (r.skipped.length > 0) toast.fail(new Error(`${r.skipped.length} skipped. ${r.skipped[0].ticket_number ?? "A claim"}: ${r.skipped[0].reason}`))
              } catch (e) {
                toast.fail(e)
                return
              }
            }
            toast.ok(`Shared. ${total} ${total === 1 ? "claim" : "claims"} given to ${people} ${people === 1 ? "reviewer" : "reviewers"}`)
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-sunken px-3 py-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(rows.map((r) => r.id)))} />
          {picked.size > 0 ? `${picked.size} chosen` : "Choose all shown"}
        </label>
        <span className="hidden flex-1 sm:block" />
        <Combobox value={to || null} onChange={setTo} options={options} placeholder="Give to…" aria-label="Give the chosen claims to" className="w-full sm:w-56" />
        <Button kind="primary" size="sm" disabled={!to || picked.size === 0 || assign.isPending} onClick={() => void run([...picked], to)}>
          {picked.size > 0 ? `Assign ${picked.size} ${picked.size === 1 ? "claim" : "claims"}${to ? ` to ${options.find((o) => o.value === to)?.label ?? ""}` : ""}` : "Assign chosen claims"}
        </Button>
        <Button kind="quiet" size="sm" disabled={picked.size === 0 || assign.isPending} onClick={() => void run([...picked], null)}>
          {picked.size > 0 ? `Take back ${picked.size} ${picked.size === 1 ? "claim" : "claims"}` : "Take back chosen claims"}
        </Button>
      </div>

      {list.isLoading && !list.data ? (
        <SkeletonRows rows={4} rowHeight={56} />
      ) : list.isError ? (
        <ErrorState title="Could not load the claims" onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          art="empty-queue"
          title={scope === "unassigned" ? "Every claim is given to someone" : "No claims here"}
          message={scope === "unassigned" ? "Nothing is waiting without a reviewer." : "Try another filter above."}
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-3 md:grid-cols-[1.5rem_minmax(0,1fr)_11rem_13rem] md:items-center">
              <input
                type="checkbox"
                aria-label={`Choose ${r.ticket_number ?? "this claim"}`}
                className="mt-1 size-4 accent-[var(--color-accent)] md:mt-0"
                checked={picked.has(r.id)}
                onChange={() => toggle(r.id)}
              />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 text-sm">
                  <Link to={`/review/${r.id}?queue=clearing`} className="font-medium tabular hover:underline">
                    <ClaimNo ticket={r.ticket_number} origin={r.origin} />
                  </Link>
                  {r.ticket_number && <CopyButton value={r.ticket_number} label="claim number" />}
                  <span className={cn("tabular", r.waiting_days > slaDays ? "font-medium text-critical" : "text-fg-muted")}>
                    {days(r.waiting_days)}
                  </span>
                  {r.on_hold && <span className="text-caution">On hold</span>}
                </p>
                <p className="line-clamp-2 break-words text-sm">{unshout(r.paper_title) || "Untitled paper"}</p>
              </div>
              <div className="col-start-2 flex min-w-0 items-center gap-2 md:col-start-auto">
                <Avatar person={{ name: r.owner_name, initials: initialsOf(r.owner_name), photo_url: r.owner_photo_url ?? null }} size="xs" />
                <span className="min-w-0 text-sm">
                  <span className="block truncate">{r.owner_name}</span>
                  <span className="block truncate text-xs text-fg-muted">{r.owner_department ?? "No department"}</span>
                </span>
              </div>
              <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-2 md:col-start-auto">
                <Combobox
                  value={r.assigned_to?.user_id ?? null}
                  onChange={(v) => void run([r.id], v)}
                  options={options}
                  placeholder="Not given to anyone"
                  aria-label={`Reviewer for ${r.ticket_number ?? "this claim"}`}
                  className="w-full"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <ClaimNoLegend show={rows.some((r) => !!r.origin)} />
      {list.data && list.data.total > rows.length && (
        <Meta className="block">Showing the oldest {rows.length} of {list.data.total}.</Meta>
      )}
    </section>
  )
}

/**
 * Who gets which claim when the un-given ones are shared out: oldest first,
 * each to the chosen reviewer who holds the fewest at that moment, never the
 * person who filed it. Pure, so the preview and the action agree.
 */
export function planShare(
  rows: { id: string; owner_id: string }[],
  reviewers: string[],
  open: Record<string, number>
): Map<string, string[]> {
  const load = new Map(reviewers.map((id) => [id, open[id] ?? 0]))
  const plan = new Map<string, string[]>(reviewers.map((id) => [id, []]))
  for (const r of rows) {
    const eligible = reviewers.filter((id) => id !== r.owner_id)
    if (eligible.length === 0) continue
    eligible.sort((a, b) => load.get(a)! - load.get(b)! || reviewers.indexOf(a) - reviewers.indexOf(b))
    const pick = eligible[0]
    plan.get(pick)!.push(r.id)
    load.set(pick, load.get(pick)! + 1)
  }
  return plan
}

/** Share the un-given claims out evenly among the chosen reviewers (one button). */
function ShareEvenly({
  rows,
  options,
  onShare,
  busy,
}: {
  rows: DeskRow[]
  options: { value: string; label: string; hint?: string }[]
  onShare: (plan: Map<string, string[]>) => Promise<void>
  busy: boolean
}) {
  const overview = useApi<Overview>(["coordination", "overview"], "/api/coordination/overview")
  const people = overview.data?.reviewers ?? []
  const open = Object.fromEntries(people.map((p) => [p.user_id, p.open]))
  // Start with the people whose job it is to clear: the cell and the coordinator.
  const [chosen, setChosen] = useState<string[] | null>(null)
  const defaults = options.filter((o) => /research office|research coordinator/i.test(o.hint ?? "")).map((o) => o.value)
  const ids = chosen ?? defaults
  const plan = planShare(rows, ids, open)
  const given = [...plan.values()].reduce((s, a) => s + a.length, 0)
  const toggle = (id: string) => setChosen(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  return (
    <div className="space-y-3 rounded-panel bg-surface p-4 ring-1 ring-edge" aria-label="Share out evenly" role="group">
      <div>
        <p className="text-base font-medium">Share these {rows.length} out evenly</p>
        <p className="text-sm text-fg-muted">Oldest first, each to whoever holds the fewest. Nobody gets their own claim.</p>
      </div>
      <ul className="flex flex-wrap gap-2" aria-label="Who to share with">
        {options.map((o) => {
          const on = ids.includes(o.value)
          const n = plan.get(o.value)?.length ?? 0
          return (
            <li key={o.value}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(o.value)}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-full px-3 text-sm ring-1 ring-inset max-sm:h-10",
                  on ? "bg-accent-wash font-medium text-accent ring-accent-line" : "bg-surface text-fg-muted ring-line hover:text-fg"
                )}
              >
                {o.label}
                <span className="tabular text-xs text-fg-subtle">{open[o.value] ?? 0} open</span>
                {on && n > 0 && <span className="tabular text-xs">+{n}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <Button kind="primary" disabled={busy || given === 0} onClick={() => void onShare(plan)}>
        {given > 0
          ? `Share ${given} ${given === 1 ? "claim" : "claims"} among ${[...plan.values()].filter((a) => a.length > 0).length}`
          : "Choose who to share with"}
      </Button>
    </div>
  )
}

export function Breaches({ o }: { o: Overview }) {
  if (o.breaches.count === 0) return null
  return (
    <section aria-labelledby="breach-h" className="min-w-0">
      <SectionTitle id="breach-h">Waiting over {o.sla_days} days</SectionTitle>
      <ul className="mt-2 divide-y divide-line border-y border-line">
        {o.breaches.rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <Link to={`/papers/${r.id}`} className="font-medium tabular hover:underline">
                {r.ticket_number}
              </Link>{" "}
              <span className="block break-words text-fg-muted sm:inline">{r.owner_name}</span>
            </span>
            <span className="flex items-center gap-3">
              <AssigneeBadge assignee={r.assigned_to} empty="Not given to anyone" />
              <span className="tabular font-medium text-critical">{days(r.waiting_days)}</span>
            </span>
          </li>
        ))}
      </ul>
      {o.breaches.count > o.breaches.rows.length && (
        <Meta className="mt-1 block">and {o.breaches.count - o.breaches.rows.length} more, oldest first above.</Meta>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Research coordination                                                     */
/* ------------------------------------------------------------------------ */

type ResearchPayload = {
  fyp: {
    teams: number
    claimed: number
    academic_years: string[]
    mentors_unmatched: number
    departments: { department: string; teams: number; claimed: number }[]
  }
  watch: { count: number }
}

type ResearchFacultySummary = { year: string; count: number; unset_count: number; old_rule_count: number }

/**
 * The scheme rules the coordinator looks after: who is research faculty and
 * what threshold applies to them, the final-year project teams (one claim per
 * team, by the mentor), and the size of the journal watch-list.
 */
export function ResearchPanel() {
  const q = useApi<ResearchPayload>(["coordination", "research"], "/api/coordination/research")
  // The same request, and cache entry, as the research faculty page.
  const rf = useApi<ResearchFacultySummary>(["research-faculty"], "/api/research-faculty")
  if (q.isLoading) return <SkeletonRows rows={5} rowHeight={48} />
  if (q.isError || !q.data) {
    return <ErrorState title="Could not load the research coordination" message="The server did not answer. Nothing has been changed." onRetry={() => q.refetch()} />
  }
  const { fyp, watch } = q.data
  const departments = [...fyp.departments].sort((a, b) => b.teams - a.teams || a.department.localeCompare(b.department))
  const widest = Math.max(1, ...departments.map((d) => d.teams))
  const dept: Column<(typeof departments)[number]>[] = [
    { key: "department", header: "Department", cell: (d) => d.department },
    {
      key: "bar",
      header: "Teams claimed",
      className: "w-1/2",
      cell: (d) => (
        <span className="flex items-center gap-3">
          <span aria-hidden className="flex h-3 min-w-0 flex-1 overflow-hidden rounded-control bg-hover">
            <span className="block h-3 bg-accent" style={{ width: `${(d.claimed / widest) * 100}%` }} />
            <span className="block h-3 bg-fg-subtle/40" style={{ width: `${((d.teams - d.claimed) / widest) * 100}%` }} />
          </span>
          <span className="w-20 shrink-0 text-right tabular">
            {d.claimed} of {d.teams}
          </span>
        </span>
      ),
    },
    { key: "left", header: "Not claimed yet", align: "right", cell: (d) => (d.teams - d.claimed).toLocaleString("en-IN") },
  ]
  return (
    <div className="space-y-10">
      <Answer
        items={[
          { label: "Research faculty", value: rf.data?.count, to: "/research-faculty", zero: "No research faculty yet" },
          {
            label: "Research faculty with no threshold set",
            value: rf.data?.unset_count,
            to: "/research-faculty",
            zero: "Every threshold is set",
            tone: "caution",
          },
          { label: "Final-year project teams claimed", value: fyp.claimed, zero: "No team has claimed yet" },
          { label: "Journals on the watch-list", value: watch.count, to: "/journals", zero: "No journal is watched" },
        ]}
      />

      <Section
        title="Research faculty"
        sub={`Who is research faculty, and the yearly amount of their incentives that is not paid${rf.data ? ` (${rf.data.year})` : ""}. The threshold is set on the research faculty page; who is research faculty is ticked on the person's own page.`}
        action={
          <Link to="/research-faculty" className="font-medium text-accent underline underline-offset-2">
            Open the research faculty list
          </Link>
        }
      >
        <p className="text-base">
          {rf.isLoading
            ? "Loading the count."
            : rf.data
              ? rf.data.count === 0
                ? "No one is marked as research faculty yet. Tick it on a person's own page, then set their threshold here."
                : `${rf.data.count.toLocaleString("en-IN")} ${rf.data.count === 1 ? "person is" : "people are"} research faculty. ${
                  rf.data.unset_count > 0
                    ? `${rf.data.unset_count.toLocaleString("en-IN")} still ${rf.data.unset_count === 1 ? "has" : "have"} no threshold set for ${rf.data.year}.`
                    : `Every threshold is set for ${rf.data.year}.`
                }`
              : "The count could not be loaded. Open the list to see it."}
        </p>
      </Section>

      <Section
        title="Final-year project teams"
        sub="One claim per team, filed by the mentor. A team is claimed once a claim for it has been filed and not refused."
        action={
          <Link to="/imports" className="font-medium text-accent underline underline-offset-2">
            Load the team roster
          </Link>
        }
      >
        {fyp.teams > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
            <Stat label="Teams" value={fyp.teams} note={fyp.academic_years.length ? fyp.academic_years.join(", ") : undefined} />
            <Stat label="Claimed" value={fyp.claimed} />
            <Stat label="Not claimed yet" value={fyp.teams - fyp.claimed} />
            <Stat label="Mentor has no account" value={fyp.mentors_unmatched} tone={fyp.mentors_unmatched > 0 ? "caution" : undefined} />
          </div>
        )}
        {departments.length === 0 ? (
          <EmptyState
            art="empty-queue"
            title="No teams loaded"
            message="Load the roster workbook to see the teams here."
            action={
              <Button kind="default" size="sm" asChild>
                <Link to="/imports">Load the team roster</Link>
              </Button>
            }
          />
        ) : (
          <Table rows={departments} columns={dept} getKey={(d) => d.department} maxHeight="none" caption="Final-year project teams by department" />
        )}
      </Section>

      <Section
        title="Journal watch-list"
        sub="Journals the research office looks at twice. The list, with why each is watched and the claims it touches, is on Journals."
        action={
          <Link to="/journals" className="font-medium text-accent underline underline-offset-2">
            Open Journals
          </Link>
        }
      >
        <p className="text-base">
          {watch.count === 0
            ? "No journal is being watched."
            : `${watch.count.toLocaleString("en-IN")} ${watch.count === 1 ? "journal is" : "journals are"} being watched.`}
        </p>
      </Section>
    </div>
  )
}
