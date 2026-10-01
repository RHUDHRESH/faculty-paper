import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"

/**
 * The Thread (DESIGN.md, "The Thread"): the signature picture of this
 * product, which is a claim travelling a chain of desks until money is paid.
 *
 * Five stations on a hairline: Filed, Checked, Approved, Authorised, Paid.
 * Each station is a dot; the claims waiting there pile up above it as small
 * dots (a tall pile is a bottleneck you can see from across the room); the
 * count beneath is the figure; the station where *this reader* works is
 * ringed in clay and says "Your desk". Claims past the service level sit at
 * the bottom of their pile in amber.
 *
 * It answers three questions with one drawing: "where is everything" for a
 * desk, "is anything stuck" for the administrator, "where is the money" for
 * the Director and Finance. It is the answer, so it goes where the Answer
 * strip would go, and a Home view has either one, not both.
 *
 * The counts come from `/api/claims/counts` (`HOME_DATA.stageCounts`), the
 * same numbers the sidebar badges read, so the two can never disagree. The
 * keys are the server's: filed, checked, approved, authorised, paid.
 *
 * Motion: the thread draws itself once per session, left to right, 640ms,
 * and the counts fade in behind it. After that it is still. Under
 * `prefers-reduced-motion` it simply appears.
 *
 * On a phone it stands up: a vertical thread, one row per station.
 */
export const THREAD_STAGES = [
  { key: "filed", label: "Filed" },
  { key: "checked", label: "Checked" },
  { key: "approved", label: "Approved" },
  { key: "authorised", label: "Authorised" },
  { key: "paid", label: "Paid" },
] as const

export type ThreadStage = (typeof THREAD_STAGES)[number]["key"]

const DRAWN_KEY = "thread-drawn"
const PILE_MAX = 10

/** True the first time the thread appears in a session, so it draws once. */
function useFirstDraw(): boolean {
  const [first] = useState(() => {
    try {
      return sessionStorage.getItem(DRAWN_KEY) !== "1"
    } catch {
      return false
    }
  })
  useEffect(() => {
    if (!first) return
    try {
      sessionStorage.setItem(DRAWN_KEY, "1")
    } catch {
      /* it just draws again next time */
    }
  }, [first])
  return first
}

