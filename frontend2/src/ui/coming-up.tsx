import { HOME_DATA } from "@/app/home-data"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"

/**
 * What is on its way to a desk whose queue is empty.
 *
 * "Nothing waiting" was true and useless: on the day the college's records
 * came across, the Principal, the Director and Finance each opened an empty
 * queue with thirteen papers one or two steps behind it, and no screen said
 * so. The counts are the chain's own (`/api/claims/counts`), shared with the
 * homes, and carry no flag -- the Director and Finance are never shown one.
 */
type Desk = "principal" | "director" | "finance"

type Counts = { counts: Record<string, number> }

const PAPERS = (n: number) => `${n} ${n === 1 ? "paper" : "papers"}`

/** Earlier desks, nearest first. */
const UPSTREAM: Record<Desk, [stage: string, where: string][]> = {
  principal: [["filed", "with the research office, being checked"]],
  director: [
    ["checked", "with the Principal, waiting for approval"],
    ["filed", "with the research office, being checked"],
  ],
  finance: [
    ["approved", "with the Director, waiting to be authorised"],
    ["checked", "with the Principal, waiting for approval"],
    ["filed", "with the research office, being checked"],
  ],
}

/** `center` inside an empty state; `start` under a callout on a home page. */
export function ComingUp({ desk, align = "center" }: { desk: Desk; align?: "center" | "start" }) {
  const q = useApi<Counts>(HOME_DATA.stageCounts.key, HOME_DATA.stageCounts.path)
  if (!q.data) return null
  const counts = q.data.counts
  const lines = UPSTREAM[desk]
    .map(([stage, where]) => ({ n: counts[stage] ?? 0, where }))
    .filter((l) => l.n > 0)
  const paid = counts.paid ?? 0
  return (
    <div className={cn("max-w-md space-y-1.5 text-left text-sm", align === "center" && "mx-auto")}>
      <p className="font-medium text-fg">On the way to you</p>
      {lines.length > 0 ? (
        <ul className="space-y-1 text-fg-muted">
          {lines.map((l) => (
            <li key={l.where}>{`${PAPERS(l.n)} ${l.where}`}</li>
          ))}
        </ul>
      ) : (
        <p className="text-fg-muted">Nothing earlier in the chain either.</p>
      )}
      {paid > 0 && (
        // "on record", not "through the chain": most were paid before it existed.
        <p className="text-fg-subtle">{PAPERS(paid)} on record as paid.</p>
      )}
    </div>
  )
}
