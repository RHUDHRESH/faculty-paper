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
import { InlineError, Skeleton } from "@/ui/state"
import { Table, type Column } from "@/ui/table"

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
export const trackKey = (k: ThreadStage): string => (k === "filed" ? "submitted" : k)

/** The station each desk works at (the same mapping as the sidebar badges). */
export const THREAD_DESK: Partial<Record<Role, ThreadStage>> = {
  SUPER_ADMIN: "filed",
  RESEARCH_CELL: "filed",
  RESEARCH_COORDINATOR: "filed",
  PRINCIPAL: "checked",
  DIRECTOR: "approved",
  FINANCE: "authorised",
}

export function threadCounts(stages: TrackStage[]): Partial<Record<ThreadStage, number>> {
  const by = new Map(stages.map((s) => [s.key, s]))
  return Object.fromEntries(THREAD_STAGES.map((s) => [s.key, by.get(trackKey(s.key))?.count ?? 0]))
}

/** Of each station's claims, how many have waited past the fortnight. */
export function threadLate(stages: TrackStage[]): Partial<Record<ThreadStage, number>> {
  const by = new Map(stages.map((s) => [s.key, s]))
  return Object.fromEntries(
    THREAD_STAGES.map((s) => {
      const a = by.get(trackKey(s.key))?.ageing
      return [s.key, a ? a.month + a.older : 0]
    })
  )
}

type TrackRow = TrackPayload["results"][number]

/**
 * The stage counts as one KPI row (the five-cell `Thread`, each stage a link
 * to Track at that stage, amber "N late"), then, unless `list` is false, the
 * claims waiting longest as a plain table.
 */
export function HomeTrack({
  heading = "Where everything is",
  list = true,
}: {
  heading?: string
  /** False when the page has its own main table and wants the counts only. */
  list?: boolean
}) {
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

  const columns: Column<TrackRow>[] = [
    {
      key: "paper",
      header: "Claim",
      exportValue: (r) => paperTitle(r.paper_title),
      cell: (r) => (
        <Link to={claimHref(me?.role, r)} className="font-medium text-fg underline-offset-4 hover:underline">
          {paperTitle(r.paper_title)}
        </Link>
      ),
    },
    { key: "owner", header: "Claimant", exportValue: (r) => r.owner_name ?? "", cell: (r) => r.owner_name },
    { key: "stage", header: "At", exportValue: (r) => r.stage_label ?? "", cell: (r) => r.stage_label },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      exportValue: (r) => r.days_in_stage ?? null,
      cell: (r) => (
        <span
          className={cn(
            (r.days_in_stage ?? 0) > 30 && "font-medium text-critical",
            (r.days_in_stage ?? 0) > 14 && (r.days_in_stage ?? 0) <= 30 && "text-caution"
          )}
        >
          {days(r.days_in_stage)}
        </span>
      ),
    },
  ]

  return (
    <section aria-labelledby="home-track" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="home-track" className="text-base font-semibold text-fg">
          {heading}
        </h2>
        <Link to="/track" className="text-sm text-accent underline-offset-4 hover:underline">
          Open Track
        </Link>
      </div>

      {q.isLoading || !data ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <>
          <Thread
            counts={threadCounts(stages)}
            you={me?.role ? THREAD_DESK[me.role] : undefined}
            to={Object.fromEntries(THREAD_STAGES.map((s) => [s.key, `/track?stage=${trackKey(s.key)}`]))}
            late={threadLate(stages)}
          />

          {late > 0 && (
            <p className="text-sm text-caution" role="status">
              {`${late.toLocaleString("en-IN")} ${late === 1 ? "claim has" : "claims have"} been in one place for over a month.`}
            </p>
          )}

          {list && rows.length > 0 && (
            <Table
              rows={rows}
              columns={columns}
              getKey={(r) => r.id}
              caption={mine.path.includes("exclude=") ? "Waiting longest at the other desks" : "Waiting longest"}
              tools={{
                id: "track-home",
                title: mine.path.includes("exclude=") ? "Waiting longest at the other desks" : "Waiting longest",
              }}
            />
          )}
        </>
      )}
    </section>
  )
}
