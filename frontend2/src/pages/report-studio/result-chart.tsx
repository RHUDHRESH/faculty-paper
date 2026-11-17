import { useEffect, useRef, useState } from "react"

import { formatCell, rowObjects, type ChartHint, type ResultColumn, type RunResult } from "./model"

/**
 * A result as a bar, line or pie chart, in plain SVG.
 *
 * Drawn at the width the box really has (not scaled from a fixed canvas), so
 * a label is 12 px on a phone as well as on a desk and never shrinks below
 * what can be read. Every chart has the figures one scroll away in the table
 * under it, and a written summary for a screen reader, so the picture is a
 * second way in and never the only one.
 */

export type ChartKind = "bar" | "line" | "pie"

export type ChartPoint = { label: string; value: number; shown: string }

const SLICE_COLOURS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"]
const OTHERS_COLOUR = "var(--color-fg-subtle)"

/** The kinds of chart the server may hint at, as ours. Anything else is a bar. */
export function chartKindOf(hint: ChartHint | null): ChartKind | null {
  if (!hint || !hint.kind) return null
  const k = hint.kind.toLowerCase()
  if (k === "line" || k === "area" || k === "trend") return "line"
  if (k === "pie" || k === "donut") return "pie"
  return "bar"
}

/** Which two columns the chart is about: the hint's, or the first of each kind. */
export function chartColumns(result: RunResult): { x: ResultColumn; y: ResultColumn } | null {
  const by = (key: string | null) => result.columns.find((c) => c.key === key)
  const isNumber = (c: ResultColumn) => c.type === "number" || c.type === "money"
  const y = by(result.chart_hint?.y ?? null) ?? result.columns.find(isNumber)
  const x = by(result.chart_hint?.x ?? null) ?? result.columns.find((c) => c !== y && !isNumber(c)) ?? result.columns.find((c) => c !== y)
  return x && y ? { x, y } : null
}

