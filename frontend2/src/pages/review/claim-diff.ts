import { recordPosition } from "@/pages/clearing-position"

import type { WorkspaceClaim } from "./types"

export type DiffRow = {
  key: string
  label: string
  claimed: string
  record: string
  /** The record disagrees with the claim, or cannot support it. */
  differs: boolean
  /** Why it differs, in one plain sentence, or null when it does not. */
  why: string | null
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

/**
 * The claimant's figures beside what the record says, one row per thing the
 * research cell checks (docs/jtbd/research-cell.md, jobs 1 to 4 and 6).
 *
 * A row is highlighted only when the record positively disagrees or cannot
 * back the claim after the checks have run. "Not checked" is not a
 * difference: showing it in red would train the reader to ignore red.
 */
export function claimDiff(c: WorkspaceClaim): DiffRow[] {
  const checked = c.verification_ok != null
  const pos =
    c.author_position != null
      ? `${ordinal(c.author_position)}${c.total_authors ? ` of ${c.total_authors}` : ""}`
      : "Not given"
  const posRec = recordPosition(c)
  const snipDiffers =
    c.self_reported_snip != null && c.snip != null && Math.abs(c.self_reported_snip - c.snip) > 0.0005
  const quartileDiffers =
    !!c.self_reported_quartile && !!c.quartile && c.self_reported_quartile !== c.quartile
  const indexed = (c.indexing_status || "").trim()
  const indexingDiffers = !!indexed && !/^indexed$/i.test(indexed)
  const doiMissingInRecord = !!c.doi && !c.eid && checked
  const issnUnknown = !!c.issn && c.scimago_verified === false && checked

  const rows: DiffRow[] = [
    {
      key: "snip",
      label: "SNIP",
      claimed: c.self_reported_snip != null ? String(c.self_reported_snip) : "Not given",
      record: c.snip != null ? c.snip.toFixed(3) : "Not found",
      differs: snipDiffers,
      why: snipDiffers ? "The record's SNIP is not the one the claimant gave." : null,
    },
    {
      key: "quartile",
      label: "Quartile",
      claimed: c.self_reported_quartile || "Not given",
      record: c.quartile || "Not found",
      differs: quartileDiffers,
      why: quartileDiffers ? "The claimant gave a different quartile from the record." : null,
    },
    {
      key: "author_position",
      label: "Author position",
      claimed: pos,
      record: posRec.text,
      differs: posRec.differs,
      why: posRec.differs ? "The author list on record does not match the claimed position." : null,
    },
    {
      key: "affiliation",
      label: "Affiliation",
      claimed: "This college",
      record:
        c.affiliation_ok === true
          ? "This college is on the paper"
          : c.affiliation_ok === false
            ? "This college is not on the paper"
            : "Not checked",
      differs: c.affiliation_ok === false,
      why: c.affiliation_ok === false ? "The college's name was not found on the paper." : null,
    },
    {
      key: "doi",
      label: "DOI",
      claimed: c.doi || "Not given",
      record: c.eid ? `In Scopus (${c.eid})` : checked ? "No Scopus record" : "Not checked",
      differs: doiMissingInRecord,
      why: doiMissingInRecord ? "No Scopus record was found for this DOI." : null,
    },
    {
      key: "issn",
      label: "ISSN",
      claimed: c.issn || "Not given",
      record:
        c.scimago_verified === true ? "In Scimago" : c.scimago_verified === false && checked ? "Not in Scimago" : "Not checked",
      differs: issnUnknown,
      why: issnUnknown ? "This ISSN is not in the Scimago list." : null,
    },
    {
      key: "indexing",
      label: "Indexing",
      claimed: c.indexing_level || "Not given",
      record: indexed || "Not checked",
      differs: indexingDiffers,
      why: indexingDiffers ? `The record says ${indexed.toLowerCase()}.` : null,
    },
  ]
  return rows
}
