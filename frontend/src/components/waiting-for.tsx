"use client"

import { cn } from "@/lib/utils"

/**
 * How long a ticket has sat at its current step.
 *
 * Every queue in the app is worked in the order the rows happen to arrive in,
 * because nothing on a row said which had been waiting longest. The number was
 * on the payload the whole time.
 *
 * The colour is the point. A fortnight and a day read identically as plain
 * text, and the reason to show this at all is to make the old ones obvious
 * without anybody having to read the numbers and compare them.
 */
export function WaitingFor({
  days,
  className,
}: {
  days?: number | null
  className?: string
}) {
  if (days == null) return null

  // Thresholds are the college's own habit rather than a rule in the code:
  // a week is unremarkable, a fortnight is worth a glance, a month is worth
  // an explanation.
  const tone =
    days >= 30
      ? "text-destructive"
      : days >= 14
        ? "text-warning-foreground"
        : "text-muted-foreground"

  const text =
    days === 0 ? "arrived today" : days === 1 ? "waiting 1 day" : `waiting ${days} days`

  return (
    <span className={cn("block text-[11px] tabular-nums", tone, className)} title={text}>
      {text}
    </span>
  )
}
