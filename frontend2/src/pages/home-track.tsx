import { Link } from "react-router-dom"

import { useAuth, type Role } from "@/app/auth"
import { homeTrack } from "@/app/home-data"
import { Thread, THREAD_STAGES, type ThreadStage } from "@/ui/thread"
import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import {
  claimHref,
  days,
  MAIN_STAGES,
  type TrackPayload,
  type TrackStage,
} from "@/pages/track-data"
import { Avatar, initialsOf } from "@/ui/person"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"

/**
 * "Is anything stuck?", for every office home, in one place.
 *
 * A strip of the stages with how many claims are in each, one sentence on
 * what has waited too long, and the five claims that have waited longest.
 * Every number opens Track at that stage, so the home never has to explain
 * itself: the answer is one click further, and it is the same answer.
 *
 * The strip and the list are one request (`/api/track?moving=1`), and the
 * server decides what this reader may see: no money for a head of
 * department, no flags for the Director or Finance.
 */




/** Claims sitting at a desk longer than a month, across the stages that have a desk. */
function overMonth(stages: TrackStage[]): number {
  return stages.reduce((n, s) => n + (s.ageing?.older ?? 0), 0)
}

/** The thread says "Filed"; Track's own key for that stage is "submitted". */
const trackKey = (k: ThreadStage): string => (k === "filed" ? "submitted" : k)

/** The station each desk works at (the same mapping as the sidebar badges). */
const THREAD_DESK: Partial<Record<Role, ThreadStage>> = {
  SUPER_ADMIN: "filed",
  RESEARCH_CELL: "filed",
  RESEARCH_COORDINATOR: "filed",
  PRINCIPAL: "checked",
  DIRECTOR: "approved",
  FINANCE: "authorised",
}

function threadCounts(stages: TrackStage[]): Partial<Record<ThreadStage, number>> {
  const by = new Map(stages.map((s) => [s.key, s]))
  return Object.fromEntries(THREAD_STAGES.map((s) => [s.key, by.get(trackKey(s.key))?.count ?? 0]))
}

/** Of each station's claims, how many have waited past the fortnight. */
function threadLate(stages: TrackStage[]): Partial<Record<ThreadStage, number>> {
  const by = new Map(stages.map((s) => [s.key, s]))
  return Object.fromEntries(
    THREAD_STAGES.map((s) => {
      const a = by.get(trackKey(s.key))?.ageing
      return [s.key, a ? a.month + a.older : 0]
    })
  )
}

export function HomeTrack({ heading = "Where everything is" }: { heading?: string }) {
  const { me } = useAuth()
  const mine = homeTrack(me?.role)
  const q = useApi<TrackPayload>(mine.key, mine.path)
  const data = q.data

  if (q.isError) {
    return <InlineError message="Could not load where the claims are." onRetry={() => void q.refetch()} />
  }

  const stages = data ? data.stages.filter((s) => MAIN_STAGES.includes(s.key)) : []
  const late = data ? overMonth(data.stages) : 0
  const rows = data?.results ?? []

  return (
    <section aria-labelledby="home-track" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <SectionTitle>
          <span id="home-track">{heading}</span>
        </SectionTitle>
        <Link to="/track" className="text-sm text-accent underline-offset-4 hover:underline">
          Open Track
        </Link>
      </div>

      {q.isLoading || !data ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <>
          {/* The thread: five stations, the claims at each as dots, this
              reader's desk ringed. Same numbers as the strip it replaced
              (`/api/track`), so Track and Home agree. */}
          <Thread
            counts={threadCounts(stages)}
            you={me?.role ? THREAD_DESK[me.role] : undefined}
            to={Object.fromEntries(THREAD_STAGES.map((s) => [s.key, `/track?stage=${trackKey(s.key)}`]))}
            late={threadLate(stages)}
            caption="Each dot is a claim. Amber has waited over two weeks."
          />

          <p className={cn("text-base", late > 0 ? "text-fg" : "text-fg-muted")} role="status">
            {late > 0
              ? `${late.toLocaleString("en-IN")} ${late === 1 ? "claim has" : "claims have"} been in one place for over a month.`
              : "Nothing has been in one place for over a month."}
          </p>

          {rows.length > 0 && (
            <div className="space-y-1">
              <Meta className="block">{mine.path.includes("exclude=") ? "Waiting longest at the other desks" : "Waiting longest"}</Meta>
              <ul className="divide-y divide-line border-y border-line">
                {rows.map((r) => (
                  <li key={r.id} className="row flex items-center gap-3 px-1 py-2.5">
                    <Avatar
                      size="sm"
                      person={{
                        name: r.owner_name,
                        initials: r.owner_initials ?? initialsOf(r.owner_name),
                        photo_url: r.owner_photo_url ?? null,
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <Link
                        to={claimHref(me?.role, r)}
                        className="block truncate text-base underline-offset-4 hover:underline"
                      >
                        {paperTitle(r.paper_title)}
                      </Link>
                      <Meta className="block truncate text-xs">
                        {[r.owner_name, r.stage_label].filter(Boolean).join(" · ")}
                      </Meta>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-sm tabular text-fg-muted",
                        (r.days_in_stage ?? 0) > 30 && "font-medium text-critical",
                        (r.days_in_stage ?? 0) > 14 && (r.days_in_stage ?? 0) <= 30 && "text-caution"
                      )}
                    >
                      {days(r.days_in_stage)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
