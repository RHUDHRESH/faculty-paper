import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"

export type AnswerItem = {
  /** A number is shown in full ("1,284", never "99+"). A string is shown as
   *  given (a rupee amount, "12 days"). null or undefined means still loading. */
  value: number | string | null | undefined
  /** What the figure counts, in the reader's words ("Waiting to clear"). */
  label: string
  /** The list behind the figure. Every figure that can be a link is one. */
  to?: string
  /** What a zero means, in place of the label ("Nothing waiting"). A bare 0
   *  makes the reader work out whether that is good news. */
  zero?: string
  /** Colour is a second signal only; the label carries the meaning. */
  tone?: "neutral" | "caution" | "critical" | "positive"
}

const TONE: Record<NonNullable<AnswerItem["tone"]>, string> = {
  neutral: "text-fg",
  caution: "text-caution",
  critical: "text-critical",
  positive: "text-positive",
}

const COLS = ["", "sm:grid-cols-1", "sm:grid-cols-2", "sm:grid-cols-3", "sm:grid-cols-4"]

/**
 * The answer strip (docs/ux/22, "page anatomy", part 2): one to four figures
 * that answer the view's question, straight under the title. Each figure links
 * to the list behind it, and a zero says what it means.
 *
 * Without it the answer is buried in the work: an admin opens Imports and has
 * to read three panels of prose to learn whether anything needs doing. It is
 * flat on purpose. No card, no border, no shadow; four boxed tiles are the
 * "SaaS card grid" docs/ux/17 rules out, and a figure does not need a frame to
 * be read.
 *
 * More than four figures is not an answer, it is a report, so extras are
 * dropped rather than shrunk to fit.
 */
export function Answer({ items, className }: { items: AnswerItem[]; className?: string }) {
  const shown = items.slice(0, 4)
  if (shown.length === 0) return null
  return (
    <div
      role="group"
      aria-label="At a glance"
      className={cn("grid grid-cols-2 gap-x-8 gap-y-5", COLS[shown.length], className)}
    >
      {shown.map((it, i) => (
        <Figure key={`${i}-${it.label}`} item={it} />
      ))}
    </div>
  )
}

function Figure({ item }: { item: AnswerItem }) {
  const { value, label, to, zero, tone = "neutral" } = item
  const loading = value == null
  const isZero = value === 0
  const text = loading ? "" : typeof value === "number" ? formatCount(value) : value
  const line = isZero && zero ? zero : label
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          // Two to a row on a phone leaves about 170 px a figure. A long rupee
          // amount ("₹12,34,56,789") at 28 px is wider than that and used to
          // push the page sideways, so on a phone a long value is set smaller
          // and, as a last resort, allowed to wrap rather than overflow.
          "figure block text-figure [overflow-wrap:anywhere]",
          text.length > 9 && "max-sm:text-lg",
          loading && "text-fg-subtle",
          isZero ? "text-fg-subtle" : !loading && TONE[tone]
        )}
      >
        {loading ? "–" : text}
      </span>
      <span aria-hidden className="mt-0.5 block text-sm text-fg-muted">
        {line}
      </span>
      {/* One phrase for a screen reader, in the order a person would say it. */}
      <span className="sr-only">
        {loading ? `${label}: loading` : isZero && zero ? `${zero}. ${label}: 0` : `${text} ${label}`}
      </span>
    </>
  )
  return to ? (
    <Link
      to={to}
      className="block min-w-0 rounded-control hover:underline hover:decoration-1 hover:underline-offset-4"
    >
      {body}
    </Link>
  ) : (
    <div className="min-w-0">{body}</div>
  )
}
