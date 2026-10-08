import { Link } from "react-router-dom"
import { AlertTriangle, Copy, Flag, Newspaper, UserRound, Users } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { cn } from "@/lib/cn"
import { ClaimNo, ClaimNoLegend, daysText, useHashScroll, Waited } from "@/pages/cell/parts"
import { HomeTrack } from "@/pages/home-track"
import { ComingUpEvents } from "@/pages/home-events"
import { fromBefore, greeting, QueueRow, Waiting, YourPapers } from "@/pages/home-staff"
import { AskTheData } from "@/pages/insights-link"
import { homeTrack } from "@/app/home-data"
import type { QueueClaim } from "@/pages/clearing-actions"
import { isReady } from "@/pages/cell/clearing-rows"
import type { TrackPayload, TrackStage } from "@/pages/track-data"
import { PageHeader } from "@/ui/page-header"
import { AnswerLine, AnswerWord } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Avatar, initialsOf } from "@/ui/person"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"

/**
 * The first desk's Home (research cell and research coordinator).
 *
 * One question: what do I do first today? The top answers it in four figures
 * (each a link to the list behind it) and one sentence about today's target.
 * The work follows: the claims given to me, then the oldest, then anything
 * that came back to the desk. Everything else the desk looks after is one
 * short list, and the whole-college picture is below the fold.
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
  const oldest = d ? Math.max(0, ...[...d.mine, ...d.rest].map((r) => r.waiting_days)) : 0

  const met = !!target && target.due > 0 && target.decided_by_desk >= target.due

  // "Came back" is a link to a place lower on this page.
  useHashScroll(!!d)

  return (
    <div className="page space-y-10">
      <PageHeader
        title={greeting(me?.name, me?.placeholder)}
        spot="spot-audit"
        action={
          <Button kind="primary" asChild>
            <Link to="/clearing">{d && d.desk_open > 0 ? `Open the queue (${d.desk_open.toLocaleString("en-IN")})` : "Open the queue"}</Link>
          </Button>
        }
      />

      {q.isError ? (
        <InlineError message="Could not load your desk. Nothing has changed." onRetry={() => void q.refetch()} />
      ) : (
        <>
          {/* The answer: what is late, then where the rest of the chain is
              stuck. Zero clicks (docs/ux/26, target T5). */}
          <div className="space-y-4">
            <AnswerLine>
              {!d ? (
                "What to do first today."
              ) : d.desk_open === 0 ? (
                "Nothing is waiting. The desk is clear."
              ) : d.past_sla > 0 ? (
                <>
                  {plural(d.past_sla, "claim is", "claims are")} <AnswerWord tone="crimson">past {sla} days</AnswerWord>.
                </>
              ) : (
                <>
                  {plural(d.desk_open, "claim is", "claims are")} waiting, <AnswerWord tone="sage">none late</AnswerWord>.
                </>
              )}
              {down && (
                <>
                  {" "}
                  {down}
                </>
              )}
            </AnswerLine>
            {d && d.desk_open > 0 && (
              <p className="max-w-[40rem] text-lead text-fg-muted">
                {readyN > 0 ? (
                  <>
                    <Link to="/clearing" className="text-accent underline underline-offset-4">
                      {plural(readyN, "claim is", "claims are")} ready
                    </Link>{" "}
                    to clear in one pass.{" "}
                  </>
                ) : null}
                {d.mine_count > 0 ? (
                  <Link to="/clearing?assigned=me" className="text-accent underline underline-offset-4">
                    {plural(d.mine_count, "is", "are")} given to you.
                  </Link>
                ) : null}{" "}
                {coordinator && d.unassigned > 0 ? (
                  <Link to="/coordination" className="text-accent underline underline-offset-4">
                    {plural(d.unassigned, "is", "are")} not given to anyone.
                  </Link>
                ) : null}
                {oldest > 0 && <> The oldest has waited {daysText(oldest)}.</>}
              </p>
            )}
          </div>

          <HomeTrack />

          <AskTheData about="A question about the papers or the claims? Ask it in plain English." />

          {target && d && d.desk_open > 0 && (
            <p className="max-w-3xl text-base" role="status">
              <span className="font-medium">Today&rsquo;s target:</span>{" "}
              {target.due === 0
                ? `nothing is close to ${sla} days. Keep the oldest moving.`
                : `decide ${plural(target.due, "claim", "claims")} that ${target.due === 1 ? "is" : "are"} past ${sla} days or reach it today.`}{" "}
              <span className={cn(met ? "text-positive" : "text-fg-muted")}>
                You have decided {target.decided_by_me.toLocaleString("en-IN")} today, the desk {target.decided_by_desk.toLocaleString("en-IN")}
                {met ? ". Target met." : "."}
              </span>
            </p>
          )}
        </>
      )}

      {/* The work: mine first, then the oldest. */}
      {d && d.mine.length > 0 && (
        <Waiting>
          <ListHead title="Given to you" note={`${d.mine_count} ${d.mine_count === 1 ? "claim" : "claims"}, oldest first`} to="/clearing?assigned=me" toLabel="Open all" />
          <DeskList rows={d.mine} sla={sla} />
        </Waiting>
      )}

      <Waiting>
        <ListHead
          title={d && d.mine.length > 0 ? "Oldest waiting, not given to you" : "Oldest waiting"}
          note={d && d.desk_open > 0 ? `Showing ${(d.rest.length).toLocaleString("en-IN")} of ${(d.desk_open - d.mine_count).toLocaleString("en-IN")}` : undefined}
          to="/clearing"
          toLabel={d && d.desk_open > 0 ? `Open the queue (${d.desk_open.toLocaleString("en-IN")})` : "Open the queue"}
        />
        {q.isLoading ? (
          <ul className="divide-y divide-line">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="h-[3.75rem] skeleton" />
            ))}
          </ul>
        ) : d && d.rest.length === 0 ? (
          <div className="border-y border-line py-6">
            <p className="text-base text-fg-muted">
              Nothing else is waiting. A claim appears here the moment a claimant files it. Your own papers are cleared by another officer, never by you.
            </p>
          </div>
        ) : d ? (
          <>
            <DeskList rows={d.rest} sla={sla} />
            <ClaimNoLegend show={[...d.mine, ...d.rest].some((r) => !!r.origin)} />
          </>
        ) : null}
      </Waiting>

      {/* What came back: a claim the claimant fixed, or the Principal returned. */}
      <section id="came-back" aria-labelledby="came-back-h" className="scroll-mt-6 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <SectionTitle>
            <span id="came-back-h">Came back to the desk</span>
          </SectionTitle>
          {d && d.came_back_count > 0 && <Meta>{plural(d.came_back_count, "claim", "claims")}, newest first</Meta>}
        </div>
        {q.isLoading ? (
          <Skeleton className="h-14 w-full" />
        ) : d && d.came_back.length === 0 ? (
          <p className="text-base text-fg-muted">
            Nothing has come back. A claim shows here when a claimant fixes one you sent back, or the Principal returns one with a reason.
          </p>
        ) : d ? (
          <ul className="divide-y divide-line">
            {d.came_back.map((r) => (
              <li key={r.id} className="row grid grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 py-3 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-2">
                <Avatar
                  size="md"
                  person={{ name: r.owner_name, initials: r.owner_initials ?? initialsOf(r.owner_name), photo_url: r.owner_photo_url ?? null }}
                />
                <div className="min-w-0">
                  <Link to={`/review/${r.id}?queue=clearing`} className="line-clamp-2 break-words text-base font-medium underline-offset-4 hover:underline">
                    {paperTitle(r.paper_title)}
                  </Link>
                  <Meta className="block truncate">
                    {[r.owner_name, r.owner_department].filter(Boolean).join(" · ")} · <ClaimNo ticket={r.ticket_number} origin={r.origin} />
                  </Meta>
                  <p className="mt-1 text-sm">
                    <span className={cn("font-medium", r.kind === "fixed" ? "text-positive" : "text-caution")}>
                      {r.kind === "fixed" ? "Fixed by the claimant" : `Returned by ${r.by_name ?? "the Principal"}`}
                    </span>
                    <span className="text-fg-muted"> · {r.since_days === 0 ? "today" : `${daysText(r.since_days)} ago`}</span>
                  </p>
                  {r.note && (
                    <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">
                      {r.kind === "fixed" ? "You asked: " : "Reason: "}
                      {r.note}
                    </p>
                  )}
                </div>
                <Button size="sm" asChild className="col-start-2 justify-self-start sm:col-start-auto">
                  <Link to={`/review/${r.id}?queue=clearing`} aria-label={`Review again: ${paperTitle(r.paper_title)}`}>
                    Review again
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {coordinator && overview.data && overview.data.reviewers.length > 0 && (
        <section aria-labelledby="who-h" className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <SectionTitle>
              <span id="who-h">Who holds what</span>
            </SectionTitle>
            <Link to="/coordination" className="text-sm text-accent underline-offset-4 hover:underline">
              Open Coordination
            </Link>
          </div>
          <ul className="divide-y divide-line">
            {overview.data.reviewers.slice(0, 5).map((r) => (
              <li key={r.user_id} className="flex items-center gap-3 py-2.5 sm:px-2">
                <Avatar size="sm" person={{ name: r.name, initials: r.initials ?? initialsOf(r.name), photo_url: r.photo_url ?? null }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">{r.name}</span>
                  <Meta className="block truncate">
                    {r.role_label} · {plural(r.cleared_this_week, "claim", "claims")} cleared this week
                  </Meta>
                </span>
                <span className="shrink-0 text-base tabular">
                  <span className="font-semibold">{r.open.toLocaleString("en-IN")}</span> <span className="text-fg-muted">open</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Everything else the desk looks after, one line each. */}
      <section aria-labelledby="else-h" className="space-y-1">
        <SectionTitle>
          <span id="else-h">Also needs a look</span>
        </SectionTitle>
        <ul className="divide-y divide-line">
          <QueueRow
            icon={Flag}
            label="Open flags"
            count={d ? d.flags.open - (d.flags.legacy ?? 0) : null}
            detail={d ? fromBefore(d.flags.legacy ?? 0, "Questions on claims not yet paid") : undefined}
            to="/flags"
            loading={q.isLoading}
          />
          <QueueRow
            icon={Newspaper}
            label="Watched journals with claims waiting"
            count={d?.watched_waiting ?? null}
            detail="Look at the journal before you clear the claim"
            to="/journals"
            tone="caution"
            loading={q.isLoading}
          />
          <QueueRow
            icon={Copy}
            label="Possible duplicate payments"
            count={duplicates.data ? (duplicates.data.summary.open_actionable ?? duplicates.data.summary.open) : null}
            detail={fromBefore(duplicates.data?.summary.open_legacy ?? 0, "The same paper may have been paid twice")}
            to="/duplicates"
            loading={duplicates.isLoading}
          />
          <QueueRow
            icon={UserRound}
            label="Profile corrections"
            count={requests.data?.pending ?? null}
            detail="Faculty asked for a change to their record"
            to="/requests"
            loading={requests.isLoading}
          />
          <QueueRow
            icon={AlertTriangle}
            label="Faults"
            count={faults.data ? (faults.data.actionable ?? faults.data.total) : null}
            detail={fromBefore(faults.data?.legacy ?? 0, "Things the system could not finish")}
            to="/faults"
            loading={faults.isLoading}
          />
          {coordinator && (
            <QueueRow icon={Users} label="Final-year project teams" count={null} detail="Teams, mentors and claims" to="/coordination?tab=research" />
          )}
        </ul>
      </section>

      {d && (
        <section aria-labelledby="month-h" className="space-y-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <SectionTitle>
              <span id="month-h">{monthName(d.month.month)} so far</span>
            </SectionTitle>
            <Link to="/coordination?tab=report" className="text-sm text-accent underline-offset-4 hover:underline">
              Monthly report
            </Link>
          </div>
          <p className="max-w-3xl text-base text-fg-muted">
            {plural(d.month.received, "claim", "claims")} came in. {d.month.cleared.toLocaleString("en-IN")} cleared, {d.month.sent_back.toLocaleString("en-IN")} sent back, {d.month.not_accepted.toLocaleString("en-IN")} not accepted.{" "}
            {d.month.decided > 0
              ? `${d.month.within_week.toLocaleString("en-IN")} of ${d.month.decided.toLocaleString("en-IN")} decisions took a week or less${d.month.median_days != null ? `, median ${d.month.median_days} days` : ""}.`
              : "Nothing has been decided yet this month."}
          </p>
        </section>
      )}

      <ComingUpEvents />

      {can(me?.role).fileOwnPapers && <YourPapers />}
    </div>
  )
}

function ListHead({ title, note, to, toLabel }: { title: string; note?: string; to: string; toLabel: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <SectionTitle>{title}</SectionTitle>
        {note && <Meta>{note}</Meta>}
      </div>
      <Link to={to} className="text-sm text-accent underline-offset-4 hover:underline">
        {toLabel}
      </Link>
    </div>
  )
}

/** Claims at the desk as rows: face, paper, who and where from, days, next action. */
function DeskList({ rows, sla }: { rows: DeskRow[]; sla: number }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li
          key={r.id}
          className="row grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-3 sm:grid-cols-[2.5rem_minmax(0,1fr)_5rem_auto] sm:gap-x-4 sm:px-2"
        >
          <Avatar
            size="md"
            person={{ name: r.owner_name, initials: r.owner_initials ?? initialsOf(r.owner_name), photo_url: r.owner_photo_url ?? null }}
          />
          <div className="min-w-0">
            <Link to={`/review/${r.id}?queue=clearing`} className="line-clamp-2 break-words text-base font-medium underline-offset-4 hover:underline sm:line-clamp-1">
              {paperTitle(r.paper_title)}
            </Link>
            <Meta className="block truncate">
              {[r.owner_name, r.owner_department].filter(Boolean).join(" · ")} · <ClaimNo ticket={r.ticket_number} origin={r.origin} />
            </Meta>
            {(r.watched_reason || r.on_hold || r.assigned_to) && (
              <Meta className="block truncate text-xs">
                {r.watched_reason && (
                  <span className="font-medium text-caution" title={r.watched_reason}>
                    Watched journal
                  </span>
                )}
                {r.watched_reason && (r.on_hold || r.assigned_to) && " · "}
                {r.on_hold && <span className="text-caution">On hold</span>}
                {r.on_hold && r.assigned_to && " · "}
                {r.assigned_to && `Given to ${r.assigned_to.name}`}
              </Meta>
            )}
          </div>
          <div className="col-start-2 flex items-center justify-between gap-3 sm:contents">
            <Waited days={r.waiting_days} sla={sla} className="w-20 shrink-0 max-sm:text-left" />
            <Button size="sm" asChild className="shrink-0">
              <Link to={`/review/${r.id}?queue=clearing`} aria-label={`Review: ${paperTitle(r.paper_title)}`}>
                Review
              </Link>
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}
