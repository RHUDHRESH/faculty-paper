import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useDetail, type DetailSpec } from "@/ui/detail-sheet"

export type AnswerItem = {
  /** A number is shown in full ("1,284", never "99+"). A string is shown as
   *  given (a rupee amount, "12 days"). null or undefined means still loading. */
  value: number | string | null | undefined
  /** What the figure counts, in the reader's words ("Waiting to clear"). */
  label: string
  /** The list behind the figure. Every figure that can be a link is one. */
  to?: string
  /** Opens the panel listing what makes up the figure (`ui/detail-sheet`), in
   *  place of `to`: the reader keeps their place on the page. */
  detail?: DetailSpec
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
      className={cn("grid grid-cols-2 gap-x-8 gap-y-6", COLS[shown.length], className)}
    >
      {shown.map((it, i) => (
        <Figure key={`${i}-${it.label}`} item={it} />
      ))}
    </div>
  )
}

/** A figure that opens the list behind it. The dotted underline at rest is
 *  the hint: a plain number gives nobody a reason to try clicking it. */
function DetailFigure({ spec, children }: { spec: DetailSpec; children: React.ReactNode }) {
  const { open } = useDetail()
  return (
    <button
      type="button"
      onClick={() => open(spec)}
      className={cn(
        "block w-full min-w-0 cursor-pointer border-t border-edge pt-3 text-left hover:border-fg-muted",
        "[&_.figure]:underline [&_.figure]:decoration-dotted [&_.figure]:decoration-fg-subtle [&_.figure]:decoration-1 [&_.figure]:underline-offset-[6px]",
        "hover:[&_.figure]:decoration-solid"
      )}
    >
      {children}
    </button>
  )
}

function Figure({ item }: { item: AnswerItem }) {
  const { value, label, to, zero, tone = "neutral", detail } = item
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
          // amount ("₹12,34,56,789") at 36 px is wider than that and used to
          // push the page sideways, so on a phone a long value is set smaller
          // and, as a last resort, allowed to wrap rather than overflow.
          "figure block text-figure [overflow-wrap:anywhere]",
          text.length > 9 && "max-sm:text-figure",
          text.length > 13 && "max-sm:text-lg",
          loading && "text-fg-subtle",
          isZero ? "text-fg-subtle" : !loading && TONE[tone]
        )}
      >
        {loading ? "–" : text}
      </span>
      <span aria-hidden className="mt-1.5 block text-sm text-fg-muted">
        {line}
      </span>
      {/* One phrase for a screen reader, in the order a person would say it. */}
      <span className="sr-only">
        {loading ? `${label}: loading` : isZero && zero ? `${zero}. ${label}: 0` : `${text} ${label}`}
      </span>
    </>
  )
  // Each figure hangs from a short rule, like a column in a register: it
  // says "this is one entry" without drawing a box round it.
  if (detail && !loading) return <DetailFigure spec={detail}>{body}</DetailFigure>
  return to ? (
    <Link
      to={to}
      className="block min-w-0 border-t border-edge pt-3 hover:border-fg-muted hover:[&_.figure]:underline hover:[&_.figure]:decoration-1 hover:[&_.figure]:underline-offset-4"
    >
      {body}
    </Link>
  ) : (
    <div className="min-w-0 border-t border-edge pt-3">{body}</div>
  )
}

/**
 * Keeps a number with the word that follows it ("1 claim", "14 days") so a
 * sentence set at 60px never breaks between them and strands a lone "1" at the
 * end of a line. A no-break space is a space to a reader and to a screen
 * reader; use it on the sentence an `AnswerLine` shows.
 */
export function tieNumbers(text: string): string {
  return text.replace(/(\d)\s+(?=\p{L})/gu, "$1 ")
}

/**
 * The answer as a sentence: the biggest thing on the page (DESIGN.md,
 * "Display XL"). "Nothing needs you. One claim is being checked." Use it on a
 * Home view when the answer is a sentence; use `Answer` when it is figures.
 * Never both on one view, and one per screen.
 *
 * Emphasis is the italic of the display face (`<em>`), and a live status can
 * sit inside the sentence as an `AnswerWord`. Keep it to two short clauses.
 */
export function AnswerLine({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p role="status" className={cn("display display-xl max-w-[22ch] text-fg sm:max-w-[26ch]", className)}>
      {children}
    </p>
  )
}

const WORD_TONE = {
  clay: "bg-accent-wash text-accent",
  sage: "bg-positive-wash text-positive",
  amber: "bg-caution-wash text-caution",
  crimson: "bg-critical-wash text-critical",
  navy: "bg-navy-wash text-navy",
} as const

/**
 * A word of the answer set as a pill, at the sentence's own size: "One claim
 * is [being checked]." The word still reads as text to a screen reader. Colour
 * is the second signal; the word is the first.
 */
export function AnswerWord({
  children,
  tone = "navy",
}: {
  children: React.ReactNode
  tone?: keyof typeof WORD_TONE
}) {
  return (
    <span className={cn("mx-[0.06em] inline-block rounded-full px-[0.34em] pb-[0.06em] not-italic", WORD_TONE[tone])}>
      {children}
    </span>
  )
}
