import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"

/**
 * The dot field: the house chart (DESIGN.md, "Charts"). One dot per paper (or
 * per claim), grouped and coloured, a unit chart a person can count. It says
 * "145 papers" and "12 of them Q1" in one look, and it needs no axis, no
 * legend to decode and no hover to read. It is the kolam's idea (a lattice
 * of dots, one for each thing) without drawing a kolam.
 *
 * The groups are drawn in the order given, as runs of dots, and each group is
 * named once, directly, beneath the field with its real count (never in a
 * separate legend). Colour is never the only code: the run is also named,
 * counted and (when `to` is given) a link to the list behind it.
 *
 *   `groups`  [{ key, label, count, tone, to? }], in reading order.
 *   `max`     the most dots to draw (default 320). Past that, one dot is a few
 *             papers, and the caption says so. The counts are always real.
 *   `dot`     dot diameter in px (default 10).
 *
 * Tones are the chart inks (`--chart-1` to `--chart-6`) plus `muted` for "the
 * rest" and `gold` for honours. At most four groups read well; more is a
 * table.
 */
export type DotTone = "navy" | "clay" | "sage" | "gold" | "slate" | "plum" | "muted"

const INK: Record<DotTone, string> = {
  navy: "var(--chart-1)",
  clay: "var(--chart-2)",
  sage: "var(--chart-3)",
  gold: "var(--chart-4)",
  slate: "var(--chart-5)",
  plum: "var(--chart-6)",
  muted: "var(--color-field)",
}

export type DotGroup = {
  key: string
  label: string
  count: number
  tone?: DotTone
  to?: string
}

export function DotField({
  groups,
  unit = "papers",
  max = 320,
  dot = 10,
  className,
}: {
  groups: DotGroup[]
  /** What one dot stands for, plural ("papers", "claims"). */
  unit?: string
  max?: number
  dot?: number
  className?: string
}) {
  const total = groups.reduce((n, g) => n + Math.max(0, g.count), 0)
  const per = Math.max(1, Math.ceil(total / max))
  const tones: DotTone[] = ["navy", "clay", "sage", "gold", "slate", "plum"]
  const runs = groups.map((g, i) => ({
    ...g,
    tone: g.tone ?? tones[i % tones.length],
    dots: Math.ceil(Math.max(0, g.count) / per),
  }))
  const summary = `${formatCount(total)} ${unit}: ${runs.map((g) => `${formatCount(g.count)} ${g.label}`).join(", ")}`

  return (
    <figure className={cn("m-0", className)}>
      <div role="img" aria-label={summary} className="flex flex-wrap" style={{ gap: Math.max(3, dot / 3) }}>
        {runs.flatMap((g) =>
          Array.from({ length: g.dots }, (_, i) => (
            <span
              key={`${g.key}-${i}`}
              aria-hidden
              className="block rounded-full"
              style={{ width: dot, height: dot, backgroundColor: INK[g.tone] }}
            />
          ))
        )}
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {runs.map((g) => {
          const body = (
            <>
              <span
                aria-hidden
                className="mr-1.5 inline-block size-2.5 rounded-full align-[-1px]"
                style={{ backgroundColor: INK[g.tone] }}
              />
              <span className="tabular font-medium text-fg">{formatCount(g.count)}</span>{" "}
              <span className="text-fg-muted">{g.label}</span>
            </>
          )
          return g.to ? (
            <Link key={g.key} to={g.to} className="rounded-control hover:underline hover:underline-offset-4">
              {body}
            </Link>
          ) : (
            <span key={g.key}>{body}</span>
          )
        })}
        {per > 1 && <span className="text-fg-muted">One dot is {per} {unit}.</span>}
      </figcaption>
    </figure>
  )
}
