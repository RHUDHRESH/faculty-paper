import { cn } from "@/lib/cn"

/**
 * Where a paper is, as the person who filed it is allowed to see it.
 *
 * Four stages and no desks. The college decided that a claimant is told how
 * far a paper has come and how long it has waited, never whose desk it is on
 * -- a name on the tracker is a name somebody goes and stands in front of.
 * The server sends `faculty_stage` in exactly these words; this component
 * only draws them.
 */
export const JOURNEY = ["Submitted", "Under review", "Approved for payment", "Paid"] as const

/** Stages that leave the track, and which point of it they left from. */
const OFF_TRACK: Record<string, { at: number; tone: "caution" | "critical" | "muted" }> = {
  Draft: { at: -1, tone: "muted" },
  "Sent back to you": { at: 0, tone: "caution" },
  "Not accepted": { at: 1, tone: "critical" },
  Withdrawn: { at: 0, tone: "muted" },
}

export function journeyIndex(stage: string | null | undefined): number {
  if (!stage) return -1
  const i = (JOURNEY as readonly string[]).indexOf(stage)
  return i >= 0 ? i : (OFF_TRACK[stage]?.at ?? -1)
}

export function Journey({
  stage,
  daysWaiting,
  className,
  size = "md",
}: {
  stage?: string | null
  daysWaiting?: number | null
  className?: string
  size?: "sm" | "md"
}) {
  const at = journeyIndex(stage)
  const off = stage ? OFF_TRACK[stage] : undefined
  const done = stage === "Paid"

  return (
    <div className={className}>
      <ol
        className="grid grid-cols-4 gap-1.5"
        aria-label={stage ? `Stage: ${stage}` : "Stages a paper passes through"}
      >
        {JOURNEY.map((name, i) => {
          const reached = at >= i
          const current = !off && i === at && !done
          return (
            <li key={name} className="min-w-0" aria-current={current ? "step" : undefined}>
              <span
                aria-hidden
                className={cn(
                  "block h-1.5 rounded-full",
                  reached
                    ? done
                      ? "bg-positive"
                      : off?.tone === "caution" && i === at
                        ? "bg-caution"
                        : off?.tone === "critical" && i === at
                          ? "bg-critical"
                          : "bg-accent"
                    : "bg-active",
                  current && "animate-[pulse_2.4s_ease-in-out_infinite]"
                )}
              />
              {size === "md" && (
                <span
                  className={cn(
                    "mt-1.5 block truncate text-xs",
                    reached ? "font-medium text-fg" : "text-fg-subtle"
                  )}
                >
                  {name}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {stage && (off || done || daysWaiting != null) && (
        <p className="mt-2 text-sm">
          {off || done ? (
            <span
              className={cn(
                "font-medium",
                done && "text-positive",
                off?.tone === "caution" && "text-caution",
                off?.tone === "critical" && "text-critical",
                off?.tone === "muted" && "text-fg-muted"
              )}
            >
              {stage}
            </span>
          ) : (
            <span className="text-fg-muted">
              {daysWaiting === 0
                ? "Waiting since today"
                : `Waiting ${daysWaiting} day${daysWaiting === 1 ? "" : "s"}`}
            </span>
          )}
        </p>
      )}
    </div>
  )
}

/**
 * The claimant's stage for a raw status, for payloads that predate the
 * server's `faculty_stage`. Prefer the server's value when it is present.
 */
export function facultyStage(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft"
    // Filed is already with the college, so already under review -- the
    // server's rule (core/visibility.py). Telling "Submitted" apart from the
    // later steps would tell the claimant which desk has it.
    case "SUBMITTED":
    case "HOD_APPROVED":
    case "CLEARED":
    case "RESEARCH_APPROVED":
    case "PRINCIPAL_APPROVED":
      return "Under review"
    case "DIRECTOR_APPROVED":
    case "FINANCE_APPROVED":
      return "Approved for payment"
    case "PAID":
      return "Paid"
    case "REJECTED":
    case "NEEDS_CHANGES":
    case "RETURNED":
      return "Sent back to you"
    case "WITHDRAWN":
      return "Withdrawn"
    default:
      return "Under review"
  }
}