export function Thread({
  counts,
  you,
  to,
  late,
  caption,
  className,
}: {
  /** Claims at each station. A missing key is still loading (drawn as an en dash). */
  counts: Partial<Record<ThreadStage, number | null | undefined>> | undefined
  /** The station this reader works at. */
  you?: ThreadStage
  /** The list behind each station; a station with one is a link. */
  to?: Partial<Record<ThreadStage, string>>
  /** Of the claims at a station, how many are past the service level. */
  late?: Partial<Record<ThreadStage, number>>
  /** One line under the thread ("Each dot is a claim. Amber has waited over 14 days."). */
  caption?: React.ReactNode
  className?: string
}) {
  const first = useFirstDraw()
  const loaded = counts !== undefined
  // Paid is history, not a queue, so it has no pile and does not set the scale.
  const values = THREAD_STAGES.filter((s) => s.key !== "paid").map((s) => counts?.[s.key])
  const max = Math.max(0, ...values.map((v) => v ?? 0))
  // One dot a claim up to ten; past that, a dot is a few claims, and the
  // caption says so. The figure under the station is always the real number.
  const perDot = Math.max(1, Math.ceil(max / PILE_MAX))

  return (
    <figure className={cn("m-0", className)}>
      <ol
        aria-label="Where every claim is"
        className="relative hidden grid-cols-5 sm:grid"
      >
        {/* The thread itself: one line through the five stations. */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-x-0 text-navy"
          style={{ top: PILE_H }}
          width="100%"
          height="16"
        >
          <line
            x1="10%"
            x2="90%"
            y1="8"
            y2="8"
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="1.5"
            strokeLinecap="round"
            pathLength={1}
            className={first ? "thread-draw" : undefined}
            style={{ "--len": 1 } as React.CSSProperties}
          />
        </svg>
        {THREAD_STAGES.map((s, i) => (
          <Station
            key={s.key}
            index={i}
            stage={s}
            count={counts?.[s.key]}
            href={to?.[s.key]}
            you={you === s.key}
            lateCount={late?.[s.key] ?? 0}
            perDot={perDot}
            animate={first}
            loaded={loaded}
          />
        ))}
      </ol>

      {/* On a phone the thread stands up. */}
      <ol aria-label="Where every claim is" className="relative sm:hidden">
        <span aria-hidden className="absolute bottom-3 left-[0.4375rem] top-3 w-px bg-navy/40" />
        {THREAD_STAGES.map((s) => (
          <StationRow
            key={s.key}
            stage={s}
            count={counts?.[s.key]}
            href={to?.[s.key]}
            you={you === s.key}
            lateCount={late?.[s.key] ?? 0}
            perDot={perDot}
          />
        ))}
      </ol>

      {(caption || perDot > 1) && (
        <figcaption className="mt-3 text-sm text-fg-muted">
          {caption}
          {perDot > 1 && <> One dot is {perDot} claims.</>}
        </figcaption>
      )}
    </figure>
  )
}

/** Height of the pile above the line, in px. Fixed, so five columns align. */
const PILE_H = 104

function pileOf(count: number, lateCount: number, perDot: number, paid = false) {
  if (paid) return { dots: 0, amber: 0 }
  const dots = Math.min(PILE_MAX, Math.ceil(count / perDot))
  const amber = Math.min(dots, Math.ceil(lateCount / perDot))
  return { dots, amber }
}

function Node({ count, you, done = false }: { count: number | null | undefined; you: boolean; done?: boolean }) {
  const filled = !!count && count > 0
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 block size-4 rounded-full",
        filled ? (done ? "bg-positive" : "bg-navy") : "bg-bg ring-2 ring-inset ring-edge",
        // Your station: ringed in clay. The ring is outside the dot so the
        // dot's own state (waiting or empty) still reads.
        you && "outline outline-2 outline-offset-[3px] outline-accent"
      )}
    />
  )
}

function Station({
  index,
  stage,
  count,
  href,
  you,
  lateCount,
  perDot,
  animate,
  loaded,
}: {
  index: number
  stage: (typeof THREAD_STAGES)[number]
  count: number | null | undefined
  href?: string
  you: boolean
  lateCount: number
  perDot: number
  animate: boolean
  loaded: boolean
}) {
  const known = count != null
  const { dots, amber } = pileOf(count ?? 0, lateCount, perDot, stage.key === "paid")
  const said = known
    ? `${stage.label}: ${formatCount(count)} ${count === 1 ? "claim" : "claims"}${you ? ", your desk" : ""}${
        lateCount ? `, ${formatCount(lateCount)} past the service level` : ""
      }`
    : `${stage.label}: loading`
  const body = (
    <>
      <span aria-hidden className="flex flex-col-reverse items-center justify-start gap-[3px]" style={{ height: PILE_H }}>
        {Array.from({ length: dots }, (_, d) => (
          <span
            key={d}
            style={{ "--i": index } as React.CSSProperties}
            className={cn(
              "block size-2 rounded-full",
              d < amber ? "bg-caution" : "bg-navy/70",
              animate && "thread-pop"
            )}
          />
        ))}
      </span>
      <span className="mt-[8px] flex h-4 items-center justify-center">
        <Node count={count} you={you} done={stage.key === "paid"} />
      </span>
      <span
        aria-hidden
        className={cn(
          "figure mt-4 block text-2xl",
          !known || count === 0 ? "text-fg-subtle" : "text-fg",
          animate && loaded && "thread-pop"
        )}
        style={{ "--i": index } as React.CSSProperties}
      >
        {known ? formatCount(count) : "–"}
      </span>
      <span aria-hidden className={cn("mt-0.5 block text-sm", you ? "font-medium text-fg" : "text-fg-muted")}>
        {stage.label}
      </span>
      <span aria-hidden className="mt-0.5 block h-4 text-xs font-medium text-accent">
        {you ? "Your desk" : ""}
      </span>
      <span className="sr-only">{said}</span>
    </>
  )
  return (
    <li className="min-w-0" aria-current={you ? "step" : undefined}>
      {href ? (
        <Link to={href} className="block rounded-control px-1 text-center hover:bg-hover">
          {body}
        </Link>
      ) : (
        <div className="px-1 text-center">{body}</div>
      )}
    </li>
  )
}

