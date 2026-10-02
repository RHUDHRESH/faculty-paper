import { cn } from "@/lib/cn"

/**
 * Five years as columns, and the year that is still running as a hollow one.
 *
 * Why this and not the chart kit's `Trend`: a council compares five years side
 * by side and wants the one number it will be asked, "what was it in 2023?",
 * printed on the column. A line hides it. And this is the place where the
 * college's year-on-year picture is easiest to get wrong, so the rules are
 * built in rather than left to each page:
 *
 *  - Every column carries its own value, set in the figure type. There is no
 *    axis to read and no legend to decode (data-visualization: label directly).
 *  - The year being reported is solid ink; the years before it are the same
 *    ink, thinner. Emphasis is lightness, not a second hue.
 *  - A year that is still running is drawn hollow, hatched, and labelled "to
 *    date" under its year. It is never the same shape as a full year, so nine
 *    months of papers cannot read as a fall (docs/ux/27, T7). It is not
 *    compared with anything: no arrow, no percentage.
 *  - Bars start at zero. A bar chart that does not is a different chart.
 *  - Every chart is also a table (the sr-only table below), and the figure has
 *    one accessible name that says what the columns are.
 */

export type YearColumn = {
  year: number
  /** null draws no bar and the label "None"; a figure that is not recorded is not zero. */
  value: number | null
  /** The value as it is printed on the column ("1,586", "3.86", "12.9"). */
  label: string
  /** The line under the year ("FY 2025-26"); the year itself is the default. */
  axis?: string
  /** The year is still running: hollow, hatched, "to date". */
  running?: boolean
}

const INK = "var(--chart-1)"

export function FiveYears({
  title,
  columns,
  current,
  caption,
  height = 120,
  className,
}: {
  /** What the columns are ("Papers published"). Also the accessible name. */
  title: string
  columns: YearColumn[]
  /** The year being reported: its column is solid, the earlier ones thin. */
  current: number
  /** The finding, one line, under the chart. */
  caption?: React.ReactNode
  height?: number
  className?: string
}) {
  const top = Math.max(0.0001, ...columns.map((c) => c.value ?? 0))
  const summary = `${title}: ${columns
    .map((c) => `${c.axis ?? c.year} ${c.value == null ? "none" : c.label}${c.running ? " to date" : ""}`)
    .join(", ")}.`

  return (
    <figure className={cn("m-0 min-w-0", className)}>
      <figcaption className="mb-2 text-sm font-medium text-fg">{title}</figcaption>
      <div role="img" aria-label={summary} className="flex items-end gap-2 border-b border-edge sm:gap-3" style={{ height }}>
        {columns.map((c) => {
          const pct = c.value == null ? 0 : Math.max(2, (c.value / top) * 100)
          return (
            <div key={`${c.year}-${c.axis ?? ""}`} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
              <span
                aria-hidden
                className={cn(
                  "mb-1 whitespace-nowrap text-xs tabular",
                  c.year === current && !c.running ? "font-semibold text-fg" : "text-fg-muted"
                )}
              >
                {c.value == null ? "None" : c.label}
              </span>
              <div
                aria-hidden
                className="w-full max-w-12 rounded-t-sm"
                style={
                  c.running
                    ? {
                        height: `${pct}%`,
                        border: `1px dashed ${INK}`,
                        borderBottom: "none",
                        backgroundImage: `repeating-linear-gradient(135deg, ${INK} 0 1px, transparent 1px 6px)`,
                        backgroundColor: "transparent",
                        opacity: 0.75,
                      }
                    : {
                        height: `${pct}%`,
                        backgroundColor: INK,
                        opacity: c.year === current ? 1 : 0.34,
                      }
                }
              />
            </div>
          )
        })}
      </div>
      <div aria-hidden className="mt-1.5 flex gap-2 sm:gap-3">
        {columns.map((c) => (
          <div key={`${c.year}-${c.axis ?? ""}-axis`} className="min-w-0 flex-1 text-center text-xs leading-tight text-fg-muted">
            <span className={cn(c.year === current && !c.running && "font-medium text-fg")}>{c.axis ?? c.year}</span>
            {c.running && <span className="block">to date</span>}
          </div>
        ))}
      </div>
      {caption && <p className="mt-3 max-w-prose text-pretty text-sm text-fg-muted">{caption}</p>}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.year}>
              <th scope="row">{c.axis ?? c.year}</th>
              <td>{c.value == null ? "None" : c.label}{c.running ? ", to date" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
