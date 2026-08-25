import type { CSSProperties } from "react"
import { AlertTriangle, FileWarning } from "lucide-react"

import { Button } from "@/ui/button"
import { cn } from "@/lib/cn"

/**
 * What a section looks like before its data arrives, when there is none, and
 * when the request failed — three states an old list screen used to collapse
 * into one blank rectangle, leaving a claimant staring at nothing with no way
 * to tell "you have filed nothing" from "the server did not answer".
 */

/* ------------------------------------------------------------------------ */
/* Skeleton                                                                  */
/* ------------------------------------------------------------------------ */

/** One animated block. The building material every loading state below is
 *  made of, so a placeholder row and a placeholder line never pulse at two
 *  different speeds on the same screen. */
export function Skeleton({
  className,
  style,
}: {
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      aria-hidden="true"
      style={style}
      className={cn("animate-pulse rounded-sm bg-hover", className)}
    />
  )
}

/** `n` placeholder rows at a given height, for a table or list that is still
 *  loading. The row count should match what a full page of real rows looks
 *  like — one skeleton row for a twenty-row table reads as an error. */
export function SkeletonRows({
  rows = 6,
  rowHeight = 32,
  className,
}: {
  rows?: number
  rowHeight?: number
  className?: string
}) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="w-full" style={{ height: rowHeight }} />
      ))}
    </div>
  )
}

// Varying widths so a block of skeleton text reads as text and not as a
// stack of identical grey bricks — a paragraph's last line is never as long
// as its first.
const TEXT_LINE_WIDTHS = ["100%", "96%", "88%", "92%", "72%"]

/** `n` lines of placeholder text, e.g. for an abstract or a comment still
 *  loading. */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="h-3"
          style={{ width: TEXT_LINE_WIDTHS[i % TEXT_LINE_WIDTHS.length] }}
        />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* EmptyState                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The request succeeded and there is genuinely nothing to show — a faculty
 * member with no papers filed, a search with no matches. Two sentences,
 * always: what is not here, and what to do about it. "No data" is not a
 * sentence a person filed a paper to eventually read, so it is not one this
 * component will render; `title` must say what, specifically, is absent.
 */
export function EmptyState({
  icon: Icon,
  title,
  message,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  message: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center gap-1 px-6 py-12 text-center", className)}>
      {Icon && <Icon className="mb-2 size-8 text-fg-subtle" />}
      <p className="text-base font-medium text-fg">{title}</p>
      <p className="max-w-sm text-sm text-fg-muted">{message}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* ErrorState                                                               */
/* ------------------------------------------------------------------------ */

/**
 * THE IMPORTANT ONE. An error rendered as an empty state tells a claimant
 * they have no publications when in fact the server did not answer — the
 * old app's list screens caught a fetch failure and fell through to the
 * same "nothing here" markup as a genuinely empty list, so a network blip
 * looked exactly like a wiped record. This is visually distinct on purpose
 * (critical colour, a warning glyph, never the empty-state icon) and it
 * always offers a retry, because "reload the page" is not a plan.
 */
export function ErrorState({
  // Overridable, because "could not load this" on every failure teaches the
  // reader that the heading carries no information and to stop reading it.
  title = "Could not load this",
  message = "The server did not answer. Nothing has been deleted or lost.",
  onRetry,
  className,
}: {
  title?: string
  message?: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center gap-1 px-6 py-12 text-center", className)}
    >
      <FileWarning className="mb-2 size-8 text-critical" />
      <p className="text-base font-medium text-fg">{title}</p>
      <p className="max-w-sm text-sm text-fg-muted">{message}</p>
      {onRetry && (
        <Button kind="default" size="sm" onClick={onRetry} className="mt-3">
          Try again
        </Button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* InlineError                                                              */
/* ------------------------------------------------------------------------ */

/**
 * For a failure inside one section of a page that otherwise loaded fine —
 * a sidebar widget, a totals strip — where `ErrorState`'s full-height block
 * would blank content the request had nothing to do with.
 */
export function InlineError({
  message,
  onRetry,
  className,
}: {
  message: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-2 rounded-md bg-critical-wash px-3 py-2 text-sm text-critical",
        className
      )}
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 font-medium underline-offset-2 hover:underline"
        >
          Retry
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Callout                                                                  */
/* ------------------------------------------------------------------------ */

type CalloutTone = "info" | "positive" | "caution" | "critical"

// There is no dedicated "info" colour token — the palette reserves colour
// for state, and information-before-you-act is not a state, it is the
// accent doing its ordinary job of marking something actionable.
const CALLOUT_TONE: Record<CalloutTone, string> = {
  info: "bg-accent-wash text-fg",
  positive: "bg-positive-wash text-fg",
  caution: "bg-caution-wash text-fg",
  critical: "bg-critical-wash text-fg",
}

/**
 * Something the reader needs to know before they act, not after — a
 * one-time payout rule, a deadline, a field that behaves differently for
 * this role. Not for a result of an action; that is what `toast` and
 * `InlineError` are for.
 */
export function Callout({
  tone = "info",
  // A callout is read by somebody scanning. Without a heading they have to
  // read the whole paragraph to find out whether it concerns them, which on
  // a page carrying four of them means reading all four.
  title,
  children,
  className,
}: {
  tone?: CalloutTone
  title?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-md px-3 py-2.5 text-sm leading-relaxed",
        CALLOUT_TONE[tone],
        className
      )}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      {children}
    </div>
  )
}