function StationRow({
  stage,
  count,
  href,
  you,
  lateCount,
  perDot,
}: {
  stage: (typeof THREAD_STAGES)[number]
  count: number | null | undefined
  href?: string
  you: boolean
  lateCount: number
  perDot: number
}) {
  const known = count != null
  const { dots, amber } = pileOf(count ?? 0, lateCount, perDot, stage.key === "paid")
  const inner = (
    <>
      <span className="flex h-6 w-4 shrink-0 items-center justify-center">
        <Node count={count} you={you} done={stage.key === "paid"} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-base", you ? "font-medium text-fg" : "text-fg-muted")}>
          {stage.label}
          {you && <span className="ml-2 text-xs font-medium text-accent">Your desk</span>}
        </span>
        {dots > 0 && (
          <span aria-hidden className="mt-1 flex flex-wrap gap-[3px]">
            {Array.from({ length: dots }, (_, d) => (
              <span
                key={d}
                className={cn(
                  "block size-2 rounded-full",
                  d < amber ? "bg-caution" : "bg-navy/70"
                )}
              />
            ))}
          </span>
        )}
      </span>
      <span className={cn("figure text-2xl", !known || count === 0 ? "text-fg-subtle" : "text-fg")}>
        {known ? formatCount(count) : "–"}
      </span>
    </>
  )
  const said = known
    ? `${stage.label}: ${formatCount(count)} ${count === 1 ? "claim" : "claims"}${you ? ", your desk" : ""}`
    : `${stage.label}: loading`
  return (
    <li className="relative" aria-current={you ? "step" : undefined} aria-label={said}>
      {href ? (
        <Link to={href} className="flex min-h-12 items-start gap-4 rounded-control py-2 pr-2 hover:bg-hover">
          {inner}
        </Link>
      ) : (
        <div className="flex min-h-12 items-start gap-4 py-2 pr-2">{inner}</div>
      )}
    </li>
  )
}

/**
 * One claim on the chain: five dots, the first `at` filled in navy, the
 * current one ringed in clay, the rest hollow. For a staff view of a single
 * claim (the review workspace, a claim page). A claimant sees four stages,
 * and no desk (`ClaimTrack`), so this one is never shown to faculty.
 */
export function ClaimThread({
  at,
  className,
}: {
  /** The station the claim is at now. Past `paid`, or `null`, shows it complete. */
  at: ThreadStage | null | undefined
  className?: string
}) {
  const idx = at ? THREAD_STAGES.findIndex((s) => s.key === at) : -1
  const done = at === "paid"
  return (
    <ol aria-label={at ? `This claim is at: ${THREAD_STAGES[idx]?.label ?? ""}` : "Where this claim is"} className={cn("grid grid-cols-5", className)}>
      {THREAD_STAGES.map((s, i) => {
        const state = done || i < idx ? "done" : i === idx ? "current" : "todo"
        return (
          <li key={s.key} className="relative min-w-0 text-center" aria-current={state === "current" ? "step" : undefined}>
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  "absolute right-1/2 top-[0.4375rem] h-px w-full",
                  state === "todo" ? "bg-edge" : done ? "bg-positive" : "bg-navy/50"
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                "relative z-10 mx-auto block size-4 rounded-full",
                state === "todo" && "bg-bg ring-2 ring-inset ring-edge",
                state === "done" && (done ? "bg-positive" : "bg-navy"),
                state === "current" && "bg-navy outline outline-2 outline-offset-[3px] outline-accent"
              )}
            />
            <span className={cn("mt-2 block text-xs", state === "todo" ? "text-fg-subtle" : "font-medium text-fg")}>
              {s.label}
              <span className="sr-only">
                {state === "done" ? ", done" : state === "current" ? ", now" : ", not yet"}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
