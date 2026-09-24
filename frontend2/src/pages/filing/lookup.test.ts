/**
 * What pasting a DOI puts on the form.
 *
 * The mapping is pure, so it is pinned here rather than through a mounted
 * page: which fields a lookup may fill, which it must leave alone, and the two
 * it must never fill on the claimant's behalf -- the affiliation confirmation,
 * which is theirs to make, and a publication date the source only knew to the
 * month, which would be a day invented for them.
 */
import { describe, expect, it } from "vitest"

import { applyLookup, type PaperLookup } from "./lookup"
import { emptyForm } from "./types"

function found(over: Partial<PaperLookup> = {}): PaperLookup {
  return {
    ok: true,
    code: "ok",
    message: null,
    paper: {
      title: "A Sharded Ledger for Cloud Storage",
      doi: "10.1038/s41598-026-99999-x",
      journal: "Scientific Reports",
      issns: ["2045-2322"],
      issn: "2045-2322",
      publication_date: "2026-05-20",
      publication_date_precision: "day",
      publication_year: 2026,
      document_type: "Journal article",
      publication_type: "Journal",
      citations: 7,
      open_access_url: "https://example.org/oa.pdf",
      is_retracted: false,
      eid: null,
      scopus_url: null,
      total_authors: 4,
      authors: [
        { position: 1, name: "R. N. Kavitha", affiliations: ["Saveetha Engineering College"], is_claimant: true, college: "yes" },
        { position: 2, name: "C. Valli", affiliations: ["Anna University"], is_claimant: false, college: "no" },
        { position: 3, name: "V. UmaDevi", affiliations: [], is_claimant: false, college: null },
        { position: 4, name: "G. Kavi", affiliations: [], is_claimant: false, college: null },
      ],
    },
    claimant: { position: 1, name_on_paper: "R. N. Kavitha", confidence: "exact", matched_on: "name", candidates: [1] },
    affiliation: { status: "yes", claimant_status: "yes", positions: [1], text: null },
    metrics: {
      found: true,
      journal: "Scientific Reports",
      issn: "2045-2322",
      matched_by: "issn",
      quartile: "Q1",
      category: "Multidisciplinary",
      sjr: 0.9,
      dataset_year: 2025,
      snip: 1.339,
      snip_year: 2025,
      engineering_class: "Engineering",
    },
    field_sources: { title: "OpenAlex", quartile: "Our journal data" },
    sources: [],
    scopus_status: "not_configured",
    warnings: [],
    to_check: [],
    already_filed: null,
    candidates: [],
    ...over,
  }
}

describe("applyLookup", () => {
  it("fills the paper, the journal, the authors and the journal's figures", () => {
    const { patch, filled } = applyLookup(emptyForm(), found(), { overwrite: true })
    expect(patch).toMatchObject({
      paperTitle: "A Sharded Ledger for Cloud Storage",
      doi: "10.1038/s41598-026-99999-x",
      journalTitle: "Scientific Reports",
      issn: "2045-2322",
      publicationDate: "2026-05-20",
      publicationType: "Journal",
      totalAuthors: 4,
      authorPosition: 1,
      selfReportedQuartile: "Q1",
      selfReportedSnip: "1.339",
      subjectCategory: "Multidisciplinary",
    })
    expect(patch.authors?.map((a) => a.name)).toEqual(["R. N. Kavitha", "C. Valli", "V. UmaDevi", "G. Kavi"])
    expect(filled).toContain("the title")
    expect(filled).toContain("your author position")
  })

  it("ticks Scopus when the journal carries a Scopus SNIP", () => {
    const { patch } = applyLookup(emptyForm(), found(), { overwrite: true })
    expect(patch.indexing).toEqual(["Scopus"])
  })

  it("never confirms the affiliation on the claimant's behalf", () => {
    const { patch } = applyLookup(emptyForm(), found(), { overwrite: true })
    expect(patch.affiliationOk).toBeUndefined()
  })

  it("does not invent a day the source did not give", () => {
    const res = found()
    res.paper!.publication_date = "2026-05"
    res.paper!.publication_date_precision = "month"
    const { patch } = applyLookup(emptyForm(), res, { overwrite: true })
    expect(patch.publicationDate).toBeUndefined()
  })

  it("leaves a position alone when the match is not certain", () => {
    const res = found({
      claimant: { position: null, name_on_paper: null, confidence: "ambiguous", matched_on: "name", candidates: [1, 3] },
    })
    const { patch } = applyLookup({ ...emptyForm(), authorPosition: 2 }, res, { overwrite: true })
    expect(patch.authorPosition).toBeUndefined()
  })

  it("keeps what was typed when the lookup was not asked for", () => {
    const typed = { ...emptyForm(), paperTitle: "My own title", journalTitle: "My journal" }
    const { patch } = applyLookup(typed, found(), { overwrite: false })
    expect(patch.paperTitle).toBeUndefined()
    expect(patch.journalTitle).toBeUndefined()
    expect(patch.issn).toBe("2045-2322")
  })

  it("puts no figures on a count-only filing", () => {
    const { patch } = applyLookup({ ...emptyForm(), claimReason: "COUNT_ONLY" }, found(), { overwrite: true })
    expect(patch.selfReportedSnip).toBeUndefined()
    expect(patch.selfReportedQuartile).toBeUndefined()
  })

  it("fills nothing from a lookup that did not find the paper", () => {
    const { patch, filled } = applyLookup(emptyForm(), found({ ok: false, code: "not_found", paper: null }), {
      overwrite: true,
    })
    expect(patch).toEqual({})
    expect(filled).toEqual([])
  })
})
