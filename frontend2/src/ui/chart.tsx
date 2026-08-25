import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/cn"
import { money } from "@/ui/paper"

/**
 * Charts, without a charting library.
 *
 * Four shapes cover every question this app actually asks — how something
 * moved over time, how a set ranks, what a total is made of, how a quantity is
 * spread. A library would bring twenty more and 200kB, and would still need
 * wrapping to obey the palette and to be readable without a mouse.
 *
 * Three rules hold across all four:
 *
 * 1. **Every chart is also a table.** Under each one is "Show the numbers",
 *    and it opens a real table with real figures. A bar you can only estimate
 *    by eye is decoration; somebody comparing two departments needs the two
 *    numbers, and somebody using a screen reader needs them to exist at all.
 *
 * 2. **A bar that stands for something goes there.** If a row is a person or a
 *    journal, its label is a link. The old app drew a chart of the top ten
 *    authors and then made you type their names into a search box.
 *
 * 3. **The value is said once.** A chart of paper counts labelled "797 797
 *    claims" is what happens when the shell prints the count and the row does
 *    too. The row states the charted quantity; the table states everything.
 *
 * HTML for the ranked and mix charts — real text that truncates, links that
 * are links. SVG only for trend and distribution, which need a real axis.
 */

export type Point = {
  key: string
  /** What to show, if different from the key. */
  label?: string
  count: number
  amount?: number
  /** Where this row lives, if it is a thing with a page of its own. */
  to?: string
}

/** Which number the chart is drawing. */
export type Unit = "count" | "money"

const valueOf = (p: Point, unit: Unit) => (unit === "money" ? (p.amount ?? 0) : p.count)

