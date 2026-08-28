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
  return (
    <svg
      viewBox="0 0 32 32"
      width={24}
      height={24}
      // Intrinsic width and height are on the element and not only in a
      // class, so the mark occupies its box from the first paint. A logo
      // that arrives with a size is a logo that shoves the sidebar heading
      // sideways on every cold load.
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : "true"}
      focusable="false"
      fill="currentColor"
    >
      {title ? <title>{title}</title> : null}
      {/* The arch: an outer radius of 13 and an inner of 9, so the band is
          four units thick at every point, including the crown. */}
      <path d="M3 16a13 13 0 0 1 26 0h-4a9 9 0 0 0-18 0Z" />
      {/* The cornice, one unit proud of the arch on each side. The overhang
          is the whole reason this reads as a building and not as a tunnel. */}
      <path d="M2 16h28v4H2Z" />
      {/* Two piers, aligned with the inner face of the arch. */}
      <path d="M7 20h4v10H7ZM21 20h4v10h-4Z" />
    </svg>
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

/** The frame every scene is drawn in: one viewBox, one stroke weight, one
 *  ground rule. Private, because a scene that sets its own is a scene that
 *  stops matching the other seven. */
function Scene({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 72 56"
      width={72}
      height={56}
      aria-hidden="true"
      focusable="false"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
    >
      {/* Drawn first, so every object in the scene stands in front of it. */}
      <path d="M6 48h60" className="stroke-edge" />
      {children}
    </svg>
  )
}

// The tray appears twice on purpose: "nothing filed" and "nothing in this
// queue" are the same shelf with and without something expected on it, and
// drawing them as the same object is what makes the difference between them
// legible at a glance.
const TRAY = "M12 30h12l3 5h18l3-5h12v15a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z"

const SCENES: Record<ArtName, React.ReactNode> = {
  // A shelf, and the outline of the paper that is not on it yet. Portrait,
  // and narrower than the tray's mouth, so it reads as a sheet about to go
  // in rather than as a second box.
  "nothing-filed": (
    <>
      <rect
        x="27"
        y="4"
        width="18"
        height="22"
        rx="2"
        className="stroke-accent-line"
        strokeDasharray="4 4"
      />
      <path d={TRAY} className="fill-hover stroke-edge" />
    </>
  ),

  // The same shelf, cleared. The tick is the one place in this set where an
  // empty state is good news, so it is the one place with a filled accent.
  "empty-queue": (
    <>
      <circle cx="36" cy="16" r="9" className="fill-accent-wash stroke-accent" />
      <path d="M32 16.5 34.75 19.25 40 14" className="stroke-accent" />
      <path d={TRAY} className="fill-hover stroke-edge" />
    </>
  ),

  // A filter, and the three rows it did not return. The list is the thing
  // that is missing, so the list is what is dashed; the filter is solid
  // because the filter is the part that definitely happened.
  "no-results": (
    <>
      <rect x="10" y="8" width="52" height="12" rx="6" className="fill-surface stroke-edge" />
      <circle cx="20" cy="14" r="4" className="stroke-accent" />
      <path d="M23 17l3 3" className="stroke-accent" />
      <rect
        x="14"
        y="24"
        width="44"
        height="6"
        rx="3"
        className="stroke-accent-line"
        strokeDasharray="4 4"
      />
      <rect
        x="14"
        y="33"
        width="44"
        height="6"
        rx="3"
        className="stroke-accent-line"
        strokeDasharray="4 4"
      />
      <rect
        x="14"
        y="42"
        width="44"
        height="6"
        rx="3"
        className="stroke-accent-line"
        strokeDasharray="4 4"
      />
    </>
  ),

  // A voucher with its amount line still dashed, and a coin nobody has
  // handed over.
  "nothing-paid": (
    <>
      <path d="M14 14h30v34l-5-3-5 3-5-3-5 3-5-3-5 3z" className="fill-surface stroke-edge" />
      <path d="M20 24h18" className="stroke-edge" />
      <path d="M20 33h11" className="stroke-accent-line" strokeDasharray="4 4" />
      <circle cx="57" cy="40" r="8" className="fill-accent-wash stroke-accent" />
      <path d="M53 40h8" className="stroke-accent" />
    </>
  ),

  // Spend exists. The line that would cap it does not, so it is the one
  // dashed thing on the page and it is drawn at full accent.
  "no-budget": (
    <>
      <path d="M10 15v6M62 15v6" className="stroke-accent" />
      <path d="M10 18h52" className="stroke-accent" strokeDasharray="4 4" />
      <rect x="16" y="34" width="10" height="14" rx="2" className="fill-hover stroke-edge" />
      <rect x="31" y="28" width="10" height="20" rx="2" className="fill-hover stroke-edge" />
      <rect x="46" y="38" width="10" height="10" rx="2" className="fill-hover stroke-edge" />
    </>
  ),

  // THE ONE THAT MUST NOT LOOK LIKE THE OTHERS. A record torn in half, in
  // critical, with a gap you can see from across the room. Nothing here is
  // dashed, because dashed means "not yet" and this does not mean that.
  "could-not-load": (
    <>
      <path
        d="M22 10h28v15l-4 3-4-3-4 3-4-3-4 3-4-3-4 3z"
        className="fill-surface stroke-critical"
      />
      <path
        d="M22 34l4-3 4 3 4-3 4 3 4-3 4 3 4-3v17H22z"
        className="fill-surface stroke-critical"
      />
    </>
  ),

  // A signpost with nothing written on it. Off the square by five degrees,
  // which is the only crooked thing in the entire set and is there because
  // the page it belongs to is the one page that is allowed a joke.
  "no-page": (
    <>
      <path d="M38 24v24" className="stroke-edge" />
      <g transform="rotate(-5 38 16)">
        <rect x="16" y="8" width="44" height="16" rx="3" className="fill-surface stroke-edge" />
        <path d="M24 16h20" className="stroke-accent-line" strokeDasharray="4 4" />
      </g>
    </>
  ),

  // The mark's own portico, barred. A page that exists and is somebody
  // else's is a door, not a dead end, and the reader should recognise the
  // building.
  "closed-gate": (
    <>
      <path
        d="M18 30a18 18 0 0 1 36 0h-7a11 11 0 0 0-22 0z"
        className="fill-hover stroke-edge"
      />
      <path d="M14 30h44v5H14z" className="fill-hover stroke-edge" />
      <path d="M25 35h6v13h-6zM41 35h6v13h-6z" className="fill-hover stroke-edge" />
      <rect x="21" y="38" width="30" height="6" rx="3" className="fill-accent-wash stroke-accent" />
    </>
  ),
}

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
  return <Scene className={className}>{SCENES[name]}</Scene>
}

/* ------------------------------------------------------------------------ */
/* The five steps                                                            */
/* ------------------------------------------------------------------------ */

// Who does each step, taken from the same chain `ui/paper.tsx` renders on
// every paper. If the chain gains a desk there, this list gains a line and
// the sign-in page cannot quietly go on describing the old one.
const DESK: Record<StageName, string> = {
  Filed: "You file the paper.",
  Checked: "The research cell checks it.",
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
