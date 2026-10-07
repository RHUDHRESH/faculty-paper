import { Link } from "react-router-dom"

import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Rows, Section } from "@/ui/section"
import { showcaseSentence, whenWords, type EventsSummary, type Highlights } from "@/pages/events-model"
import { CountdownChip, DateTile, GoingCount } from "@/pages/events-parts"

/**
 * Two small cards for Home, so seminars and the college's research are seen
 * by everybody who opens the app, not only by those who go to the Events page.
 *
 * Home is the page everybody lands on, so these are calm in the one way that
 * matters: when there is nothing to say, or the request fails, they draw
 * nothing at all. A "could not load" about seminars on that page would be
 * worse than no card.
 */

function useComingUp(): EventsSummary | null {
  const q = useApi<EventsSummary>(["events", "summary"], "/api/events/summary", { retry: false })
  return q.data && q.data.upcoming.length > 0 ? q.data : null
}

/** The month, in one sentence. Same key as the showcase's, so opening it is instant. */
function useCollegeMonth(): string | null {
  const q = useApi<Highlights>(["research", "highlights", "month", ""], "/api/research/highlights?period=month", {
    retry: false,
    staleTime: 5 * 60_000,
  })
  return q.data && !q.data.empty ? showcaseSentence(q.data) : null
}

function ComingUpCard({ data }: { data: EventsSummary }) {
  return (
    <Section
      title="Coming up"
      action={
        <Button kind="default" size="sm" asChild>
          <Link to="/events">All events</Link>
        </Button>
      }
    >
      <Rows>
        {data.upcoming.map((e) => (
          <li key={e.id}>
            <Link to={`/events?event=${e.id}`} className="row -mx-2 flex items-center gap-3 rounded-control px-2 py-3">
              <DateTile event={e} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 font-medium">{e.title}</span>
                <span className="line-clamp-1 text-sm text-fg-muted">{whenWords(e)}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <CountdownChip event={e} today={data.today} />
                <GoingCount event={e} />
              </span>
            </Link>
          </li>
        ))}
      </Rows>
    </Section>
  )
}

function CollegeMonthCard({ line }: { line: string }) {
  return (
    <Section
      title="In the college this month"
      action={
        <Link to="/events?view=research&period=month" className="text-accent underline-offset-4 hover:underline">
          See the research showcase
        </Link>
      }
    >
      <p className="max-w-prose text-base">{line}</p>
    </Section>
  )
}

/** The next three events, for every role's Home. Draws nothing when none are coming. */
export function ComingUpEvents() {
  const data = useComingUp()
  return data ? <ComingUpCard data={data} /> : null
}

/** One line on what the college published this month, with the way to the rest. Draws nothing when nothing is new. */
export function CollegeThisMonth() {
  const line = useCollegeMonth()
  return line ? <CollegeMonthCard line={line} /> : null
}

/**
 * Both, side by side, for a faculty member's Home: what is coming, and what
 * colleagues have published. When only one has something to say it is drawn
 * alone, and when neither does the row is not drawn, so it leaves no gap.
 */
export function EventsOnHome() {
  const coming = useComingUp()
  const month = useCollegeMonth()
  if (!coming && !month) return null
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-2">
      {coming && <ComingUpCard data={coming} />}
      {month && <CollegeMonthCard line={month} />}
    </div>
  )
}
