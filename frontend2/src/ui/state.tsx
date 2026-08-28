import type { CSSProperties } from "react"
import { AlertTriangle } from "lucide-react"

import { Art, type ArtName } from "@/ui/art"
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
 *  different speeds on the same screen. The `.skeleton` utility carries the
 *  sweep; see `styles.css` for why it is a sweep and not a pulse. */
export function Skeleton({
  className,
  style,
}: {
  className?: string
  style?: CSSProperties
}) {
  return <div aria-hidden="true" style={style} className={cn("skeleton rounded-sm", className)} />
}

// Widths that vary down the list, so a screenful of placeholders reads as a
// list of different records rather than as a printed form.
const ROW_TITLE_WIDTHS = ["58%", "44%", "66%", "38%", "52%", "48%"]
const ROW_META_WIDTHS = ["30%", "38%", "24%", "34%", "28%", "40%"]

/**
 * `n` placeholder rows at a given height, for a table or list that is still
 * loading. The row count should match what a full page of real rows looks
 * like — one skeleton row for a twenty-row table reads as an error.
 *
 * A row tall enough to hold real content is drawn with the *shape* of that
 * content: a title, a line of metadata under it, and a figure held to the
 * right. A stack of identical full-width bars tells the reader only that
 * something is happening; a stack of row shapes tells them what is arriving
 * and roughly how much of it, so the page does not jump into an unfamiliar
 * layout the moment the data lands.
 */
export function SkeletonRows({
  rows = 6,
  rowHeight = 32,
  className,
}: {
  rows?: number
  rowHeight?: number
  className?: string
}) {
  // Under this, a title and a meta line come out as two slivers with no room
  // between them, which is worse than one honest bar.
  const roomForDetail = rowHeight >= 44

  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) =>
        roomForDetail ? (
          <div
            key={i}
            style={{ height: rowHeight }}
            className="flex items-center gap-3 rounded-md bg-sunken px-3"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton
                className="h-3"
                style={{ width: ROW_TITLE_WIDTHS[i % ROW_TITLE_WIDTHS.length] }}
              />
              <Skeleton
                className="h-2.5"
                style={{ width: ROW_META_WIDTHS[i % ROW_META_WIDTHS.length] }}
              />
            </div>
            <Skeleton className="h-3 w-14 shrink-0" />
          </div>
        ) : (
          <Skeleton key={i} className="w-full" style={{ height: rowHeight }} />
        )
      )}
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
 *
 * It stands on `sunken` rather than on the page, because the one place an
 * empty region genuinely *is* a different region is when it is empty: a
 * floor under the sentence turns "this screen failed to draw anything" into
 * "this is the shelf, and there is nothing on it yet". No border and no
 * shadow does that work — the ground alone does, and it is a token.
 */
export function EmptyState({
  icon: Icon,
  art,
  title,
  message,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  /** One of the drawn scenes from `ui/art.tsx`, for the situations that
   *  recur across the app — nothing filed, an empty queue, a filter that
   *  matched nothing. Takes precedence over `icon`, which stays supported
   *  because forty screens pass one and a glyph in a well is still the
   *  right answer for a one-off. */
  art?: ArtName
  title: string
  message: string
  /** The thing that would fill this screen — "File a paper", "Clear the
   *  filters". An empty state without one leaves the reader to work out for
   *  themselves where the button is. */
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-lg bg-sunken px-6 py-14 text-center",
        className
      )}
    >
      {art ? (
        <Art name={art} className="mb-2" />
      ) : (
        Icon && (
          // A well, so the glyph is an object on the shelf rather than a grey
          // smudge floating on a grey ground.
          <span
            aria-hidden="true"
            className="mb-3 flex size-11 items-center justify-center rounded-lg bg-hover"
          >
            <Icon className="size-5 text-fg-muted" />
          </span>
        )
      )}
      <p className="text-lg font-semibold text-fg">{title}</p>
      <p className="max-w-sm text-pretty text-base text-fg-muted">{message}</p>
      {action && <div className="mt-4">{action}</div>}
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
 * looked exactly like a wiped record. This is visually distinct on purpose —
 * critical colour, and the one drawing in `ui/art.tsx` that shows a record
 * torn rather than a shelf standing empty — and it always offers a retry,
 * because "reload the page" is not a plan.
 *
 * The ground is part of that distinction and not decoration: `EmptyState`
 * stands on neutral `sunken`, this stands on `critical-wash`, so the two are
 * told apart from across the room and before either sentence is read.
 */
export function ErrorState({
  // Overridable, because "could not load this" on every failure teaches the
  // reader that the heading carries no information and to stop reading it.
  title = "Could not load this",
  message = "The server did not answer. Nothing has been deleted or lost.",
  art = "could-not-load",
  onRetry,
  className,
}: {
  title?: string
  message?: string
  /** Overridable for a failure with a more specific picture, but it must
   *  stay one of the `critical` scenes: an error wearing an empty state's
   *  drawing is the exact mistake this component exists to prevent. */
  art?: ArtName
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-lg bg-critical-wash px-6 py-14 text-center",
        className
      )}
    >
      <Art name={art} className="mb-2" />
      <p className="text-lg font-semibold text-fg">{title}</p>
      <p className="max-w-sm text-pretty text-base text-fg-muted">{message}</p>
      {onRetry && (
        <Button kind="default" size="sm" onClick={onRetry} className="mt-4">
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
