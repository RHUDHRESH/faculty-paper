import { Link } from "react-router-dom"

import { can, useAuth } from "@/app/auth"
import { HOME_DATA, homeTrack } from "@/app/home-data"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { ClaimNo, ClaimNoLegend, daysText, useHashScroll, Waited } from "@/pages/cell/parts"
import { ComingUpEvents } from "@/pages/home-events"
import { fromBefore, greeting, YourPapers } from "@/pages/home-staff"
import { AskTheData } from "@/pages/insights-link"
import type { QueueClaim } from "@/pages/clearing-actions"
import { isReady } from "@/pages/cell/clearing-rows"
import type { TrackPayload, TrackStage } from "@/pages/track-data"
import { PageHeader } from "@/ui/page-header"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Section } from "@/ui/section"
import { InlineError } from "@/ui/state"
import { Table, type Column } from "@/ui/table"

/**
 * The first desk's Home (research cell and research coordinator).
 *
 * One question: what do I do first today? Four figures answer it (waiting,
 * ready, sent back, late), each a link to the list behind it. One table lists
 * what needs the desk, oldest first, claims that came back included, with a
 * Review button on each. The one primary button clears the ready claims.
 *
 * Server: /api/cell/today (backend/core/api/research_cell.py). The counts
 * here are the same numbers /coordination and /clearing print, because all
 * three come from the same waiting-days rule.
 */

type Assignee = { user_id: string; name: string } | null

type DeskRow = {
  id: string
  ticket_number: string | null
  origin: string | null
  paper_title: string
  journal_title: string | null
  owner_id: string
  owner_name: string
  owner_department: string | null
  owner_photo_url?: string | null
  owner_initials?: string
  waiting_days: number
  on_hold: boolean
  watched_reason: string | null
  assigned_to: Assignee
}

type BackRow = DeskRow & {
  kind: "fixed" | "returned"
  since_days: number
  note: string | null
  by_name: string | null
}

type Today = {
  sla_days: number
  desk_open: number
  mine_count: number
  unassigned: number
  past_sla: number
  held: number
  target: { due: number; past: number; due_soon: number; decided_by_me: number; decided_by_desk: number }
  mine: DeskRow[]
  rest: DeskRow[]
  came_back: BackRow[]
  came_back_count: number
  watched_waiting: number
  flags: { open: number; open_on_paid: number; legacy?: number }
  month: {
    month: string
    received: number
    cleared: number
    sent_back: number
    not_accepted: number
    median_days: number | null
    within_week: number
    decided: number
  }
}

type Overview = {
  reviewers: { user_id: string; name: string; role_label: string; open: number; cleared_this_week: number; photo_url?: string | null; initials?: string }[]
}

/** One line of the main table: a claim waiting, or one that came back. */
type Item = DeskRow & { back?: BackRow }

