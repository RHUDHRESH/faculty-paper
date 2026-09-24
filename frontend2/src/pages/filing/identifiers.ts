/**
 * Identifiers, tidied on the way in, so a typo is not a failed lookup later.
 *
 * Moved out of `file-paper.tsx` unchanged so the lookup mapping can use them
 * without importing the page (and the page importing it back).
 */

/**
 * A DOI as the server wants it, out of whatever was pasted.
 *
 * People paste the whole address bar. `https://doi.org/10.1016/j.x` is the
 * same DOI as `10.1016/j.x` and the lookup only recognises the second, so the
 * first came back "no match for that DOI" and the claimant concluded their
 * paper was not indexed.
 */
export function normaliseDoi(raw: string): string {
  let d = raw.trim()
  for (const prefix of ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"]) {
    if (d.toLowerCase().startsWith(prefix)) d = d.slice(prefix.length)
  }
  return d.replace(/^\/+|\/+$/g, "").trim()
}

export function doiProblem(raw: string): string | null {
  const d = normaliseDoi(raw)
  if (!d) return null
  // Every DOI is "10.<registrant>/<suffix>". Anything else is a title, a URL
  // to somewhere else, or a typo.
  return /^10\.\d{4,9}\/\S+$/.test(d) ? null : "That does not look like a DOI (10.xxxx/…)."
}

/**
 * An ISSN as eight characters, whatever a spreadsheet did to it first.
 *
 * A direct port of `normalize_issn` in `backend/core/services/normalize.py`,
 * and it has to stay one. Two things happen to ISSNs on the way in, both from
 * being read as numbers, and the order they are undone in matters:
 *
 * - A trailing ".0" from a float. Stripping non-digits *first* turns
 *   "2728842.0" into "27288420" — eight characters, so it passes the length
 *   check and comes out as "2728-8420", a real-looking ISSN belonging to
 *   nobody. A wrong match is worse than no match: it attaches another
 *   journal's quartile to this one, and quartile is a term in the payout. So
 *   the float suffix goes first, and only when the *whole* value looks like a
 *   float, leaving an ISSN that legitimately ends in 0 alone.
 * - A lost leading zero: 0272-8842 arrives as "2728842". Seven characters,
 *   which the server pads back.
 */
export function issnDigits(raw: string): string {
  let text = raw.trim()
  if (/^\d+\.0+$/.test(text)) text = text.split(".")[0]
  const cleaned = text.toUpperCase().replace(/[^0-9X]/g, "")
  return cleaned.length === 7 ? `0${cleaned}` : cleaned
}

export function normaliseIssn(raw: string): string {
  const cleaned = issnDigits(raw)
  if (cleaned.length !== 8) return raw.trim()
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
}

export function issnProblem(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const cleaned = issnDigits(value)
  if (cleaned.length !== 8) return "An ISSN is eight characters, like 0390-6663."
  if (cleaned.slice(0, 7).includes("X")) return "Only the last character of an ISSN may be an X."
  return null
}

/** Said when the value was repaired rather than merely reformatted, because
 *  restoring a dropped leading zero is a guess — a correct one nine times out
 *  of ten, and worth a second look the tenth. */
export function issnRepairNote(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const bare = value.toUpperCase().replace(/[^0-9X]/g, "")
  if (/^\d+\.0+$/.test(value)) {
    return "A trailing “.0” was dropped — that is a spreadsheet having read this as a number."
  }
  if (bare.length === 7) {
    return "A leading zero was added to make eight characters. Check it against the journal."
  }
  return null
}

export function yearOf(dateStr: string): number | null {
  const y = Number(dateStr.slice(0, 4))
  return dateStr && Number.isFinite(y) && y > 1900 ? y : null
}

export function isoDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
}

/** A date as a person writes it: 20 May 2026. The form's own value stays
 *  ISO; this is only ever for reading back. */
export function readableDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso)
  if (!m) return iso
  const months = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"]
  const month = months[Number(m[2]) - 1]
  if (!month) return iso
  return m[3] ? `${Number(m[3])} ${month} ${m[1]}` : `${month} ${m[1]}`
}