/** Compact rupees for an axis — the full figure on every tick is unreadable. */
export function shortMoney(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`
  if (abs >= 1e3) return `₹${Math.round(n / 1e3)}k`
  return `₹${Math.round(n)}`
}

const axisLabel = (n: number, unit: Unit) =>
  unit === "money" ? shortMoney(n) : Math.round(n).toLocaleString("en-IN")

const fullLabel = (n: number, unit: Unit) =>
  unit === "money" ? money(n) : n.toLocaleString("en-IN")

/**
 * A round number at or above the top of the data, so gridlines read cleanly.
 *
 * The steps are close together on purpose. With only 1, 2, 5 and 10 to choose
 * from, a set topping out at 604 gets a ceiling of 1000 and the tallest bar
 * fills three-fifths of the box — the chart looks like the numbers are small
 * when they are not. Going to 800 costs nothing in legibility and uses the
 * space the chart was given.
 */
const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

function niceCeiling(max: number): number {
  if (max <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(max))
  const step = STEPS.find((s) => max / mag <= s) ?? 10
  return step * mag
}

/**
 * Width of the box, in real pixels, so an SVG can lay out honestly.
 *
 * Measured synchronously before the first paint, then watched. Watching alone
 * is not enough: a ResizeObserver reports asynchronously and, in a browser
 * that is not compositing the page — a hidden pane, a headless render, a
 * print view — it may never report at all. A chart that waits for it draws
 * nothing, forever, and there is no error to find. So the first measurement
 * comes from `clientWidth`, which is always there, and the observer only ever
 * corrects it.
 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)

    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The observer covers a box that changes without the window doing so — a
  // sidebar collapsing. This covers the reverse, in case it is not running.
  useEffect(() => {
    const onResize = () => ref.current && setW(ref.current.clientWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  return [ref, w] as const
}

/**
 * The shell every chart sits in: a title, the chart, and the numbers behind it.
 *
 * `dimension` names what the rows *are* — "Department", "Journal", "Year". The
 * old app hardcoded "Department" as that column's header on every chart it
 * drew, including the one about journals.
 */
function Figure({
  title,
  caption,
  dimension,
  unit,
  points,
  total,
  showAmounts = true,
  children,
  className,
}: {
  title: string
  caption?: ReactNode
  dimension: string
  unit: Unit
  points: Point[]
  /** Denominator for the share column. Defaults to the sum of what is drawn. */
  total?: number
  /**
   * Whether the numbers table may show a Paid column. Default true.
   *
   * `unit="count"` says what to *draw*; it does not say what the table may
   * list, and the table deliberately states everything it has. So a chart of
   * paper counts still prints the amounts beside them — which is right for
   * most readers and wrong for a head of department, who must never see a
   * rupee figure by any route.
   *
   * Set it false on any screen a head can open. Better still, do not send the
   * amounts at all: a value the component never receives cannot be leaked by
   * the next person who adds a column here.
   */
  showAmounts?: boolean
  children: ReactNode
  className?: string
}) {
  const sum = total ?? points.reduce((n, p) => n + valueOf(p, unit), 0)
  const anyMoney = showAmounts && points.some((p) => p.amount != null)

  return (
    <section className={cn("min-w-0", className)}>
      <h3 className="text-lg font-semibold">{title}</h3>
      {caption ? <p className="mt-0.5 text-sm text-fg-muted">{caption}</p> : null}

      <div className="mt-4 min-w-0">{children}</div>

      {points.length > 0 && (
        <details className="group mt-3">
          <summary
            className={cn(
              "inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm",
              "text-sm text-fg-muted hover:text-fg"
            )}
          >
            <span className="inline-block transition-transform duration-[var(--dur-2)] group-open:rotate-90">
              ›
            </span>
            Show the numbers
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[22rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-fg-muted">
                  <th className="py-1.5 pr-3 font-medium">{dimension}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Papers</th>
                  {anyMoney && <th className="py-1.5 pr-3 text-right font-medium">Paid</th>}
                  <th className="py-1.5 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.key} className="border-b border-line last:border-0">
                    <td className="py-1.5 pr-3">
                      {p.to ? (
                        <Link to={p.to} className="hover:text-accent hover:underline">
                          {p.label ?? p.key}
                        </Link>
                      ) : (
                        (p.label ?? p.key)
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular">
                      {p.count.toLocaleString("en-IN")}
                    </td>
                    {anyMoney && (
                      <td className="py-1.5 pr-3 text-right tabular">{money(p.amount)}</td>
                    )}
                    <td className="py-1.5 text-right tabular text-fg-muted">
                      {sum > 0 ? `${((valueOf(p, unit) / sum) * 100).toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  )
}

function Nothing({ what }: { what: string }) {
  return <p className="py-8 text-center text-sm text-fg-muted">{what}</p>
}

/* ------------------------------------------------------------------ ranked */

/**
 * A ranked list, drawn as bars.
 *
 * Horizontal, because the labels are words — "Computer Science and
 * Engineering" is not going to fit under a vertical column, and rotating it
 * 45 degrees makes a reader tilt their head to use a report.
 */
