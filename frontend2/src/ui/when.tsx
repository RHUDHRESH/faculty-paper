import { cn } from "@/lib/cn"

/**
 * A date said the way people say it ("3 days ago", "yesterday"), with the
 * exact date and time one hover away and in the markup for a screen reader.
 * Past a month the relative form stops being useful and the date is shown.
 */
export function When({ iso, className }: { iso: string | null | undefined; className?: string }) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const exact = d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  return (
    <time dateTime={d.toISOString()} title={exact} className={className}>
      {relativeDay(d)}
    </time>
  )
}

/**
 * A calendar day from the server ("2026-12-31"), as the local date it names.
 *
 * `new Date("2026-12-31")` is midnight UTC, which west of Greenwich is the
 * evening of the 30th -- so a deadline read that way moves a day earlier for
 * anybody whose clock is behind UTC. A date with no time is a day, not an
 * instant, and is built from its parts.
 */
function parseDay(day: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "")
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * A deadline, and whether it has passed -- said in words, not only in colour.
 *
 * A date in amber on its own tells somebody who cannot tell amber from grey
 * nothing at all, and tells everybody else only that something is wrong. So
 * a deadline that has gone by says "overdue" as well. Once the work is done
 * it is just a date: a finished task is not late.
 */
export function Due({
  day,
  done,
  className,
}: {
  day: string | null | undefined
  done?: boolean
  className?: string
}) {
  const d = parseDay(day)
  if (!d) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const late = !done && d < today
  return (
    <span className={cn(late && "text-caution", className)}>
      by {d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
      {late && " · overdue"}
    </span>
  )
}

export function relativeDay(d: Date, now = new Date()): string {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((start(now) - start(d)) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 7) return `${days} days ago`
  if (days < 30) {
    const w = Math.floor(days / 7)
    return `${w} week${w === 1 ? "" : "s"} ago`
  }
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
