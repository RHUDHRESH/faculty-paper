import { useNavigate } from "react-router-dom"

import { cn } from "@/lib/cn"

export type StripMonth = { month: string; papers: number }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** 0..4: none, 1, 2, 3–4, 5+ papers in the month. */
export function shadeOf(papers: number): 0 | 1 | 2 | 3 | 4 {
  if (papers <= 0) return 0
  if (papers === 1) return 1
  if (papers === 2) return 2
  if (papers <= 4) return 3
  return 4
}

const SHADE_AREA = [
  "bg-sunken shadow-[inset_0_0_0_1px_var(--color-line)]",
  "bg-(--area-fill)/25",
  "bg-(--area-fill)/50",
  "bg-(--area-fill)/75",
  "bg-(--area-fill)",
]
/** A 40 px invisible hit area around each square (WCAG 2.5.8). Neighbours
 *  overlap, so a tap between two squares goes to the later one. */
export const TAP_TARGET =
  "relative before:absolute before:left-1/2 before:top-1/2 before:size-10 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"

const SHADE_SOLID =["bg-white/10", "bg-white/35", "bg-white/55", "bg-white/80", "bg-area-honours-fill"]

export function cellName(month: string, papers: number): string {
  const [y, m] = month.split("-").map(Number)
  return `${LONG[m - 1]} ${y}, ${papers} ${papers === 1 ? "paper" : "papers"}`
}

/**
 * A GitHub-style year-by-month record (docs/ux/00 §8). Columns are the last
 * `years` years and rows are months; `compact` draws one row of 12 per year.
 * Every cell is a real button ("March 2024, 2 papers"); clicking goes to
 * `hrefFor(month)` (default `/papers?month=YYYY-MM`) or calls `onSelect`.
 *
 * `tone="solid"` is for the navy Home hero: white cells, gold for 5+.
 */
export function RecordStrip({
  data,
  years = 10,
  endYear = new Date().getFullYear(),
  variant = "grid",
  tone = "area",
  onSelect,
  hrefFor = (m) => `/papers?month=${m}`,
  label = "Papers by month",
  className,
}: {
  data: StripMonth[]
  years?: number
  endYear?: number
  variant?: "grid" | "compact"
  tone?: "area" | "solid"
  onSelect?: (month: string) => void
  hrefFor?: ((month: string) => string) | null
  label?: string
  className?: string
}) {
  const navigate = useNavigate()
  const counts = new Map(data.map((d) => [d.month, d.papers]))
  const yrs = Array.from({ length: years }, (_, i) => endYear - years + 1 + i)
  const shades = tone === "solid" ? SHADE_SOLID : SHADE_AREA
  const pick = (month: string) => {
    if (onSelect) onSelect(month)
    else if (hrefFor) navigate(hrefFor(month))
  }
  const cell = (y: number, m: number) => {
    const month = `${y}-${String(m + 1).padStart(2, "0")}`
    const n = counts.get(month) ?? 0
    const name = cellName(month, n)
    return (
      <button
        key={month}
        type="button"
        aria-label={name}
        title={`${MONTHS[m]} ${y} · ${n} ${n === 1 ? "paper" : "papers"}`}
        onClick={() => pick(month)}
        className={cn(
          "size-3 rounded-[3px] sm:size-3.5",
          TAP_TARGET,
          shades[shadeOf(n)]
        )}
      />
    )
  }
  if (variant === "compact") {
    return (
      <div role="group" aria-label={label} className={cn("flex flex-col gap-1", className)}>
        {yrs.map((y) => (
          <div key={y} className="flex items-center gap-1">
            <span className="w-10 text-xs tabular opacity-70">{y}</span>
            {MONTHS.map((_, m) => cell(y, m))}
          </div>
        ))}
      </div>
    )
  }
  return (
    <div role="group" aria-label={label} className={cn("overflow-x-auto", className)}>
      <div className="inline-grid grid-flow-col gap-1" style={{ gridTemplateRows: "repeat(13, auto)" }}>
        {yrs.map((y) => [
          <span key={`h${y}`} className="text-center text-[10px] leading-3 tabular opacity-70">
            {String(y).slice(2)}
          </span>,
          ...MONTHS.map((_, m) => cell(y, m)),
        ])}
      </div>
    </div>
  )
}
