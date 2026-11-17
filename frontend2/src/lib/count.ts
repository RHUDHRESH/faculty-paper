/**
 * A count as a person reads it: the real number, grouped the Indian way
 * (1,284 and 1,09,265). Never capped.
 *
 * A badge that says "99+" is fine for a phone's notification dot and wrong for
 * an admin who has to know whether 100 claims are waiting or 1,284 are
 * (docs/ux/22, "Real counts"). Every count shown to a person goes through
 * here, so two pages counting the same thing cannot round it differently.
 */
/** "1 claim", "2 claims", "1 person", "3 people": a count with its noun in the
 *  right number. Every place a count is printed next to a word goes through
 *  here, so "1 claims" cannot be written. */
export function plural(n: number | null | undefined, one: string, many?: string): string {
  // Not rounded: "1.5 days" must not become "2 days". Only exactly one is singular.
  const v = n == null || Number.isNaN(n) ? 0 : n
  return `${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })} ${v === 1 ? one : (many ?? `${one}s`)}`
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "0"
  return Math.round(n).toLocaleString("en-IN")
}
