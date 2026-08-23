"use client"

import { Link } from "react-router-dom"
import { ArrowDown, ArrowUp, Minus } from "lucide-react"

import { formatMoney } from "@/components/ticket-ui"
import { cn } from "@/lib/utils"

/**
 * The three questions the reports counted around rather than answered.
 *
 * The page said what the college has published and what it paid. It did not
 * say whether anything was stuck, whether the output is broad or carried by a
 * few people, or whether a department is going up or down. Those are the three
 * things asked in a review meeting, and each of them had to be worked out from
 * an export.
 */

export type AgeRow = { key: string; count: number; amount: number }
export type BreadthRow = {
  key: string
  count: number
  people: number
  per_person: number
  top_ten_share: number
}
export type YoyRow = {
  key: string
  count: number
  previous: number
  change: number
  percent: number | null
}

/** Which buckets are a problem. Colour carries it, so a glance is enough. */
const AGE_TONE: Record<string, string> = {
  "Up to a week": "bg-success",
  "1–2 weeks": "bg-success/70",
  "2–4 weeks": "bg-warning",
  "1–3 months": "bg-destructive/70",
  "Over 3 months": "bg-destructive",
}

export function AgeingPanel({
  rows,
  total,
  oldestDays,
  queryBase,
  showMoney = true,
}: {
  rows: AgeRow[]
  total: number
  oldestDays: number | null
  /** Where a bucket sends the reader. */
  queryBase: string
  showMoney?: boolean
}) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  if (!total) {
    return (
      <section className="surface-card p-5">
        <h3 className="text-eyebrow">How long things have been waiting</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing is in the queue — every ticket has been paid or sent back.
        </p>
      </section>
    )
  }
  const stuck = rows
    .filter((r) => r.key === "1–3 months" || r.key === "Over 3 months")
    .reduce((s, r) => s + r.count, 0)

  return (
    <section className="surface-card p-5">
      <h3 className="text-eyebrow">How long things have been waiting</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        The {total.toLocaleString()} tickets still in the chain, by how long they have sat at
        their current step. Paid and sent-back tickets have stopped ageing and are not counted.
      </p>

      <ul className="mt-4 space-y-2.5">
        {rows.map((r) => (
          <li key={r.key} className="min-w-0">
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="truncate text-sm text-foreground">{r.key}</span>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                <span className={cn("text-foreground", !r.count && "opacity-40")}>{r.count}</span>
                {showMoney && r.amount > 0 ? (
                  <span className="ml-2 opacity-60">{formatMoney(r.amount)}</span>
                ) : null}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-[width]", AGE_TONE[r.key] || "bg-primary")}
                style={{ width: `${Math.max((r.count / max) * 100, r.count ? 1 : 0)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-muted-foreground">
        {stuck ? (
          <>
            <span className="font-medium text-destructive">
              {stuck} {stuck === 1 ? "ticket has" : "tickets have"} waited over a month.
            </span>{" "}
          </>
        ) : (
          <>Nothing has waited more than a month. </>
        )}
        {oldestDays != null ? `The oldest has been at its step for ${oldestDays} days.` : null}{" "}
        <Link
          to={`${queryBase}?status=SUBMITTED`}
          className="text-primary underline-offset-4 hover:underline"
        >
          Open the queue
        </Link>
      </p>
    </section>
  )
}

export function BreadthPanel({ rows }: { rows: BreadthRow[] }) {
  if (rows.length < 2) return null
  const latest = rows[rows.length - 1]
  // Not simply the first year on record. 2019 holds one paper by one person,
  // so its top-ten share is 100% by arithmetic rather than by concentration,
  // and comparing against it made the spread look far more dramatic than it
  // is. The baseline is the earliest year with enough papers for the share to
  // mean anything.
  const MEANINGFUL = 20
  const earliest = rows.find((r) => r.count >= MEANINGFUL && r !== latest)
  const widening = earliest ? latest.top_ten_share < earliest.top_ten_share : false

  return (
    <section className="surface-card p-5">
      <h3 className="text-eyebrow">How many people are carrying it</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Output can rise because more people published, or because the same people published
        more. A total cannot tell those apart.
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {["Year", "Papers", "People", "Each", "Top ten"].map((h, i) => (
                <th
                  key={h}
                  className={cn(
                    "whitespace-nowrap border-b border-border pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground",
                    i && "text-right"
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-border/50 last:border-0">
                <td className="py-1.5 tabular-nums">{r.key}</td>
                <td className="py-1.5 text-right tabular-nums">{r.count.toLocaleString()}</td>
                <td className="py-1.5 text-right tabular-nums">{r.people}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.per_person}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${r.top_ten_share}%` }}
                      />
                    </span>
                    {r.top_ten_share}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        “Top ten” is the share of that year’s papers written by its ten most prolific authors.{" "}
        {!earliest
          ? "Too few years with enough papers to say which way it is moving."
          : widening
            ? `It has fallen from ${earliest.top_ten_share}% in ${earliest.key} to ${latest.top_ten_share}% in ${latest.key} — the work is spread across more people than it was.`
            : `It has risen from ${earliest.top_ten_share}% in ${earliest.key} to ${latest.top_ten_share}% in ${latest.key} — the output rests on fewer people than it did.`}
        {rows.some((r) => r.count < MEANINGFUL) ? (
          <>
            {" "}
            Years with fewer than {MEANINGFUL} papers are listed but not used for the
            comparison — a share out of one paper is 100% whatever happened.
          </>
        ) : null}
      </p>
    </section>
  )
}

export function YearOnYearPanel({
  data,
  queryBase,
}: {
  data: {
    this_year: number
    last_year: number
    this_year_is_partial: boolean
    months_elapsed: number
    rows: YoyRow[]
  }
  queryBase: string
}) {
  if (!data?.rows?.length) return null
  const max = Math.max(1, ...data.rows.map((r) => Math.max(r.count, r.previous)))

  return (
    <section className="surface-card p-5">
      <h3 className="text-eyebrow">
        {data.this_year} against {data.last_year}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Each department’s publications this year beside its own last year.
      </p>

      {/* Said before the numbers, not after: a reader who scrolls past this
          sees every department down by half and believes it. */}
      {data.this_year_is_partial ? (
        <p className="mt-3 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          {data.this_year} is {data.months_elapsed} months old and {data.last_year} is a full
          year, so every figure below is a part-year against a whole one. Expect the change
          column to read low until December.
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {data.rows.slice(0, 12).map((r) => (
          <li key={r.key} className="min-w-0">
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <Link
                to={`${queryBase}?department=${encodeURIComponent(r.key)}&year=${data.this_year}`}
                className="interactive truncate text-sm text-primary underline-offset-4 hover:underline"
              >
                {r.key}
              </Link>
              <span className="flex shrink-0 items-baseline gap-3 text-sm tabular-nums">
                <span className="font-medium">{r.count}</span>
                <span
                  className={cn(
                    "inline-flex w-28 items-center justify-end gap-0.5 whitespace-nowrap text-xs",
                    r.change > 0 && "text-success",
                    r.change < 0 && "text-destructive",
                    !r.change && "text-muted-foreground"
                  )}
                >
                  {r.change > 0 ? (
                    <ArrowUp className="size-3" aria-hidden />
                  ) : r.change < 0 ? (
                    <ArrowDown className="size-3" aria-hidden />
                  ) : (
                    <Minus className="size-3" aria-hidden />
                  )}
                  {r.change > 0 ? "+" : ""}
                  {r.change}
                  {r.percent != null ? ` (${r.percent > 0 ? "+" : ""}${r.percent}%)` : ""}
                </span>
              </span>
            </div>
            {/* Two bars, same scale: this year solid over last year faint, so
                the comparison is the shape rather than an arithmetic step. */}
            <div className="space-y-0.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max((r.count / max) * 100, r.count ? 1 : 0)}%` }}
                />
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted/60">
                <div
                  className="h-full rounded-full bg-muted-foreground/40"
                  style={{ width: `${Math.max((r.previous / max) * 100, r.previous ? 1 : 0)}%` }}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        The faint bar underneath each is {data.last_year}.
        {data.rows.length > 12 ? ` ${data.rows.length - 12} more departments below the cut.` : ""}
      </p>
    </section>
  )
}
