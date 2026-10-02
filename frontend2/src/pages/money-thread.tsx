import { useAuth } from "@/app/auth"
import { homeTrack } from "@/app/home-data"
import { THREAD_DESK, threadCounts, threadLate, trackKey } from "@/pages/home-track"
import { MAIN_STAGES, type TrackPayload } from "@/pages/track-data"
import { useApi } from "@/lib/query"
import { InlineError, Skeleton } from "@/ui/state"
import { Thread, THREAD_STAGES } from "@/ui/thread"

/**
 * The Thread for the two money desks: where every claim is, with this
 * reader's station ringed ("Your desk"). It reads the same request the office
 * homes read (`/api/track`), so the counts here are the counts on Track and in
 * the sidebar badges, and it asks for no flags: the server sends none to the
 * Director or Finance.
 */
export function MoneyThread() {
  const { me } = useAuth()
  const mine = homeTrack(me?.role)
  const q = useApi<TrackPayload>(mine.key, mine.path)
  if (q.isError) return <InlineError message="Could not load where the claims are." onRetry={() => void q.refetch()} />
  if (!q.data) return <Skeleton className="h-28 w-full" />
  const stages = q.data.stages.filter((s) => MAIN_STAGES.includes(s.key))
  return (
    <Thread
      counts={threadCounts(stages)}
      you={me?.role ? THREAD_DESK[me.role] : undefined}
      to={Object.fromEntries(THREAD_STAGES.map((s) => [s.key, `/track?stage=${trackKey(s.key)}`]))}
      late={threadLate(stages)}
      caption="Each dot is a claim. Amber has waited over two weeks."
    />
  )
}
