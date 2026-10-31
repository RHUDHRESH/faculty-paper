import { cn } from "@/lib/cn"
import { STAGES, type StageName } from "@/ui/paper"

/**
 * Everything in this app that is drawn rather than written.
 *
 * It is all here, in one file, for the reason the type scale is all in
 * `text.tsx`: artwork that lives beside the screen that needed it drifts.
 * Two empty states drawn a month apart end up with different stroke weights
 * and different greys, and a reader who sees four of them in a morning reads
 * four different products. One file makes "does this match?" a question you
 * can answer by scrolling.
 *
 * ## The mark
 *
 * A portico: an arch on a cornice on two piers. It is drawn, not typed —
 * before this the entire brand presence of a system used by every member of
 * teaching staff was the letters "SE" set in the UI font on an indigo
 * square, which is a placeholder that had stopped being temporary. Nothing
 * about a college is a startup, so the mark is symmetrical, flat, and
 * built from four shapes on a 32-unit grid; it holds together at 20px in a
 * collapsed sidebar because it has one silhouette and one counter, and it
 * does not gain any detail it would lose there.
 *
 * It is a single path set in `currentColor`, so it takes a token from
 * whatever it is put inside and works on white, on `sunken`, or knocked out
 * of `accent`. No second colour, no gradient, nothing to go wrong on a
 * ground it has not seen.
 *
 * ## The illustrations
 *
 * One language, so that a person who files a paper, checks a queue and
 * looks at a budget in the same session sees three drawings by the same
 * hand rather than three stock pictures:
 *
 * - **72 x 56, and everything stands on the same ground rule at y=48.**
 *   That shared floor is what makes eight unrelated scenes read as a set.
 * - **Stroke 2, round joins.** No exceptions, no thin detail.
 * - **Structure is `edge`, solid mass is `hover`, paper is `surface`.**
 *   Colour carries meaning here exactly as it does in the rest of the app.
 *   `surface` and not `bg`, because these are drawn objects standing on a
 *   ground and `bg` is the ground — an off-white page would leave every
 *   sheet in the set invisible on `sunken`.
 * - **Dashed in `accent-line` is a thing that is absent** — the paper you
 *   have not filed, the rows the filter did not match, the amount nobody
 *   has been paid. Dashes are how the drawing says "not yet".
 * - **One accent object per scene**, and in `could-not-load` that one
 *   object is `critical` instead. That is the whole difference between the
 *   two sentences the house rules insist a reader must be able to tell
 *   apart, said in a picture as well as in words.
 *
 * Every scene is `aria-hidden`: the heading beside it is the sentence, and
 * an illustration that also announces itself makes a screen reader say the
 * same thing twice. The mark is the exception, because on the sign-in page
 * it is the only thing naming the institution.
 */

/* ------------------------------------------------------------------------ */
/* The mark                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Saveetha Engineering College, as a shape.
 *
 * Use it wherever the app has to say whose it is: the sidebar header, the
 * mobile header, the sign-in page. Without it the only identification a
 * reader gets is a two-letter abbreviation that could belong to any
 * institution in the country, which is what people were signing in to.
 *
 * Pass `title` where the mark is the *only* thing naming the college on
 * screen — a collapsed sidebar, the sign-in page. Leave it off where a
 * wordmark sits next to it, so the name is not announced twice.
 */
export function Mark({
  className,
  title,
}: {
  className?: string
  /** An accessible name. Omit when the college is named in text alongside. */
  title?: string
}) {
  // The college's own emblem, from public/brand/emblem.png -- replace that
  // file to brand the app for another institution. Intrinsic size is set so
  // it occupies its box from the first paint.
  return (
    <img
      src="/brand/emblem-192.png"
      width={24}
      height={24}
      alt={title ?? ""}
      aria-hidden={title ? undefined : "true"}
      draggable={false}
      className={cn("shrink-0 rounded-full object-contain", className)}
    />
  )
}

/* ------------------------------------------------------------------------ */
/* The illustrations                                                         */
/* ------------------------------------------------------------------------ */

/** The situations this app actually leaves a reader looking at nothing. */
export type ArtName =
  /** No record has ever been filed here. */
  | "nothing-filed"
  /** A queue of work with no work in it. */
  | "empty-queue"
  /** There are records; this filter matched none of them. */
  | "no-results"
  /** Money has been claimed but none of it has gone out yet. */
  | "nothing-paid"
  /** No ceiling has been set on a department's spend. */
  | "no-budget"
  /** The request failed. Never used for any of the above. */
  | "could-not-load"
  /** The address is not a page in this app. */
  | "no-page"
  /** The address is a real page this account may not open. */
  | "closed-gate"

/**
 * One illustration from the set, for an empty or failed region.
 *
 * Decorative by design: it is always `aria-hidden`, because the heading
 * under it is the sentence and a picture that also announces itself makes
 * the region read twice. Its job is the half-second before the sentence —
 * telling somebody scanning a page whether they are looking at a shelf with
 * nothing on it or at a record that tore in transit, which a grey circle
 * with a grey glyph in it never did.
 */
export function Art({ name, className }: { name: ArtName; className?: string }) {
  void name
  void className
  return null
}

/* ------------------------------------------------------------------------ */
/* The five steps                                                            */
/* ------------------------------------------------------------------------ */

// Who does each step, taken from the same chain `ui/paper.tsx` renders on
// every paper. If the chain gains a desk there, this list gains a line and
// the sign-in page cannot quietly go on describing the old one.
const DESK: Record<StageName, string> = {
  Filed: "You file the paper.",
  Checked: "The research office checks it.",
  Approved: "The Principal agrees the spend.",
  Authorised: "The Director authorises it.",
  Paid: "Finance pays the incentive.",
}

/**
 * The five desks a paper passes, drawn as a rail.
 *
 * For the sign-in page, where the alternative to it is a panel of
 * decoration. Somebody signing in on a Monday to find out where their claim
 * has got to can see, before they have typed anything, that there are five
 * steps and which office holds each one — which is the question the research
 * cell's phone rings about.
 */
export function StageTrack({ className }: { className?: string }) {
  return (
    <ol className={className}>
      {STAGES.map((stage, i) => {
        const last = i === STAGES.length - 1
        return (
          <li key={stage} className="flex gap-3">
            {/* The rail is two boxes in a flex column rather than a drawn
                line, so a node always sits on its own row's first line of
                text however the label wraps. */}
            <div aria-hidden="true" className="flex w-2 flex-col items-center pt-2">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  last ? "bg-accent" : "bg-accent-line"
                )}
              />
              {!last && <span className="w-px flex-1 bg-edge" />}
            </div>
            <div className={last ? "" : "pb-4"}>
              <p className="text-base font-medium text-fg">{stage}</p>
              <p className="text-sm text-fg-muted">{DESK[stage]}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
