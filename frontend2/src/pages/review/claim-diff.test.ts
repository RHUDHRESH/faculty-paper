import { describe, expect, it } from "vitest"

import { claimDiff, ordinal } from "./claim-diff"
import type { WorkspaceClaim } from "./types"

function claim(over: Partial<WorkspaceClaim> = {}): WorkspaceClaim {
  return {
    id: "c1",
    ticket_number: "FP-2026-000001",
    paper_title: "A paper",
    journal_title: "Nature",
    doi: "10.1000/x",
    issn: "1234-5678",
    publication_year: 2026,
    owner_name: "Asha",
    owner_email: "a@x.edu",
    owner_department: "CSE",
    remuneration: 1000,
    remuneration_is_estimate: false,
    remuneration_category: null,
    remuneration_note: null,
    calc_error: null,
    qf_amount: null,
    base_amount: null,
    snip: 1.2,
    snip_source: "SCOPUS",
    self_reported_snip: 1.2,
    quartile: "Q2",
    quartile_source: "SCIMAGO",
    self_reported_quartile: "Q2",
    scimago_sjr: null,
    scimago_dataset_year: null,
    author_position: 1,
    total_authors: 3,
    record_author_position: 1,
    record_total_authors: 3,
    record_has_authors: true,
    affiliation_ok: true,
    verification_ok: true,
    verification_snapshot_json: null,
    duplicate_warning: false,
    duplicate_matches_json: null,
    override_duplicate: null,
    override_reason: null,
    override_by_name: null,
    attachments: [],
    waiting_days: 2,
    eid: "2-s2.0-1",
    scimago_verified: true,
    indexing_level: "Scopus",
    indexing_status: "Indexed",
    ...over,
  } as WorkspaceClaim
}

const row = (rows: ReturnType<typeof claimDiff>, key: string) => rows.find((r) => r.key === key)!

describe("claimDiff", () => {
  it("highlights nothing when the record agrees", () => {
    expect(claimDiff(claim()).filter((r) => r.differs)).toEqual([])
  })

  it("highlights a quartile and a SNIP the record does not back", () => {
    const rows = claimDiff(claim({ self_reported_quartile: "Q1", self_reported_snip: 2.5 }))
    expect(row(rows, "quartile").differs).toBe(true)
    expect(row(rows, "quartile").why).toMatch(/different quartile/)
    expect(row(rows, "snip").differs).toBe(true)
  })

  it("does not call a missing claimed figure a difference", () => {
    const rows = claimDiff(claim({ self_reported_quartile: null, self_reported_snip: null }))
    expect(row(rows, "quartile").differs).toBe(false)
    expect(row(rows, "snip").differs).toBe(false)
  })

  it("flags a paper without the college's name", () => {
    const r = row(claimDiff(claim({ affiliation_ok: false })), "affiliation")
    expect(r.differs).toBe(true)
    expect(r.record).toBe("This college is not on the paper")
  })

  it("flags an author position that is not on the stored list", () => {
    const r = row(claimDiff(claim({ author_position: 2, record_author_position: 1 })), "author_position")
    expect(r.differs).toBe(true)
  })

  it("says not checked, and does not flag, before the checks have run", () => {
    const rows = claimDiff(claim({ verification_ok: null, eid: null, scimago_verified: null, indexing_status: null }))
    expect(row(rows, "doi").record).toBe("Not checked")
    expect(row(rows, "doi").differs).toBe(false)
    expect(row(rows, "issn").differs).toBe(false)
    expect(row(rows, "indexing").record).toBe("Not checked")
  })

  it("flags a DOI with no Scopus record once the checks have run", () => {
    expect(row(claimDiff(claim({ eid: null })), "doi").differs).toBe(true)
  })

  it("flags an indexing status that is not indexed", () => {
    const r = row(claimDiff(claim({ indexing_status: "Not indexed" })), "indexing")
    expect(r.differs).toBe(true)
    expect(r.why).toBe("The record says not indexed.")
  })
})

describe("ordinal", () => {
  it("counts the way an author list does", () => {
    expect([1, 2, 3, 4, 11, 12, 21, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "21st", "22nd"])
  })
})
