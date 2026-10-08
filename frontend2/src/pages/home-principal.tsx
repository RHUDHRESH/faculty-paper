import { Link } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { HOME_DATA, homeTrack } from "@/app/home-data"
import { firstName } from "@/lib/names"
import { useApi } from "@/lib/query"
import { AnswerLine } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ComingUp } from "@/ui/coming-up"
import { PageHeader } from "@/ui/page-header"
import { Plate } from "@/ui/plate"
import { money } from "@/ui/paper"
import { reviewLink, waitingLabel } from "@/ui/queue"
import { Rows, Section } from "@/ui/section"
import { InlineError, SkeletonRows } from "@/ui/state"
import type { QueuePayload } from "@/pages/approvals-actions"
import { ComingUpEvents } from "@/pages/home-events"
import { YourPapers } from "@/pages/home-staff"
import { AskTheData } from "@/pages/insights-link"
import type { Brief } from "@/pages/principal-parts"
import { ApprovalRow } from "@/pages/principal/approval-row"
import { isReady } from "@/pages/principal/ready"
import { useApprovals } from "@/pages/principal/use-approvals"
import { YearColumn } from "@/pages/principal/year-column"
import type { TrackPayload } from "@/pages/track-data"

/**
 * The Principal's Home (docs/ux/27, concept A: the morning sheet).
 *
 * She opens it for two things and neither may cost a click or a scroll. The
 * first is the desk: is there anything for me to approve, and is any of it
 * wrong? The page's answer is one sentence in the biggest type on the screen,
 * with the primary button doing the common thing (approving what is ready) in
 * place. The second is "are we better than last year, and where?", which sits
 * in the margin as one finding, five honest columns and the departments to
 * call, so it is answered on the first screen without being made equal to the
 * desk. When the desk is empty the sentence turns to the year, because that is
 * the one thing left worth reading (peak-end).
 *
 * The pipeline below her is one line and a link to Track: it is not hers to
 * work. Her own papers stay last; another officer decides them.
 */

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`

function dayPart(d = new Date()): string {
  const h = d.getHours()
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"
}

/** "Good morning, Dr. Vijaya": her title is kept, because she is addressed by it. */
function salutation(name: string | undefined): string {
  const first = firstName(name)
  const title = /^(Dr|Prof)\b\.?/i.exec((name || "").trim())?.[0].replace(/\.?$/, ".")
  return `${dayPart()}${first ? `, ${title ? `${title} ` : ""}${first}` : ""}`
}

export function PrincipalHome() {
  const { me } = useAuth()
  const queue = useApi<QueuePayload>(HOME_DATA.principalQueue.key, HOME_DATA.principalQueue.path)
  const brief = useApi<Brief>(HOME_DATA.principalBrief.key, HOME_DATA.principalBrief.path)
  const mine = homeTrack(me?.role)
  const track = useApi<TrackPayload>(mine.key, mine.path)

  const rows = queue.data?.results ?? []
  const ready = rows.filter(isReady)
  const ap = useApprovals({ rows })

  const waiting = queue.data ? (queue.data.totals?.count ?? rows.length) : null
  const amount = queue.data?.totals?.amount ?? 0
  const longest = queue.data?.totals?.longest_wait_days ?? null
  const b = brief.data
  const late = track.data ? track.data.stages.reduce((sum, s) => sum + (s.ageing?.older ?? 0), 0) : null

  // The answer. Waiting claims come first; when none are, the year.
  const answer =
    waiting == null ? (
      "What waits for you today."
    ) : waiting > 0 ? (
      <>
        {plural(waiting, "claim", "claims")}, {money(amount)}, {waiting === 1 ? "is" : "are"} waiting for you.
      </>
    ) : (
      "Nothing is waiting for you."
    )

  const action =
    waiting != null && waiting > 0 ? (
      ready.length > 0 ? (
        <Button kind="primary" onClick={() => ap.approveBatch(ready)} disabled={ap.busy}>
          Approve the {ready.length} ready
        </Button>
      ) : (
        <Button kind="primary" asChild>
          <Link to="/approvals">Open Approvals</Link>
        </Button>
      )
    ) : undefined

  return (
    <div className="page space-y-14">
      <PageHeader title={me?.placeholder ? dayPart() : salutation(me?.name)} action={action} />

      {/* The answer and the desk's print side by side, so the page is not spent
          on a header that is only a picture's height. */}
      <div className="-mt-9 flex items-start justify-between gap-10">
        <div className="min-w-0 space-y-4">
        <AnswerLine>{answer}</AnswerLine>
        {waiting != null && waiting > 0 && (
          <p className="max-w-[40rem] text-lead text-fg-muted">
            {ready.length === rows.length ? (
              <>All {rows.length} are ready: no flag, no duplicate, an amount worked out.</>
            ) : (
              <>
                {plural(ready.length, "is", "are")} ready; {plural(rows.length - ready.length, "needs", "need")} a look first.
              </>
            )}
            {longest != null && (
              <>
                {" "}
                The longest has waited{" "}
                <span className={longest > 30 ? "font-medium text-critical" : undefined}>{waitingLabel(longest).toLowerCase()}</span>.
              </>
            )}
          </p>
        )}
        {waiting === 0 && <ComingUp desk="principal" align="start" />}
        </div>
        <Plate name="spot-approvals" width={120} eager className="mt-2 hidden sm:block" />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-14 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-14">
          {queue.isError ? (
            <InlineError message="Could not load the approval queue. Nothing has changed." onRetry={() => queue.refetch()} />
          ) : queue.isLoading ? (
            <SkeletonRows rows={4} rowHeight={76} />
          ) : rows.length > 0 ? (
            <Section
              title="Waiting for you"
              action={
                <Button kind="default" size="sm" asChild>
                  <Link to="/approvals">Open Approvals ({(waiting ?? rows.length).toLocaleString("en-IN")})</Link>
                </Button>
              }
            >
              <Rows>
                {rows.slice(0, 6).map((c) => (
                  <ApprovalRow
                    key={c.id}
                    claim={c}
                    compact
                    me={me?.id}
                    ready={isReady(c)}
                    href={reviewLink(c.id, "approvals")}
                    onApprove={() => ap.approveOne(c)}
                  />
                ))}
              </Rows>
              {rows.length > 6 && <p className="mt-2 px-2 text-sm text-fg-muted">{rows.length - 6} more in Approvals.</p>}
            </Section>
          ) : null}

          <p className="text-base text-fg-muted" role="status">
            {late == null
              ? ""
              : late > 0
                ? `${late.toLocaleString("en-IN")} ${late === 1 ? "claim has" : "claims have"} been in one place for over a month. `
                : "Nothing has been in one place for over a month. "}
            <Button kind="default" size="sm" asChild className="ml-1 align-middle">
              <Link to="/track">Open Track</Link>
            </Button>
          </p>

          <AskTheData about="A question these figures do not answer? Ask it in plain English." />
        </div>

        <aside aria-label="The year" className="min-w-0 lg:border-l lg:border-line lg:pl-10">
          <YearColumn b={b} isError={brief.isError} onRetry={() => brief.refetch()} />
        </aside>
      </div>

      <ComingUpEvents />

      <YourPapers />

      {ap.node}
    </div>
  )
}
