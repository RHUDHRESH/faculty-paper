import { cn } from "@/lib/cn"
import { JOURNEY, journeyIndex, stageName } from "@/ui/journey"

/**
 * One claim as a timeline: Submitted, Being checked, Approved for payment,
 * Paid. Faculty stages only, so it can be shown to the claimant without
 * telling them whose desk the claim is on. A claim that leaves the track
 * shows where it left it, in the step's own place: "Sent back" or
 * "Not accepted" replaces "Being checked".
 *
 * Dates are only the ones a claimant is entitled to and the server keeps for
 * them: the day it was filed and the month it was paid. The steps between
 * carry none, because a date at "Being checked" would say when a desk
 * received it.
 */
type StepState = "done" | "current" | "todo" | "off"

const OFF_TONE: Record<string, "caution" | "critical" | "muted"> = {
  "Sent back": "caution",
  "Not accepted": "critical",
  Withdrawn: "muted",
  Draft: "muted",
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}

export function ClaimTrack({
  stage,
  filedOn,
  paidMonth,
  size = "md",
  className,
}: {
  stage: string | null | undefined
  /** ISO time it was filed. */
  filedOn?: string | null
  /** "September 2026". */
  paidMonth?: string | null
  size?: "sm" | "md"
  className?: string
}) {
  const name = stageName(stage)
  const at = journeyIndex(stage)
  const offTone = OFF_TONE[name]
  const onTrack = (JOURNEY as readonly string[]).includes(name)
  const paid = name === "Paid"

  const steps = JOURNEY.map((label, i) => {
    let state: StepState = "todo"
    if (paid) state = "done"
    else if (offTone && name !== "Draft") state = i < at ? "done" : i === at ? "off" : "todo"
    else if (onTrack) state = i < at ? "done" : i === at ? "current" : "todo"
    const shown = state === "off" ? name : label
    let sub: string | null = null
    if (i === 0 && state !== "todo") sub = shortDate(filedOn)
    if (i === 3 && paid) sub = paidMonth ?? null
    return { label: shown, state, sub }
  })

  const small = size === "sm"
  return (
    <ol
      aria-label={name ? `Progress: ${name}` : "Progress of this claim"}
      className={cn("grid grid-cols-4", className)}
    >
      {steps.map((s, i) => {
        const tone =
          s.state === "off"
            ? offTone === "critical"
              ? "critical"
              : offTone === "caution"
                ? "caution"
                : "muted"
            : s.state === "done" && paid
              ? "positive"
              : s.state === "todo"
                ? "todo"
                : "accent"
        return (
          <li
            key={i}
            aria-current={s.state === "current" ? "step" : undefined}
            className="relative min-w-0 pr-1"
          >
            {/* The rail runs from this dot to the next; it is filled only
                when the next step has been reached too. */}
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "absolute left-3 right-[-0.75rem] top-[0.4375rem] h-0.5 rounded-full",
                  small && "top-[0.3125rem]",
                  steps[i + 1].state === "todo" ? "bg-active" : paid ? "bg-positive" : "bg-accent"
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                "relative block rounded-full",
                small ? "size-3" : "size-4",
                tone === "positive" && "bg-positive",
                tone === "accent" && "bg-accent",
                tone === "caution" && "bg-caution",
                tone === "critical" && "bg-critical",
                tone === "muted" && "bg-fg-subtle",
                tone === "todo" && "bg-surface ring-2 ring-inset ring-active",
                s.state === "current" && "ring-4 ring-accent/25 animate-[pulse_2.4s_ease-in-out_infinite]"
              )}
            />
            <span
              className={cn(
                "mt-1.5 block text-balance break-words leading-tight",
                small ? "text-xs" : "text-sm",
                s.state === "todo" ? "text-fg-subtle" : "font-medium text-fg",
                s.state === "off" && offTone === "caution" && "text-caution",
                s.state === "off" && offTone === "critical" && "text-critical"
              )}
            >
              {s.label}
              <span className="sr-only">
                {s.state === "done" ? ", done" : s.state === "current" ? ", now" : s.state === "off" ? "" : ", not yet"}
              </span>
            </span>
            {s.sub && !small && (
              <span className="mt-0.5 block truncate text-xs text-fg-muted tabular">{s.sub}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