export function chartPoints(result: RunResult): ChartPoint[] {
  const cols = chartColumns(result)
  if (!cols) return []
  return rowObjects(result).flatMap((row): ChartPoint[] => {
    const value = Number(row[cols.y.key])
    if (row[cols.y.key] === null || row[cols.y.key] === undefined || !Number.isFinite(value)) return []
    return [
      {
        label: formatCell(cols.x.type, row[cols.x.key]) ?? "Not recorded",
        value,
        shown: formatCell(cols.y.type, value) ?? String(value),
      },
    ]
  })
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(Math.floor(el.getBoundingClientRect().width))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

const compact = (n: number) =>
  Math.abs(n) >= 1e7
    ? `${(n / 1e7).toFixed(1)} Cr`
    : Math.abs(n) >= 1e5
      ? `${(n / 1e5).toFixed(1)} L`
      : Math.round(n * 100) / 100 === Math.round(n)
        ? Math.round(n).toLocaleString("en-IN")
        : n.toLocaleString("en-IN", { maximumFractionDigits: 1 })

const BAR_LIMIT = 15

export function ResultChart({ result, kind }: { result: RunResult; kind: ChartKind }) {
  const [box, measured] = useWidth()
  const cols = chartColumns(result)
  const all = chartPoints(result)
  // jsdom and a not-yet-laid-out box both measure 0: draw at a sensible width.
  const width = measured > 0 ? measured : 560

  if (!cols || all.length === 0) {
    return <p className="py-6 text-center text-base text-fg-muted">There is nothing to draw a chart of in this result.</p>
  }

  const title = `${cols.y.label} by ${cols.x.label}`
  const summary = `${kind === "bar" ? "Bar" : kind === "line" ? "Line" : "Pie"} chart of ${title}, ${all.length} ${all.length === 1 ? "value" : "values"}. The same figures are in the table below.`

  return (
    <figure ref={box} className="min-w-0 space-y-2">
      <figcaption className="text-base font-semibold text-fg">{title}</figcaption>
      {kind === "bar" && <Bars points={all} width={width} summary={summary} />}
      {kind === "line" && <Line points={all} width={width} summary={summary} />}
      {kind === "pie" && <Pie points={all} width={width} summary={summary} />}
    </figure>
  )
}

/* ------------------------------------------------------------------ bars */

const ROW = 46

function Bars({ points, width, summary }: { points: ChartPoint[]; width: number; summary: string }) {
  const shown = points.slice(0, BAR_LIMIT)
  const top = Math.max(1, ...shown.map((p) => Math.abs(p.value)))
  const valueRoom = 96
  const barMax = Math.max(40, width - valueRoom)
  const perChar = 7.5
  return (
    <>
      <svg width={width} height={shown.length * ROW} role="img" aria-label={summary}>
        {shown.map((p, i) => {
          const y = i * ROW
          const w = Math.max(2, (Math.abs(p.value) / top) * barMax)
          return (
            <g key={`${i}-${p.label}`}>
              <title>{`${p.label}: ${p.shown}`}</title>
              <text x={0} y={y + 15} className="fill-fg text-xs">
                {cut(p.label, Math.floor(width / perChar))}
              </text>
              <rect x={0} y={y + 22} width={w} height={16} rx={3} fill="var(--chart-1)" />
              <text x={w + 8} y={y + 35} className="tabular fill-fg text-xs font-medium">
                {p.shown}
              </text>
            </g>
          )
        })}
      </svg>
      {points.length > BAR_LIMIT && (
        <p className="text-sm text-fg-muted">
          Showing the first {BAR_LIMIT} of {points.length.toLocaleString("en-IN")}. The table has all of them.
        </p>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ line */

function Line({ points, width, summary }: { points: ChartPoint[]; width: number; summary: string }) {
  const height = 240
  const pad = { l: 56, r: 12, t: 12, b: 28 }
  const iw = Math.max(40, width - pad.l - pad.r)
  const ih = height - pad.t - pad.b
  const max = Math.max(...points.map((p) => p.value), 0)
  const min = Math.min(...points.map((p) => p.value), 0)
  const span = max - min || 1
  const x = (i: number) => pad.l + (points.length < 2 ? iw / 2 : (i / (points.length - 1)) * iw)
  const y = (v: number) => pad.t + ih - ((v - min) / span) * ih
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ")
  // About one label per 72 px, so "Apr 2026" never lands on its neighbour.
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(iw / 72))))
  return (
    <svg width={width} height={height} role="img" aria-label={summary}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={width - pad.r} y1={pad.t + ih * f} y2={pad.t + ih * f} stroke="var(--color-line)" />
          <text x={pad.l - 8} y={pad.t + ih * f + 4} textAnchor="end" className="tabular fill-fg-muted text-xs">
            {compact(max - span * f)}
          </text>
        </g>
      ))}
      <path d={path} fill="none" stroke="var(--chart-1)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={`${i}-${p.label}`}>
          <circle cx={x(i)} cy={y(p.value)} r={4} fill="var(--color-surface)" stroke="var(--chart-1)" strokeWidth={2}>
            <title>{`${p.label}: ${p.shown}`}</title>
          </circle>
          {i % every === 0 && (
            <text x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : "middle"} className="fill-fg-muted text-xs">
              {cut(p.label, 12)}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

/* ------------------------------------------------------------------- pie */

function Pie({ points, width, summary }: { points: ChartPoint[]; width: number; summary: string }) {
  const positive = points.filter((p) => p.value > 0).sort((a, b) => b.value - a.value)
  const head = positive.slice(0, SLICE_COLOURS.length)
  const rest = positive.slice(SLICE_COLOURS.length)
  const slices = [
    ...head.map((p, i) => ({ label: p.label, value: p.value, colour: SLICE_COLOURS[i] })),
    ...(rest.length > 0 ? [{ label: `Others (${rest.length})`, value: rest.reduce((n, p) => n + p.value, 0), colour: OTHERS_COLOUR }] : []),
  ]
  const total = slices.reduce((n, s) => n + s.value, 0)
  if (total <= 0) return <p className="py-6 text-center text-base text-fg-muted">A pie needs figures above zero.</p>

  const size = Math.min(240, Math.max(160, width - 8))
  const r = size / 2 - 4
  const c = size / 2
  let angle = -Math.PI / 2
  const arcs = slices.map((s) => {
    const sweep = (s.value / total) * Math.PI * 2
    const a0 = angle
    angle += sweep
    const large = sweep > Math.PI ? 1 : 0
    const pt = (a: number) => `${c + r * Math.cos(a)},${c + r * Math.sin(a)}`
    // One slice is a whole circle, which an arc cannot draw: two half arcs.
    const d =
      slices.length === 1
        ? `M${c},${c - r} A${r},${r} 0 1 1 ${c},${c + r} A${r},${r} 0 1 1 ${c},${c - r} Z`
        : `M${c},${c} L${pt(a0)} A${r},${r} 0 ${large} 1 ${pt(a0 + sweep)} Z`
    return { ...s, d }
  })

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
      <svg width={size} height={size} role="img" aria-label={summary} className="shrink-0">
        {arcs.map((a) => (
          <path key={a.label} d={a.d} fill={a.colour} stroke="var(--color-surface)" strokeWidth={2}>
            <title>{`${a.label}: ${((a.value / total) * 100).toFixed(1)}%`}</title>
          </path>
        ))}
      </svg>
      <ul className="min-w-0 flex-1 basis-48 space-y-1.5 text-base">
        {arcs.map((a) => (
          <li key={a.label} className="flex items-center gap-2">
            <span aria-hidden className="size-3 shrink-0 rounded-sm" style={{ background: a.colour }} />
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            <span className="tabular shrink-0 text-fg-muted">{((a.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
