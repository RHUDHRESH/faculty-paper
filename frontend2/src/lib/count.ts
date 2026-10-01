/**
 * A count as a person reads it: the real number, grouped the Indian way
 * (1,284 and 1,09,265). Never capped.
 *
 * A badge that says "99+" is fine for a phone's notification dot and wrong for
 * an admin who has to know whether 100 claims are waiting or 1,284 are
 * (docs/ux/22, "Real counts"). Every count shown to a person goes through
 * here, so two pages counting the same thing cannot round it differently.
 */
export function formatCount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "0"
  return Math.round(n).toLocaleString("en-IN")
}
