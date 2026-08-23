/**
 * A small chart kit, drawn as SVG.
 *
 * No charting library: these are four fixed shapes over a known payload, and a
 * library would cost more bytes than the shapes do. The specs here are the ones
 * that make charts readable rather than decorative — 2px lines, ≤24px bars with
 * a rounded data-end, hairline gridlines a step off the surface, a 2px surface
 * gap between touching marks, and labels that are placed selectively rather than
 * on every value.
 *
 * Colour is assigned by the job the data does, not by taste:
 *   - one measure over time, or magnitude across a list -> a single hue
 *   - an ordered scale (Q1..Q4) -> one hue, dark to light, with grey for
 *     "no quartile", which is an absence rather than a rank
 * Nothing here needs a categorical palette, so nothing here can collide under
 * colour-blindness. Every value is also reachable as text: each chart has a
 * table view behind a toggle.
 */
import { useId, useMemo, useState } from "react"

import { formatMoney } from "@/components/ticket-ui"
import { cn } from "@/lib/utils"

/** One bar, slice or point. `amount` is absent wherever the reader is not
 *  allowed money -- a head of department's charts carry counts only. */
export type Point = { key: string; count: number; amount?: number; label?: string }

/** Compact rupees for an axis — a full ₹27,59,600 on every tick is unreadable. */
export function shortMoney(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`
  if (abs >= 1e3) return `₹${Math.round(n / 1e3)}k`
  return `₹${Math.round(n)}`
}

function niceCeiling(max: number): number {
  if (max <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(max))
  return Math.ceil(max / mag) * mag
}

/** Shell: title, the "show the numbers" escape hatch, and the table itself. */
function Figure({
  title,
  caption,
  rows,
  columns,
  children,
  className,
}: {
  title: string
  caption?: string
  rows: (string | number)[][]
  columns: string[]
  children: React.ReactNode
  className?: string
}) {
  const [showTable, setShowTable] = useState(false)
  return (
    <figure className={cn("surface-card min-w-0 p-5", className)}>
      <figcaption className="mb-4 flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="text-eyebrow block">{title}</span>
          {caption ? (
            <span className="mt-1 block text-xs text-muted-foreground">{caption}</span>
          ) : null}
        </span>
        {/* Every figure is reachable as text, for a screen reader, for copying
            into a report, and for anyone the colours do not work for. */}
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="interactive shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={showTable}
        >
          {showTable ? "Show chart" : "Show numbers"}
        </button>
      </figcaption>

      {showTable ? (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {columns.map((c) => (
                  <th key={c} className="text-eyebrow whitespace-nowrap px-2 py-1.5">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td
                      key={j}
                      className={cn("px-2 py-1.5", j > 0 && "text-right tabular-nums")}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </figure>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Money over time. One measure, one hue — so no legend: the title says what is
 * plotted. Claim count rides in the tooltip rather than on a second y-axis,
 * because two scales on one frame is the fastest way to make a chart lie.
 */
export function TrendChart({
  data,
  title,
  caption,
  /** What one point is. Names the table column and the spoken summary. */
  unit = "month",
  measure = "money",
}: {
  data: Point[]
  title: string
  caption?: string
  unit?: "month" | "year"
  /** What the line is made of. Not every reader of this kit has money. */
  measure?: "money" | "count"
}) {
  const valueOf = (d: Point) => (measure === "count" ? d.count : d.amount ?? 0)
  const formatValue = (n: number) =>
    measure === "count" ? n.toLocaleString() : formatMoney(n)
  const gid = useId()
  const [hover, setHover] = useState<number | null>(null)
  const W = 720
  const H = 240
  const PAD = { top: 16, right: 16, bottom: 28, left: 56 }

  const { path, area, pts, max } = useMemo(() => {
    const max = niceCeiling(Math.max(...data.map(valueOf), 1))
    const iw = W - PAD.left - PAD.right
    const ih = H - PAD.top - PAD.bottom
    const x = (i: number) => PAD.left + (data.length < 2 ? iw / 2 : (i / (data.length - 1)) * iw)
    const y = (v: number) => PAD.top + ih - (v / max) * ih
    const pts = data.map((d, i) => ({ x: x(i), y: y(valueOf(d)), d }))
    const path = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
    const area =
      pts.length > 1
        ? `${path} L${pts[pts.length - 1].x.toFixed(1)},${(PAD.top + ih).toFixed(1)} L${pts[0].x.toFixed(1)},${(PAD.top + ih).toFixed(1)} Z`
        : ""
    return { path, area, pts, max }
  }, [data])

  if (!data.length) return null
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f)
  const peak = data.reduce((a, b) => (valueOf(b) > valueOf(a) ? b : a), data[0])
  const peakIndex = data.indexOf(peak)
  const active = hover ?? peakIndex

  return (
    <Figure
      title={title}
      caption={caption}
      columns={[
        unit === "month" ? "Month" : "Year",
        "Claims",
        measure === "count" ? "Publications" : "Paid",
      ]}
      rows={data.map((d) => [d.key, d.count, formatValue(valueOf(d))])}
    >
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`${title}. ${data.length} ${unit}s, peak ${formatValue(valueOf(peak))} in ${peak.key}.`}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`${gid}-wash`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {ticks.map((t) => {
            const y = PAD.top + (H - PAD.top - PAD.bottom) * (1 - t / max)
            return (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={y}
                  y2={y}
                  stroke="var(--chart-grid)"
                  strokeWidth="1"
                />
                <text
                  x={PAD.left - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px] tabular-nums"
                >
                  {measure === "count" ? t.toLocaleString() : shortMoney(t)}
                </text>
              </g>
            )
          })}

          {area ? <path d={area} fill={`url(#${gid}-wash)`} /> : null}
          <path
            d={path}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* The marker carries a surface ring so it stays legible on the line. */}
          {pts[active] ? (
            <g>
              <line
                x1={pts[active].x}
                x2={pts[active].x}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke="var(--chart-grid)"
                strokeWidth="1"
              />
              <circle
                cx={pts[active].x}
                cy={pts[active].y}
                r="5"
                fill="var(--chart-1)"
                stroke="var(--card)"
                strokeWidth="2"
              />
            </g>
          ) : null}

          {/* Hit targets are far wider than the marks. */}
          {pts.map((p, i) => (
            <rect
              key={i}
              x={p.x - (W - PAD.left - PAD.right) / (2 * Math.max(data.length - 1, 1))}
              y={PAD.top}
              width={(W - PAD.left - PAD.right) / Math.max(data.length - 1, 1)}
              height={H - PAD.top - PAD.bottom}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}

          {/* Every nth month, plus the last one -- but not both when they are
              neighbours: at 30 points the stride landed on 28 and the forced
              last tick on 29, and the two labels overlapped. */}
          {(() => {
            const stride = Math.max(1, Math.ceil(data.length / 8))
            const last = data.length - 1
            const idx = data
              .map((_, i) => i)
              .filter((i) => i % stride === 0 && last - i >= stride / 2)
            if (last >= 0) idx.push(last)
            return idx.map((i) => (
              <text
                key={data[i].key}
                x={pts[i].x}
                y={H - 8}
                textAnchor={i === last ? "end" : i === 0 ? "start" : "middle"}
                className="fill-muted-foreground text-[10px]"
              >
                {data[i].label || (unit === "month" ? data[i].key.slice(2) : data[i].key)}
              </text>
            ))
          })()}
        </svg>

        {pts[active] ? (
          <div
            className="pointer-events-none absolute top-1 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-[var(--shadow-e2)]"
            style={{
              left: `${(pts[active].x / W) * 100}%`,
              transform:
                pts[active].x > W * 0.6 ? "translateX(-105%)" : "translateX(5%)",
            }}
          >
            <div className="font-medium text-foreground">{data[active].key}</div>
            <div className="tabular-nums text-muted-foreground">
              {formatValue(valueOf(data[active]))}
              {measure === "count" ? "" : ` · ${data[active].count} claims`}
            </div>
          </div>
        ) : null}
      </div>
    </Figure>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Magnitude across a list — departments. Horizontal because the names are long,
 * sorted because the reader's question is "who is biggest", and one hue because
 * these are not distinct series, they are the same measure many times.
 */
export function RankedBars({
  data,
  title,
  caption,
  limit = 12,
  unit = "money",
  itemNoun = "claim",
}: {
  data: Point[]
  title: string
  caption?: string
  limit?: number
  unit?: "money" | "count"
  /** What one row counts. "claim" is payment vocabulary, and a head of
   *  department is counting publications, not claims. */
  itemNoun?: string
}) {
  const [hover, setHover] = useState<string | null>(null)
  const value = (d: Point) => (unit === "money" ? d.amount ?? 0 : d.count)
  const sorted = useMemo(
    () => [...data].sort((a, b) => value(b) - value(a)),
    [data, unit]
  )
  const shown = sorted.slice(0, limit)
  const rest = sorted.slice(limit)
  const restTotal = rest.reduce((s, d) => s + value(d), 0)
  const max = Math.max(...shown.map(value), 1)
  const fmt = (n: number) => (unit === "money" ? formatMoney(n) : String(n))

  if (!data.length) return null
  return (
    <Figure
      title={title}
      caption={caption}
      columns={["Department", "Claims", "Paid", "Average"]}
      rows={sorted.map((d) => [
        d.label || d.key,
        d.count,
        formatMoney(d.amount ?? 0),
        formatMoney(d.count ? (d.amount ?? 0) / d.count : 0),
      ])}
    >
      <ul className="space-y-2.5">
        {shown.map((d) => {
          const pct = (value(d) / max) * 100
          const isHover = hover === d.key
          return (
            <li
              key={d.key}
              onMouseEnter={() => setHover(d.key)}
              onMouseLeave={() => setHover(null)}
              className="min-w-0"
            >
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-foreground">{d.label || d.key}</span>
                {/* The value is labelled directly, so the bar never has to be
                    measured against an axis. */}
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {fmt(value(d))}
                  <span className="ml-2 opacity-60">
                    {d.count} {d.count === 1 ? itemNoun : `${itemNoun}s`}
                  </span>
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-[width,opacity] duration-300"
                  style={{
                    width: `${Math.max(pct, 1)}%`,
                    background: "var(--chart-1)",
                    opacity: isHover ? 1 : 0.85,
                  }}
                />
              </div>
            </li>
          )
        })}
      </ul>
      {rest.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {rest.length} more {rest.length === 1 ? "department" : "departments"},{" "}
          {fmt(restTotal)} between them — “Show numbers” lists every one.
        </p>
      ) : null}
    </Figure>
  )
}

/* ------------------------------------------------------------------ */

const QUARTILE_ORDER = ["Q1", "Q2", "Q3", "Q4"]
/** One hue, dark to light, because Q1..Q4 is a rank. Absences are grey: "no
 *  quartile" is not a better or worse rank, it is a missing one. */
const QUARTILE_FILL: Record<string, string> = {
  Q1: "var(--chart-seq-700)",
  Q2: "var(--chart-seq-550)",
  Q3: "var(--chart-seq-450)",
  Q4: "var(--chart-seq-300)",
}

export function MixBar({
  data,
  title,
  caption,
  measure = "money",
  dimension = "Quartile",
}: {
  data: Point[]
  title: string
  caption?: string
  /** Share of what: money by default, or of the count. */
  measure?: "money" | "count"
  /** What the rows are. Names the first column of the table behind the chart. */
  dimension?: string
}) {
  const share = (d: Point) => (measure === "count" ? d.count : d.amount ?? 0)
  const formatShare = (n: number) =>
    measure === "count" ? n.toLocaleString() : formatMoney(n)
  const [hover, setHover] = useState<string | null>(null)
  const ordered = useMemo(() => {
    const rank = (k: string) => {
      const i = QUARTILE_ORDER.indexOf(k)
      return i === -1 ? 99 : i
    }
    return [...data].sort((a, b) => rank(a.key) - rank(b.key) || share(b) - share(a))
  }, [data])
  const total = ordered.reduce((s, d) => s + share(d), 0)
  if (!total) return null

  return (
    <Figure
      title={title}
      caption={caption}
      // MixBar was written for quartiles and hard-coded the word, so a chart
      // of remuneration categories showed a column headed "Quartile" over
      // values that were nothing of the kind.
      columns={[
        dimension,
        "Claims",
        measure === "count" ? "Publications" : "Paid",
        "Share",
      ]}
      rows={ordered.map((d) => [
        d.key,
        d.count,
        formatShare(share(d)),
        `${total ? ((share(d) / total) * 100).toFixed(1) : "0.0"}%`,
      ])}
    >
      {/* gap-[2px] is the surface gap: neighbouring segments read as separate
          because of the space between them, not a stroke drawn around them. */}
      <div className="flex h-8 w-full gap-[2px] overflow-hidden rounded-md">
        {ordered.map((d) => (
          <div
            key={d.key}
            onMouseEnter={() => setHover(d.key)}
            onMouseLeave={() => setHover(null)}
            title={`${d.key}: ${formatShare(share(d))}`}
            style={{
              width: `${Math.max(total ? (share(d) / total) * 100 : 0, 0.6)}%`,
              background: QUARTILE_FILL[d.key] || "var(--chart-absent)",
              opacity: hover && hover !== d.key ? 0.45 : 1,
            }}
            className="h-full transition-opacity duration-200"
          />
        ))}
      </div>

      {/* A legend is always present once there are two or more classes, so
          identity never rests on colour alone. */}
      <ul className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {ordered.map((d) => (
          <li
            key={d.key}
            className="flex items-baseline justify-between gap-3"
            onMouseEnter={() => setHover(d.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ background: QUARTILE_FILL[d.key] || "var(--chart-absent)" }}
              />
              <span className="truncate text-sm text-foreground">{d.key}</span>
            </span>
            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
              {formatShare(share(d))}
              <span className="ml-2 opacity-60">
                {total ? ((share(d) / total) * 100).toFixed(0) : "0"}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Figure>
  )
}

/* ------------------------------------------------------------------ */

export type Stage = {
  key: string
  label: string
  blurb: string
  count: number
  amount: number
  median_age_days: number
  oldest_age_days: number
}

/**
 * Where work is sitting, and how long it has sat.
 *
 * Not "average days from submission to payment": the imported history carries a
 * single timestamp per row, so any duration measured across it would come out
 * near zero and read as instant processing. The age of what is waiting now is a
 * real number, and it is the one somebody can act on.
 */
export function PipelineChart({
  stages,
  title,
  caption,
}: {
  stages: Stage[]
  title: string
  caption?: string
}) {
  const waiting = stages.filter((s) => s.key === "SUBMITTED" || s.key === "CLEARED")
  const settled = stages.filter((s) => s.key !== "SUBMITTED" && s.key !== "CLEARED")
  // Scaled against the queue, not the archive. Sharing one linear scale with
  // 3,137 settled claims squashed "89 awaiting clearance, oldest 48 days" into
  // a sliver -- the one row anybody can act on, drawn as the smallest mark on
  // the chart. Settled work is context, so it is reported as a figure rather
  // than competing for the same axis.
  const max = Math.max(...waiting.map((s) => s.count), 1)
  const queued = waiting.reduce((n, s) => n + s.count, 0)
  if (!stages.length) return null

  return (
    <Figure
      title={title}
      caption={caption}
      columns={["Stage", "Claims", "Value", "Median age", "Oldest"]}
      rows={stages.map((s) => [
        s.label,
        s.count,
        formatMoney(s.amount),
        `${s.median_age_days}d`,
        `${s.oldest_age_days}d`,
      ])}
    >
      {queued === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Nothing is waiting — every claim is settled or returned.
        </p>
      ) : (
        <ol className="space-y-3">
          {waiting.map((s) => (
            <li key={s.key} className="min-w-0">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="text-sm text-foreground">{s.label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{s.blurb}</span>
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {s.count.toLocaleString("en-IN")}
                  {s.count > 0 ? (
                    <span className="ml-2 opacity-70">oldest {s.oldest_age_days}d</span>
                  ) : null}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max((s.count / max) * 100, s.count ? 2 : 0)}%`,
                    background: "var(--chart-2)",
                  }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4">
        {settled.map((s) => (
          <div key={s.key} className="min-w-0">
            <dt className="text-eyebrow truncate">{s.label}</dt>
            <dd className="text-metric-sm tabular-nums text-muted-foreground">
              {s.count.toLocaleString("en-IN")}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-xs text-muted-foreground">
        Ages are how long a ticket has been waiting, not how long processing took —
        imported history carries one timestamp per row, so a duration across it
        would read as instant.
      </p>
    </Figure>
  )
}