const MAX_ROWS = 10

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`

const DESK_OF: Record<string, string> = { checked: "the Principal", approved: "the Director", authorised: "Finance" }

/** Where the chain below this desk is held up, in one clause: the desk with the
 *  most claims past two weeks, else the one with the most claims. Empty when
 *  nothing is waiting below. Counts only, as the role rules require. */
function downstream(stages: TrackStage[] | undefined): string {
  if (!stages) return ""
  const rows = stages
    .filter((s) => DESK_OF[s.key] && s.count > 0)
    .map((s) => ({ s, late: (s.ageing?.month ?? 0) + (s.ageing?.older ?? 0) }))
  if (rows.length === 0) return ""
  rows.sort((a, b) => b.late - a.late || b.s.count - a.s.count)
  const { s, late } = rows[0]
  const n = s.count.toLocaleString("en-IN")
  return `${n} ${s.count === 1 ? "is" : "are"} waiting for ${DESK_OF[s.key]}${late > 0 ? `, ${late.toLocaleString("en-IN")} over two weeks` : ""}.`
}

function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("en-IN", { month: "long" })
}

/** What the claim is doing at the desk, in words: it came back, or why it is flagged. */
function statusText(r: Item, meId: string | undefined): string {
  if (r.back) {
    const who = r.back.kind === "fixed" ? "Fixed by the claimant" : `Returned by ${r.back.by_name ?? "the Principal"}`
    return `${who}, ${r.back.since_days === 0 ? "today" : `${daysText(r.back.since_days)} ago`}`
  }
  const parts = [
    r.watched_reason ? "Watched journal" : "",
    r.on_hold ? "On hold" : "",
    r.assigned_to ? (r.assigned_to.user_id === meId ? "Given to you" : `Given to ${r.assigned_to.name}`) : "",
  ].filter(Boolean)
  return parts.join(", ") || "Waiting"
}

export function CellHome() {
  const { me } = useAuth()
  const coordinator = me?.role === "RESEARCH_COORDINATOR"
  // Keyed under "clearing-queue" so a decision made anywhere refreshes this.
  const q = useApi<Today>(["clearing-queue", "cell-today"], "/api/cell/today")
  const d = q.data

  const requests = useApi<{ pending: number }>(HOME_DATA.pendingRequests.key, HOME_DATA.pendingRequests.path)
  const duplicates = useApi<{ summary: { open: number; open_actionable?: number; open_legacy?: number } }>(HOME_DATA.openDuplicates.key, HOME_DATA.openDuplicates.path)
  const faults = useApi<{ total: number; actionable?: number; legacy?: number }>(HOME_DATA.faults.key, HOME_DATA.faults.path)
  const overview = useApi<Overview>(["coordination", "overview"], "/api/coordination/overview", { enabled: coordinator })

  // The same two requests the strip and the queue make, so nothing is asked twice.
  const track = homeTrack(me?.role)
  const tq = useApi<TrackPayload>(track.key, track.path)
  const queue = useApi<QueueClaim[]>(["clearing-queue"], "/api/admin/clearing-queue?status=SUBMITTED")
  const readyN = (queue.data ?? []).filter(isReady).length
  const down = downstream(tq.data?.stages)

  const sla = d?.sla_days ?? 14
  const target = d?.target
  const met = !!target && target.due > 0 && target.decided_by_desk >= target.due

  // The KPI "Sent back" is a link to the table below it.
  useHashScroll(!!d)

  // Claims that came back first, then everything waiting, oldest first.
  const items: Item[] = []
  if (d) {
    const seen = new Set<string>()
    for (const b of d.came_back) {
      seen.add(b.id)
      items.push({ ...b, back: b })
    }
    const waiting = [...d.mine, ...d.rest].filter((r) => !seen.has(r.id)).sort((a, b) => b.waiting_days - a.waiting_days)
    items.push(...waiting)
  }
  const rows = items.slice(0, MAX_ROWS)

  const columns: Column<Item>[] = [
    {
      key: "paper",
      header: "Claim",
      exportValue: (r) => paperTitle(r.paper_title),
      cell: (r) => (
        <Link to={`/review/${r.id}?queue=clearing`} className="break-words font-medium text-fg underline-offset-4 hover:underline">
          {paperTitle(r.paper_title)}
        </Link>
      ),
    },
    {
      key: "owner",
      header: "Claimant",
      exportValue: (r) => [r.owner_name, r.owner_department].filter(Boolean).join(", "),
      cell: (r) => [r.owner_name, r.owner_department].filter(Boolean).join(", "),
    },
    {
      key: "number",
      header: "Claim number",
      exportValue: (r) => r.ticket_number ?? "",
      cell: (r) => <ClaimNo ticket={r.ticket_number} origin={r.origin} />,
    },
    {
      key: "status",
      header: "Status",
      exportValue: (r) => statusText(r, me?.id),
      cell: (r) => (
        <span>
          {r.back ? (
            <>
              <span className={r.back.kind === "fixed" ? "font-medium text-positive" : "font-medium text-caution"}>
                {r.back.kind === "fixed" ? "Fixed by the claimant" : `Returned by ${r.back.by_name ?? "the Principal"}`}
              </span>
              <span className="text-fg-muted">, {r.back.since_days === 0 ? "today" : `${daysText(r.back.since_days)} ago`}</span>
              {r.back.note && (
                <span className="block text-sm text-fg-muted">
                  {r.back.kind === "fixed" ? "You asked: " : "Reason: "}
                  {r.back.note}
                </span>
              )}
            </>
          ) : (
            <>
              {r.watched_reason && (
                <span className="font-medium text-caution" title={r.watched_reason}>
                  Watched journal
                </span>
              )}
              {r.watched_reason && (r.on_hold || r.assigned_to) && ", "}
              {r.on_hold && <span className="text-caution">On hold</span>}
              {r.on_hold && r.assigned_to && ", "}
              {r.assigned_to && (r.assigned_to.user_id === me?.id ? "Given to you" : `Given to ${r.assigned_to.name}`)}
              {!r.watched_reason && !r.on_hold && !r.assigned_to && <span className="text-fg-muted">Waiting</span>}
            </>
          )}
        </span>
      ),
    },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      exportValue: (r) => r.waiting_days,
      cell: (r) => <Waited days={r.waiting_days} sla={sla} />,
    },
    {
      key: "action",
      header: "Action",
      label: "Review",
      cell: (r) => (
        <Button kind="default" size="sm" asChild>
          <Link
            to={`/review/${r.id}?queue=clearing`}
            aria-label={`${r.back ? "Review again" : "Review"}: ${paperTitle(r.paper_title)}`}
          >
            {r.back ? "Review again" : "Review"}
          </Link>
        </Button>
      ),
    },
  ]

  type Also = { key: string; label: string; detail: string; to: string; count: number | null; loading: boolean }
  const also: Also[] = [
    {
      key: "flags",
      label: "Open flags",
      detail: d ? fromBefore(d.flags.legacy ?? 0, "Questions on claims not yet paid") : "Questions on claims not yet paid",
      to: "/flags",
      count: d ? d.flags.open - (d.flags.legacy ?? 0) : null,
      loading: q.isLoading,
    },
    {
      key: "journals",
      label: "Watched journals with claims waiting",
      detail: "Look at the journal before you clear the claim",
      to: "/journals",
      count: d?.watched_waiting ?? null,
      loading: q.isLoading,
    },
    {
      key: "duplicates",
      label: "Possible duplicate payments",
      detail: fromBefore(duplicates.data?.summary.open_legacy ?? 0, "The same paper may have been paid twice"),
      to: "/duplicates",
      count: duplicates.data ? (duplicates.data.summary.open_actionable ?? duplicates.data.summary.open) : null,
      loading: duplicates.isLoading,
    },
    {
      key: "requests",
      label: "Profile corrections",
      detail: "Faculty asked for a change to their record",
      to: "/requests",
      count: requests.data?.pending ?? null,
      loading: requests.isLoading,
    },
    {
      key: "faults",
      label: "Faults",
      detail: fromBefore(faults.data?.legacy ?? 0, "Things the system could not finish"),
      to: "/faults",
      count: faults.data ? (faults.data.actionable ?? faults.data.total) : null,
      loading: faults.isLoading,
    },
  ]
  if (coordinator) {
    also.push({ key: "projects", label: "Final-year project teams", detail: "Teams, mentors and claims", to: "/coordination?tab=research", count: null, loading: false })
  }

  const alsoColumns: Column<Also>[] = [
    {
      key: "label",
      header: "Item",
      exportValue: (r) => r.label,
      cell: (r) => (
        <Link to={r.to} className="font-medium text-fg underline-offset-4 hover:underline">
          {r.label}
        </Link>
      ),
    },
    { key: "detail", header: "What it is", exportValue: (r) => r.detail, cell: (r) => r.detail },
    {
      key: "count",
      header: "Count",
      align: "right",
      empty: "Open to see",
      exportValue: (r) => r.count,
      cell: (r) => (r.loading ? "Loading" : r.count === null ? "" : formatCount(r.count)),
    },
  ]

  const reviewers = coordinator ? (overview.data?.reviewers ?? []).slice(0, 5) : []
  const holdColumns: Column<NonNullable<Overview["reviewers"]>[number]>[] = [
    { key: "name", header: "Reviewer", exportValue: (r) => r.name, cell: (r) => r.name },
    { key: "role", header: "Role", exportValue: (r) => r.role_label, cell: (r) => r.role_label },
    { key: "cleared", header: "Cleared this week", align: "right", exportValue: (r) => r.cleared_this_week, cell: (r) => formatCount(r.cleared_this_week) },
    { key: "open", header: "Open", align: "right", exportValue: (r) => r.open, cell: (r) => formatCount(r.open) },
  ]

  return (
    <div className="page space-y-8">
      <PageHeader
        title={greeting(me?.name, me?.placeholder)}
        sub="The claims waiting at your desk, oldest first."
        action={
          <Button kind="primary" asChild>
            <Link to="/clearing">
              {readyN > 0
                ? `Clear the ${formatCount(readyN)} ready`
                : d && d.desk_open > 0
                  ? `Open the queue (${d.desk_open.toLocaleString("en-IN")})`
                  : "Open the queue"}
            </Link>
          </Button>
        }
      />

      {q.isError ? (
        <InlineError message="Could not load your desk. Nothing has changed." onRetry={() => void q.refetch()} />
      ) : (
        <>
          <Answer
            items={[
              { value: d?.desk_open, label: "Waiting to clear", zero: "Nothing is waiting", to: "/clearing" },
              { value: queue.data ? readyN : undefined, label: "Ready to clear", zero: "None ready", to: "/clearing" },
              { value: d?.came_back_count, label: "Sent back to the desk", zero: "Nothing came back", to: "/#attention" },
              { value: d?.past_sla, label: `Late, past ${sla} days`, zero: "None late", to: "/clearing", tone: "critical" },
            ]}
          />
          {down && <p className="text-sm text-fg-muted">{down}</p>}

          <Section
            id="attention"
            title="What needs your attention"
            className="scroll-mt-6"
            action={
              <Link to="/clearing" className="text-sm text-accent underline-offset-4 hover:underline">
                {d && d.desk_open > 0 ? `View all ${d.desk_open.toLocaleString("en-IN")}` : "View all"}
              </Link>
            }
          >
            <Table
              rows={rows}
              columns={columns}
              getKey={(r) => r.id}
              tools={{ id: "cell-home", title: "What needs your attention" }}
              empty={
                q.isLoading ? (
                  <p className="py-6 text-base text-fg-muted">Loading the desk.</p>
                ) : (
                  <p className="py-6 text-base text-fg-muted">Nothing is waiting. The desk is clear.</p>
                )
              }
            />
            <ClaimNoLegend show={rows.some((r) => !!r.origin)} />
            {d && (d.mine_count > 0 || (coordinator && d.unassigned > 0)) && (
              <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {d.mine_count > 0 && (
                  <Link to="/clearing?assigned=me" className="text-accent underline-offset-4 hover:underline">
                    {plural(d.mine_count, "claim is", "claims are")} given to you
                  </Link>
                )}
                {coordinator && d.unassigned > 0 && (
                  <Link to="/coordination" className="text-accent underline-offset-4 hover:underline">
                    {plural(d.unassigned, "claim is", "claims are")} not given to anyone
                  </Link>
                )}
              </p>
            )}
            {target && d && d.desk_open > 0 && (
              <p className="mt-2 text-sm text-fg-muted" role="status">
                Today&rsquo;s target:{" "}
                {target.due === 0
                  ? `nothing is close to ${sla} days.`
                  : `decide ${plural(target.due, "claim", "claims")} past ${sla} days or reaching it today.`}{" "}
                You have decided {target.decided_by_me.toLocaleString("en-IN")} today, the desk{" "}
                {target.decided_by_desk.toLocaleString("en-IN")}
                {met ? ". Target met." : "."}
              </p>
            )}
          </Section>
        </>
      )}

      <Section title="Also needs a look">
        <Table rows={also} columns={alsoColumns} getKey={(r) => r.key} tools={{ id: "cell-home-also", title: "Also needs a look" }} />
      </Section>

      {reviewers.length > 0 && (
        <Section
          title="Who holds what"
          action={
            <Link to="/coordination" className="text-sm text-accent underline-offset-4 hover:underline">
              Open Coordination
            </Link>
          }
        >
          <Table rows={reviewers} columns={holdColumns} getKey={(r) => r.user_id} />
        </Section>
      )}

      {d && (
        <p className="text-sm text-fg-muted">
          {monthName(d.month.month)} so far: {plural(d.month.received, "claim", "claims")} came in, {d.month.cleared.toLocaleString("en-IN")} cleared,{" "}
          {d.month.sent_back.toLocaleString("en-IN")} sent back, {d.month.not_accepted.toLocaleString("en-IN")} not accepted.{" "}
          {d.month.decided > 0
            ? `${d.month.within_week.toLocaleString("en-IN")} of ${d.month.decided.toLocaleString("en-IN")} decisions took a week or less${d.month.median_days != null ? `, median ${d.month.median_days} days` : ""}.`
            : "Nothing has been decided yet this month."}{" "}
          <Link to="/coordination?tab=report" className="text-accent underline-offset-4 hover:underline">
            Monthly report
          </Link>
        </p>
      )}

      <AskTheData about="A question about the papers or the claims? Ask it in plain English." />

      <ComingUpEvents />

      {can(me?.role).fileOwnPapers && <YourPapers />}
    </div>
  )
}
