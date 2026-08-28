import { cn } from "@/lib/cn"

/**
 * The type scale, as components, so a heading cannot be a div with a size on
 * it that some other screen writes slightly differently.
 *
 * There is no all-caps letterspaced eyebrow here. Six shouted grey labels
 * down a page is not hierarchy — it is noise at one volume, which is what
 * the old app's every section header was.
 *
 * The steps have to be far enough apart to be steps. Four levels — 26 title,
 * 16 section, 14 body, 13 metadata — each one visibly a size down from the
 * last, is what stops a long screen reading as one undifferentiated column
 * of grey.
 *
 * Size is not the only axis. `PageTitle` also changes *family*, and `Figure`
 * changes weight and colour, because at these sizes a step of four points is
 * not by itself enough to make two things read as different kinds of thing.
 */

/**
 * The name of the place the reader is standing in.
 *
 * Set in the display face (see `.display` in `styles.css`) and nothing else
 * in the app is. That is the point: this app's chrome is 13px and 14px Inter
 * from the sidebar to the last table cell, so a title that was merely bigger
 * Inter read as "a heading" rather than as the page — on a screen with a
 * section title, a filter bar and four bold figures on it, the one word
 * telling you where you are had no way to win. Family separates it in a way
 * that size alone could not without shouting.
 *
 * The face is loaded `font-display: optional`, so on a first visit before
 * the file is cached this falls back to a system serif and never reflows.
 */
export function PageTitle({ children, className }: React.ComponentProps<"h1">) {
  // `text-balance` so a two-line title breaks into two even lines rather
  // than a full line and one orphaned word.
  return <h1 className={cn("display text-balance text-xl", className)}>{children}</h1>
}

/**
 * The heading for one region of a page.
 *
 * `text-lg` (16), not body size: at `text-base` the only thing separating a
 * section heading from the sentence under it was its weight, so a page of
 * six sections read as one long block and a reader scanning for "Attachments"
 * had to read the page rather than skim it. The scale reserves 16 for exactly
 * this — `--text-lg` is commented "section heading" in `styles.css`.
 */
export function SectionTitle({ children, className }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-lg font-semibold", className)}>{children}</h2>
}

/** Secondary line under a title. Never a second sentence of instructions. */
export function Sub({ children, className }: React.ComponentProps<"p">) {
  return <p className={cn("text-pretty text-base text-fg-muted", className)}>{children}</p>
}

/** Metadata beside content — dates, counts, departments. */
export function Meta({ children, className }: React.ComponentProps<"span">) {
  return <span className={cn("text-sm text-fg-muted", className)}>{children}</span>
}

/** A machine category: a column head, a field name in a grid. The only place
 *  uppercase is used, because here it genuinely is a label and not a phrase.
 *
 *  `fg-muted`, not `fg-subtle`: subtle is a 12px uppercase word at under 3:1
 *  against the page, which is the contrast of a disabled control, and these
 *  are the words naming what every figure beneath them means. Muted still
 *  sits a clear step below the value it labels — the label/value pair reads
 *  as a pair because the two differ in size, weight and colour at once. */
export function ColumnLabel({ children, className }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "text-xs font-medium uppercase tracking-[0.04em] text-fg-muted",
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * A number that is an answer, not a value in a list.
 *
 * The figures on a dashboard were being written by hand as
 * `text-2xl font-semibold tabular` on a bare `<p>`, roughly fifteen times
 * across the app — which is fine until two of them disagree, and they did:
 * some carried the tabular class and some did not, so two cards side by side
 * had their digits on different rhythms and the eye could not run down them.
 * Worse, a figure that was bad news looked exactly like a figure that was
 * good news, and on a page about money that is the one distinction a reader
 * needs before they need any other.
 *
 * So: tabular by construction, a weight (620 on Inter's variable axis) that
 * sits a real step above a heading at the same size, and a `tone` that is
 * the only sanctioned way to colour a number. Size stays overridable —
 * `text-3xl` for the single figure a page exists to show, `text-lg` for a
 * figure inside a row — because that is a judgement about the page, not
 * about the number.
 *
 * `tone` is never the only carrier of the meaning: a negative balance says
 * so in its sign and its label as well. Colour here is a second signal for
 * people who can use it, not the signal.
 */
export function Figure({
  children,
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<"span"> & {
  tone?: "neutral" | "positive" | "caution" | "critical"
}) {
  const TONE = {
    neutral: "text-fg",
    positive: "text-positive",
    caution: "text-caution",
    critical: "text-critical",
  } as const

  return (
    <span className={cn("figure text-2xl", TONE[tone], className)} {...props}>
      {children}
    </span>
  )
}
