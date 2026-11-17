import { Select } from "@/ui/field"
import { cn } from "@/lib/cn"
import { VerticalTabs, type StripItem } from "@/ui/vertical-tabs"

/**
 * The period of a board, chosen from a vertical strip on the left (a segmented
 * control across the top on a phone), with a month or a year picker under it
 * for the first two. The Top 5 and the standings both stand on it, so a period
 * means the same thing on both and the two cannot be set differently.
 *
 * Months and years are by the month the money was paid. A year is the
 * academic year (1 June to 31 May) unless the picker is set to a calendar year.
 */

export type Period = "month" | "year" | "all"

export type PeriodState = {
  period: Period
  /** "2026-09"; null leaves it to the server, which takes the latest month with payments. */
  month: string | null
  /** "a2026" (academic year from June 2026) or "c2026" (calendar year); null is this academic year. */
  year: string | null
}

export const FIRST_PERIOD: PeriodState = { period: "all", month: null, year: null }

export type PeriodChoices = { months: string[]; academic_years: number[]; calendar_years: number[] }

/** What the server says it used, so a picker can show the default it chose. */
export type PeriodUsed = { month?: string | null; year?: number | null; academic?: boolean }

const ITEMS: StripItem[] = [
  { id: "month", label: "Monthly" },
  { id: "year", label: "Yearly" },
  { id: "all", label: "All time" },
]

/** The query-string part that names the period: `period=month&month=2026-09`. */
export function periodQuery(s: PeriodState): string {
  if (s.period === "month") return `period=month${s.month ? `&month=${s.month}` : ""}`
  if (s.period === "year") {
    if (!s.year) return "period=year"
    return `period=year&year=${s.year.slice(1)}&academic=${s.year[0] === "a"}`
  }
  return "period=all"
}

export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
}

const yearName = (key: string) =>
  key[0] === "a" ? `Academic year ${key.slice(1)}-${String(Number(key.slice(1)) + 1).slice(2)}` : `Calendar year ${key.slice(1)}`

export function PeriodFrame({
  state,
  onChange,
  choices,
  used,
  idPrefix = "period",
  children,
  className,
}: {
  state: PeriodState
  onChange: (next: PeriodState) => void
  choices?: PeriodChoices
  used?: PeriodUsed
  idPrefix?: string
  /** What the strip controls: drawn beside the strip on a desk, under it on a phone. */
  children: React.ReactNode
  className?: string
}) {
  const month = state.month ?? used?.month ?? choices?.months[0] ?? null
  const year =
    state.year ??
    (used?.year != null && state.period === "year" ? `${used.academic === false ? "c" : "a"}${used.year}` : null) ??
    (choices?.academic_years[0] != null ? `a${choices.academic_years[0]}` : null)
  const yearKeys = [
    ...(choices?.academic_years ?? []).map((y) => `a${y}`),
    ...(choices?.calendar_years ?? []).map((y) => `c${y}`),
  ]
  if (year && !yearKeys.includes(year)) yearKeys.unshift(year)

  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-4 md:grid-cols-[11rem_minmax(0,1fr)]", className)}>
      <div className="min-w-0 space-y-3 md:pt-1">
        <VerticalTabs
          label="Period"
          idPrefix={idPrefix}
          value={state.period}
          items={ITEMS}
          onChange={(id) => onChange({ ...state, period: id as Period })}
        />
        {state.period === "month" && month && (
          <Select
            size="sm"
            aria-label="Month"
            value={month}
            onChange={(e) => onChange({ ...state, month: e.target.value })}
          >
            {(choices?.months.includes(month) ? choices.months : [month, ...(choices?.months ?? [])]).map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
          </Select>
        )}
        {state.period === "year" && year && (
          <Select
            size="sm"
            aria-label="Year"
            value={year}
            onChange={(e) => onChange({ ...state, year: e.target.value })}
          >
            {yearKeys.map((k) => (
              <option key={k} value={k}>
                {yearName(k)}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div
        role="tabpanel"
        id={`${idPrefix}-${state.period}`}
        aria-labelledby={`${idPrefix}-tab-${state.period}`}
        className="min-w-0"
      >
        {children}
      </div>
    </div>
  )
}
