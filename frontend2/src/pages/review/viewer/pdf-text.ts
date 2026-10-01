/**
 * Searching the text of a PDF page, and the "find affiliation" shortcut.
 *
 * Pure functions on strings, kept out of the component so the two things a
 * reviewer relies on can be tested without a browser: that a search finds a
 * phrase however the PDF happened to break it into runs, and that the
 * affiliation shortcut knows the spellings the college's name actually turns
 * up under. Miss one of those and "not found" reads as "not on the paper",
 * which sends a claim back to somebody who did nothing wrong.
 */

/** One page's text as the reviewer searches it. */
export type PageText = {
  /** The page's runs joined with one space, so a phrase split across runs
   *  still reads as a phrase. */
  text: string
  /** Where each run begins in `text`, in the order the text layer draws them. */
  starts: number[]
  /** The runs themselves, same order as `starts`. */
  runs: string[]
}

export type Span = { start: number; end: number }

/** Joins a page's text runs. `runs` must be the text layer's own runs in its
 *  own order (`TextLayer.textContentItemsStr`), or highlights land on the
 *  wrong words. */
export function buildPageText(runs: string[]): PageText {
  const starts: number[] = []
  let text = ""
  for (const run of runs) {
    starts.push(text.length)
    text += run + " "
  }
  return { text, starts, runs }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A phrase as a pattern: case ignored, any run of spaces or line breaks
 *  matches any other. Null for an empty query. */
export function phrasePattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  return new RegExp(words.map(escapeRegex).join("\\s+"), "gi")
}

/**
 * The spellings of the college's name to look for.
 *
 * Papers abbreviate ("Saveetha Engg. College"), drop the word "College", and
 * some carry only the abbreviation "SEC" next to a postal address. The
 * abbreviation is case-sensitive and whole-word only: "sec" inside "section"
 * or "second" is not an affiliation.
 */
export const AFFILIATION_VARIANTS = [
  "Saveetha Engineering College",
  "Saveetha Engg. College",
  "Saveetha Engg College",
  "Saveetha Engineering",
  "Saveetha School of Engineering",
  "SEC (whole word)",
] as const

const AFFILIATION_PATTERNS: RegExp[] = [
  /saveetha\s+eng(?:ineering|g\.?|\.)?(?:\s+(?:college|coll\.?))?/gi,
  /saveetha\s+school\s+of\s+engineering/gi,
  /\bSEC\b/g,
]

/** Every place the college's name appears in `text`, overlaps merged. */
export function findAffiliation(text: string): Span[] {
  const spans: Span[] = []
  for (const pattern of AFFILIATION_PATTERNS) {
    pattern.lastIndex = 0
    for (const m of text.matchAll(pattern)) {
      if (m[0].length > 0) spans.push({ start: m.index, end: m.index + m[0].length })
    }
  }
  return mergeSpans(spans)
}

/** Every place `pattern` matches in `text`. */
export function findAll(text: string, pattern: RegExp): Span[] {
  const spans: Span[] = []
  pattern.lastIndex = 0
  for (const m of text.matchAll(pattern)) {
    if (m[0].length > 0) spans.push({ start: m.index, end: m.index + m[0].length })
  }
  return spans
}

/** Sorted, with spans that touch or overlap joined into one. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** A match cut down to the run it falls in, for drawing the highlight. */
export type RunPiece = { run: number; from: number; to: number }

/**
 * Which runs a span covers, and which characters of each. A span inside one
 * run highlights just those characters; one that crosses runs highlights each
 * run's share.
 */
export function piecesOf(page: PageText, span: Span): RunPiece[] {
  const pieces: RunPiece[] = []
  for (let i = 0; i < page.runs.length; i++) {
    const runStart = page.starts[i]
    const runEnd = runStart + page.runs[i].length
    if (runEnd <= span.start) continue
    if (runStart >= span.end) break
    const from = Math.max(span.start, runStart) - runStart
    const to = Math.min(span.end, runEnd) - runStart
    if (to > from) pieces.push({ run: i, from, to })
  }
  return pieces
}
