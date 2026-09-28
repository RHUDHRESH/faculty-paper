/**
 * The name to greet somebody by.
 *
 * College records put initials first ("Dr. R. Subhashini", "Mr.V. Balasundaram")
 * or last ("Srigitha S"), so the first word is often a lone initial. Titles
 * and initials are skipped; the first real word wins. A name made only of
 * initials falls back to its first one rather than to nothing.
 */
export function firstName(full: string | null | undefined): string {
  const words = (full || "")
    .replace(/\b(Dr|Mr|Ms|Mrs|Miss|Prof|Er)\b\.?/gi, " ")
    .split(/[\s.,]+/)
    .filter(Boolean)
  return words.find((w) => w.replace(/[^\p{L}]/gu, "").length > 2) || words[0] || ""
}