export function RankedBars({
  title,
  caption,
  dimension,
  points,
  unit = "count",
  limit = 10,
  showAmounts,
  className,
}: {
  title: string
  caption?: ReactNode
  dimension: string
  points: Point[]
  unit?: Unit
  limit?: number
  /** See `Figure`. False on any screen a head of department can open. */
  showAmounts?: boolean
  className?: string
}) {
  const sorted = [...points].sort((a, b) => valueOf(b, unit) - valueOf(a, unit))
  const shown = sorted.slice(0, limit)
  const top = Math.max(1, ...shown.map((p) => valueOf(p, unit)))

  return (
    <Figure
      title={title}
      caption={caption}
      dimension={dimension}
      unit={unit}
      points={sorted}
      showAmounts={showAmounts}
      className={className}
    >
      {shown.length === 0 ? (
        <Nothing what="Nothing to rank yet." />
      ) : (
        <ul className="-mx-2">
          {shown.map((p) => {
            const v = valueOf(p, unit)
            const name = p.label ?? p.key
            return (
              <li
                key={p.key}
                className={cn(
                  "row grid h-8 items-center gap-3 rounded-md px-2",
                  "grid-cols-[7rem_minmax(0,1fr)_auto] sm:grid-cols-[12rem_minmax(0,1fr)_auto]"
                )}
              >
                {/* min-w-0 and overflow-hidden on the link, truncate on the
                    text inside it. Put truncate on the link alone and the link
                    becomes the grid item, which then sizes to its content and
                    pushes the bar off the end instead of clipping. */}
                {p.to ? (
                  <Link
                    to={p.to}
                    title={name}
                    className="min-w-0 overflow-hidden text-sm hover:text-accent hover:underline"
                  >
                    <span className="block truncate">{name}</span>
                  </Link>
                ) : (
                  <span className="min-w-0 overflow-hidden text-sm" title={name}>
                    <span className="block truncate">{name}</span>
                  </span>
                )}

                <span className="block h-1.5 min-w-0 overflow-hidden rounded-full bg-line">
                  <span
                    className="block h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                    style={{ width: `${(v / top) * 100}%` }}
                  />
                </span>

                <span className="tabular text-sm">{fullLabel(v, unit)}</span>
              </li>
            )
          })}
        </ul>
      )}

      {sorted.length > limit && (
        <p className="mt-2 px-2 text-sm text-fg-muted">
          {sorted.length - limit} more — in the numbers below.
        </p>
      )}
    </Figure>
  )
}

/* --------------------------------------------------------------------- mix */

/**
 * One bar, showing what a total is made of.
 *
 * A pie chart with eight slices asks a reader to compare angles, which nobody
 * can do. A single stacked bar asks them to compare lengths, which everybody
 * can, and it fits on a line.
 */
