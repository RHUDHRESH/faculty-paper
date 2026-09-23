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
