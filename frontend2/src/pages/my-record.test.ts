import { describe, expect, it } from "vitest"

import { appraisalCsv, authorRole } from "@/pages/my-record"
import type { RecordPaper } from "@/pages/papers"

const paper = (over: Partial<RecordPaper>): RecordPaper => ({
  id: "p", title: "A, study", year: 2024, date: null, venue: "J", type: "Article", quartile: "Q1",
  doi: "10.1/x", eid: null, openalex_id: null, citations: 3, source: "openalex", scopus_indexed: true, author_position: 1,
  total_authors: 3, match_confidence: null,
  authors: [{ name: "Me", position: 1, user_id: "u", is_college: true, institution: null }],
  claim: null, eligible: true, ineligible_reason: null, ...over,
})

describe("appraisal list", () => {
  it("names the author role", () => {
    expect(authorRole(paper({}))).toBe("First author")
    expect(authorRole(paper({ total_authors: 1 }))).toBe("Sole author")
    expect(authorRole(paper({ author_position: 2 }))).toBe("Co-author (2 of 3)")
  })
  it("writes a quoted CSV with DOI links", () => {
    const csv = appraisalCsv("Me", [paper({})])
    expect(csv).toContain('1,"A, study",Me,J,2024,Article,Scopus,Q1,https://doi.org/10.1/x,First author,,3')
  })
  it("marks the corresponding author only when a source says so", () => {
    expect(appraisalCsv("Me", [paper({ corresponding_author: true })])).toContain("First author,Yes,3")
    expect(appraisalCsv("Me", [paper({ corresponding_author: false })])).toContain("First author,No,3")
  })
  it("uses the claim's author order when the record has one", () => {
    expect(authorRole(paper({ source: "claim", author_position: 3, total_authors: 4, authors: [] }))).toBe("Co-author (3 of 4)")
  })
})
