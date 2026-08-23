"use client"

import { AlertCircle } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A breakdown where almost everything falls in "not recorded" is not a
 * breakdown. It is a gap in the data wearing a chart's clothes.
 *
 * Remuneration category was the case that showed it: empty on 3,209 of 3,236
 * claims, because the ERP import never carried the field. Drawn as a pie it
 * said "99.8% Not calculated" in the same visual language as a real finding,
 * so a reader had to work out for themselves that the chart meant nothing.
 *
 * Said plainly instead, it becomes the useful thing it actually is: a list of
 * what the college does not know about its own records, and how much of it.
 */

export type Bucket = { key: string; count: number; amount?: number }

/** Labels the system uses when it has nothing. */
const ABSENT = [
  "not recorded",
  "not calculated",
  "not stated",
  "not checked",
  "unclassified",
  "unknown",
  "no quartile",
  "none",
  "—",
  "-",
]

export function isAbsentLabel(key: string): boolean {
  return ABSENT.includes((key || "").trim().toLowerCase())
}

/** How much of a dimension is missing, 0 to 1. */
export function missingShare(rows: Bucket[]): number {
  const total = rows.reduce((s, r) => s + r.count, 0)
  if (!total) return 1
  const missing = rows
    .filter((r) => isAbsentLabel(r.key))
    .reduce((s, r) => s + r.count, 0)
  return missing / total
}

/**
 * True when a chart of this would mislead more than it informs.
 *
 * Nine in ten is the line: below it the shape still carries something a
 * reader can use, above it the chart is one slice and a rounding error.
 */
export function isMostlyMissing(rows: Bucket[], threshold = 0.9): boolean {
  return rows.length > 0 && missingShare(rows) >= threshold
}

/**
 * A percentage that never rounds away the exception.
 *
 * 3,216 of 3,226 is 99.69%, which Math.round reported as "100%" — erasing the
 * ten records that do carry the value and turning "almost none" into a claim
 * of "none at all". Anything short of the whole is capped at 99, and anything
 * above nothing is floored at 1.
 */
function sharePct(part: number, total: number): number {
  if (!total || part <= 0) return 0
  if (part >= total) return 100
  return Math.min(99, Math.max(1, Math.round((part / total) * 100)))
}

export function DataGap({
  title,
  rows,
  what,
  why,
  className,
}: {
  title: string
  rows: Bucket[]
  /** The field, in the reader's words. */
  what: string
  /** Why it is missing, when that is known. */
  why?: string
  className?: string
}) {
  const total = rows.reduce((s, r) => s + r.count, 0)
  const missing = rows
    .filter((r) => isAbsentLabel(r.key))
    .reduce((s, r) => s + r.count, 0)
  const known = rows.filter((r) => !isAbsentLabel(r.key))

  return (
    <section
      className={cn(
        "rounded-[var(--radius)] border border-border bg-card p-5",
        className
      )}
    >
      <h3 className="text-eyebrow flex items-center gap-2">
        <AlertCircle className="size-4 text-muted-foreground" aria-hidden />
        {title}
      </h3>
      <p className="mt-2 text-sm text-foreground">
        {what} is not recorded on{" "}
        <span className="font-semibold tabular-nums">{missing.toLocaleString()}</span>{" "}
        of {total.toLocaleString()} publications
        <span className="text-muted-foreground">
          {" "}
          ({sharePct(missing, total)}%)
        </span>
        .
      </p>
      {why ? <p className="mt-1 text-xs text-muted-foreground">{why}</p> : null}

      {/* The bar carries the one fact that matters: how little is known. */}
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.max(0.5, ((total - missing) / total) * 100)}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {(total - missing).toLocaleString()} known
        {known.length
          ? ` · ${known
              .slice(0, 4)
              .map((r) => `${r.key} ${r.count}`)
              .join(" · ")}`
          : ""}
      </p>
    </section>
  )
}
