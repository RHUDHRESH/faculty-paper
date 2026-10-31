import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"

/**
 * Where every claim is: a plain row of five stages (Filed, Checked, Approved,
 * Authorised, Paid) in one white panel. Each cell shows the stage name and the
 * count, is a link when `to` has a URL for it, carries a small "Your desk"
 * badge on the reader's stage and "N late" in amber when claims are overdue.
 * Two columns on a phone, then wrapping.
 *
 * The counts come from `/api/claims/counts` (`HOME_DATA.stageCounts`).
 */
export const THREAD_STAGES = [
  { key: "filed", label: "Filed" },
  { key: "checked", label: "Checked" },
  { key: "approved", label: "Approved" },
  { key: "authorised", label: "Authorised" },
  { key: "paid", label: "Paid" },
] as const

export type ThreadStage = (typeof THREAD_STAGES)[number]["key"]

export function Thread({
  counts,
  you,
  to,
  late,
  caption,
  className,
}: {
  /** Claims at each station. A missing key is still loading (shown as an en dash). */
  counts: Partial<Record<ThreadStage, number | null | undefined>> | undefined
  /** The station this reader works at. */
  you?: ThreadStage
  /** The list behind each station; a station with one is a link. */
  to?: Partial<Record<ThreadStage, string>>
  /** Of the claims at a station, how many are past the service level. */
  late?: Partial<Record<ThreadStage, number>>
  /** One line under the row. */
  caption?: React.ReactNode
  className?: string
}) {
  return (
    <figure className={cn("m-0", className)}>
      <div className="overflow-hidden rounded-xl border border-edge bg-surface">
        <ol aria-label="Where every claim is" className="-ml-px -mt-px grid grid-cols-2 sm:grid-cols-5">
          {THREAD_STAGES.map((s) => (
            <Station
              key={s.key}
              stage={s}
              count={counts?.[s.key]}
              href={to?.[s.key]}
              you={you === s.key}
              lateCount={late?.[s.key] ?? 0}
            />
          ))}
        </ol>
      </div>
      {caption && <figcaption className="mt-3 text-sm text-fg-muted">{caption}</figcaption>}
    </figure>
  )
}

function Station({
  stage,
  count,
  href,
  you,
  lateCount,
}: {
  stage: (typeof THREAD_STAGES)[number]
  count: number | null | undefined
  href?: string
  you: boolean
  lateCount: number
}) {
  const known = count != null
  const said = known
    ? `${stage.label}: ${formatCount(count)} ${count === 1 ? "claim" : "claims"}${you ? ", your desk" : ""}${
        lateCount ? `, ${formatCount(lateCount)} past the service level` : ""
      }`
    : `${stage.label}: loading`
  const body = (
    <>
      <span aria-hidden className="flex items-center gap-2 text-[13px] text-fg-muted">
        {stage.label}
        {you && <span className="rounded-md bg-accent-wash px-1.5 py-0.5 text-xs font-medium text-accent">Your desk</span>}
      </span>
      <span
        aria-hidden
        className={cn("figure mt-1 block text-2xl font-semibold", !known || count === 0 ? "text-fg-subtle" : "text-fg")}
      >
        {known ? formatCount(count) : "–"}
      </span>
      <span aria-hidden className="mt-0.5 block h-4 text-xs font-medium text-caution">
        {lateCount > 0 ? `${formatCount(lateCount)} late` : ""}
      </span>
      <span className="sr-only">{said}</span>
    </>
  )
  const cell = "block min-w-0 border-l border-t border-line p-4"
  return (
    <li className="min-w-0" aria-current={you ? "step" : undefined}>
      {href ? (
        <Link to={href} className={cn(cell, "h-full hover:bg-bg")}>
          {body}
        </Link>
      ) : (
        <div className={cn(cell, "h-full")}>{body}</div>
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
