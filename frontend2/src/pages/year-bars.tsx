import { cn } from "@/lib/cn"

/**
 * Columns, one per year, each labelled with its value.
 *
 * Drawn here rather than with the chart kit's `Trend` because a council page
 * compares five years side by side, and a line hides the one number a reader
 * wants: "what was it in 2023?". Every column carries its value, and the year
 * being reported is the only one in colour.
 */
export function YearBars<T extends { year: number }>({
  title,
  rows,
  value,
  label,
  axis,
  highlight,
  tone = "bg-accent",
}: {
  title: string
  rows: T[]
  value: (t: T) => number
  label: (t: T) => string
  axis: (t: T) => string
  highlight: number
  tone?: string
}) {
  const top = Math.max(1, ...rows.map(value))
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-medium text-fg">{title}</figcaption>
      <div className="flex h-40 items-end gap-2 border-b border-line" role="img" aria-label={title}>
        {rows.map((t) => (
          <div key={t.year} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
            <span className="mb-1 text-xs tabular text-fg">{label(t)}</span>
            <div
              className={cn("w-full max-w-14 rounded-t-sm", t.year === highlight ? tone : "bg-fg-muted/35")}
              style={{ height: `${(value(t) / top) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-2">
        {rows.map((t) => (
          <span key={t.year} className="min-w-0 flex-1 truncate text-center text-xs text-fg-muted">
            {axis(t)}
          </span>
        ))}
      </div>
    </figure>
  )
}