export function MixBar({
  title,
  caption,
  dimension,
  points,
  unit = "count",
  showAmounts,
  className,
}: {
  title: string
  caption?: ReactNode
  dimension: string
  points: Point[]
  unit?: Unit
  /** See `Figure`. False on any screen a head of department can open. */
  showAmounts?: boolean
  className?: string
}) {
  const sorted = [...points].sort((a, b) => valueOf(b, unit) - valueOf(a, unit))
  const sum = sorted.reduce((n, p) => n + valueOf(p, unit), 0)

  // Steps of the one accent rather than a set of hues. Eight arbitrary colours
  // means eight things to look up in a key; one colour fading means "more" and
  // "less", which is what the chart is about.
  const SHADE = ["bg-accent", "bg-accent/75", "bg-accent/55", "bg-accent/40", "bg-accent/28"]
  const shadeOf = (i: number) => SHADE[Math.min(i, SHADE.length - 1)]

  return (
    <Figure
      title={title}
      caption={caption}
      dimension={dimension}
      unit={unit}
      points={sorted}
      total={sum}
      showAmounts={showAmounts}
      className={className}
    >
      {sum === 0 ? (
        <Nothing what="Nothing to break down yet." />
      ) : (
        <>
          <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
            {sorted.map((p, i) => (
              <span
                key={p.key}
                className={cn("h-full first:rounded-l-full last:rounded-r-full", shadeOf(i))}
                style={{ width: `${(valueOf(p, unit) / sum) * 100}%` }}
                title={`${p.label ?? p.key} — ${fullLabel(valueOf(p, unit), unit)}`}
              />
            ))}
          </div>

          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
            {sorted.map((p, i) => {
              const name = p.label ?? p.key
              const share = ((valueOf(p, unit) / sum) * 100).toFixed(0)
              return (
                <li key={p.key} className="flex min-w-0 items-center gap-1.5 text-sm">
                  <span className={cn("size-2 shrink-0 rounded-full", shadeOf(i))} />
                  {p.to ? (
                    <Link to={p.to} className="truncate hover:text-accent hover:underline">
                      {name}
                    </Link>
                  ) : (
                    <span className="truncate">{name}</span>
                  )}
                  <span className="shrink-0 tabular text-fg-muted">{share}%</span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Figure>
  )
}

/* ------------------------------------------------------------------- trend */

/**
 * A quantity over time.
 *
 * Pointing anywhere along it reads out that period — the guide snaps to the
 * nearest point rather than the exact pixel, so a shaky hand still lands on a
 * month. Touch works the same way, which is why this listens for pointer
 * events rather than mouse events.
 */
export function Trend({
  title,
  caption,
  dimension,
  points,
  unit = "count",
  height = 180,
  showAmounts,
  className,
}: {
  title: string
  caption?: ReactNode
  dimension: string
  points: Point[]
  unit?: Unit
  height?: number
  /** See `Figure`. False on any screen a head of department can open. */
  showAmounts?: boolean
  className?: string
}) {
  const [box, w] = useWidth<HTMLDivElement>()
  const [at, setAt] = useState<number | null>(null)
  const gradId = useId()

  const PAD = { l: 46, r: 8, t: 10, b: 22 }
  const iw = Math.max(0, w - PAD.l - PAD.r)
  const ih = height - PAD.t - PAD.b

  const values = points.map((p) => valueOf(p, unit))
  const ceiling = niceCeiling(Math.max(...values, 0))
  const x = (i: number) => PAD.l + (points.length < 2 ? iw / 2 : (i / (points.length - 1)) * iw)
  const y = (v: number) => PAD.t + ih - (v / ceiling) * ih

  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(valueOf(p, unit))}`).join(" ")
  const area = points.length
    ? `${line} L${x(points.length - 1)},${PAD.t + ih} L${x(0)},${PAD.t + ih} Z`
    : ""

  // Enough labels to orient, never enough to collide. 56px is about the width
  // of "Mar 2026" at 12px.
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(iw / 56))))

  const hovered = at != null ? points[at] : null

  return (
    <Figure
      title={title}
      caption={caption}
      dimension={dimension}
      unit={unit}
      points={points}
      showAmounts={showAmounts}
      className={className}
    >
      <div ref={box} className="min-w-0">
        {points.length === 0 ? (
          <Nothing what="No history yet." />
        ) : (
          w > 0 && (
            <div className="relative">
              <svg
                width={w}
                height={height}
                role="img"
                aria-label={`${title}, ${points.length} periods from ${points[0].label ?? points[0].key} to ${points[points.length - 1].label ?? points[points.length - 1].key}. The figures are in the table below.`}
                onPointerMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const rel = e.clientX - rect.left - PAD.l
                  const i = Math.round((rel / Math.max(1, iw)) * (points.length - 1))
                  setAt(Math.min(points.length - 1, Math.max(0, i)))
                }}
                onPointerLeave={() => setAt(null)}
              >
                <defs>
                  <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.16" />
                    <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
                  </linearGradient>
                </defs>

                {[0, 0.5, 1].map((f) => (
                  <g key={f}>
                    <line
                      x1={PAD.l}
                      x2={w - PAD.r}
                      y1={PAD.t + ih * f}
                      y2={PAD.t + ih * f}
                      stroke="var(--color-line)"
                    />
                    <text
                      x={PAD.l - 8}
                      y={PAD.t + ih * f + 4}
                      textAnchor="end"
                      className="tabular fill-fg-subtle text-xs"
                    >
                      {axisLabel(ceiling * (1 - f), unit)}
                    </text>
                  </g>
                ))}

                <path d={area} fill={`url(#${gradId})`} />
                <path
                  d={line}
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />

                {points.map((p, i) =>
                  i % every === 0 || i === points.length - 1 ? (
                    <text
                      key={p.key}
                      x={x(i)}
                      y={height - 6}
                      textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                      className="fill-fg-subtle text-xs"
                    >
                      {p.label ?? p.key}
                    </text>
                  ) : null
                )}

                {at != null && (
                  <>
                    <line
                      x1={x(at)}
                      x2={x(at)}
                      y1={PAD.t}
                      y2={PAD.t + ih}
                      stroke="var(--color-edge)"
                    />
                    <circle
                      cx={x(at)}
                      cy={y(valueOf(points[at], unit))}
                      r="3.5"
                      fill="var(--color-bg)"
                      stroke="var(--color-accent)"
                      strokeWidth="2"
                    />
                  </>
                )}
              </svg>

              {hovered && at != null && (
                <div
                  className="pointer-events-none absolute top-0 whitespace-nowrap rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-pop"
                  style={{ left: Math.min(Math.max(x(at) - 40, 0), Math.max(0, w - 120)) }}
                >
                  <span className="font-medium">{hovered.label ?? hovered.key}</span>{" "}
                  {fullLabel(valueOf(hovered, unit), unit)}
                </div>
              )}
            </div>
          )
        )}
      </div>
    </Figure>
  )
}

/* ------------------------------------------------------------ distribution */

/**
 * How a quantity is spread — columns, in the order given.
 *
 * The order is the caller's, not sorted by size: a distribution is only
 * meaningful along its own axis. Sorting "2021, 2022, 2023" by height gives a
 * chart that answers a question nobody asked.
 */
export function Distribution({
  title,
  caption,
  dimension,
  points,
  unit = "count",
  height = 160,
  showAmounts,
  className,
}: {
  title: string
  caption?: ReactNode
  dimension: string
  points: Point[]
  unit?: Unit
  height?: number
  /** See `Figure`. False on any screen a head of department can open. */
  showAmounts?: boolean
  className?: string
}) {
  const [at, setAt] = useState<number | null>(null)
  const ceiling = niceCeiling(Math.max(1, ...points.map((p) => valueOf(p, unit))))

  return (
    <Figure
      title={title}
      caption={caption}
      dimension={dimension}
      unit={unit}
      points={points}
      showAmounts={showAmounts}
      className={className}
    >
      {points.length === 0 ? (
        <Nothing what="Nothing to plot yet." />
      ) : (
        <div className="min-w-0">
          <div
            className="flex items-end gap-1 border-b border-line"
            style={{ height }}
            onPointerLeave={() => setAt(null)}
          >
            {points.map((p, i) => {
              const v = valueOf(p, unit)
              const name = p.label ?? p.key
              const bar = (
                <span
                  className={cn(
                    "block w-full rounded-t-sm transition-[height,background-color] duration-500 ease-out",
                    at === i ? "bg-accent" : "bg-accent/55"
                  )}
                  style={{ height: `${Math.max(2, (v / ceiling) * 100)}%` }}
                />
              )
              return (
                <span
                  key={p.key}
                  className="flex h-full min-w-0 flex-1 items-end"
                  onPointerEnter={() => setAt(i)}
                  title={`${name} — ${fullLabel(v, unit)}`}
                >
                  {p.to ? (
                    <Link
                      to={p.to}
                      className="flex h-full w-full items-end"
                      aria-label={`${name}: ${fullLabel(v, unit)}`}
                    >
                      {bar}
                    </Link>
                  ) : (
                    bar
                  )}
                </span>
              )
            })}
          </div>

          <div className="mt-1.5 flex gap-1">
            {points.map((p, i) => (
              <span
                key={p.key}
                className={cn(
                  "min-w-0 flex-1 truncate text-center text-xs",
                  at === i ? "text-fg" : "text-fg-subtle"
                )}
              >
                {p.label ?? p.key}
              </span>
            ))}
          </div>

          {/* Fixed height, so reading along the row does not shift the page. */}
          <p className="mt-2 h-5 text-center text-sm text-fg-muted">
            {at != null
              ? `${points[at].label ?? points[at].key} — ${fullLabel(valueOf(points[at], unit), unit)}`
              : ""}
          </p>
        </div>
      )}
    </Figure>
  )
}
