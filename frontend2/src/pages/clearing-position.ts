/** "Record says" for the author position: compares the claim with the
 *  stored Authorship row instead of repeating what the claimant typed. */
export function recordPosition(c: {
  author_position: number | null
  record_author_position?: number | null
  record_total_authors?: number | null
  record_has_authors?: boolean
}): { text: string; differs: boolean } {
  const rec = c.record_author_position ?? null
  if (rec == null) {
    return c.record_has_authors
      ? { text: "Not on the stored author list", differs: true }
      : { text: "No author list on record", differs: false }
  }
  if (c.author_position === rec) return { text: "Matches", differs: false }
  const of = c.record_total_authors ? ` of ${c.record_total_authors}` : ""
  return { text: `Record says ${rec}${of}`, differs: true }
}
