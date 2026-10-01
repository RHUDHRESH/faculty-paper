import { describe, expect, it } from "vitest"

import { appraisalCsv, appraisalParagraph, appraisalScope, authorRole, isJournal, tallyOf } from "@/pages/my-record"
import type { RecordPaper } from "@/pages/papers"

const paper = (over: Partial<RecordPaper>): RecordPaper => ({
  id: "p", title: "A, study", year: 2024, date: null, venue: "J", type: "Article", quartile: "Q1",
  doi: "10.1/x", eid: null, openalex_id: null, citations: 3, source: "openalex", scopus_indexed: true, author_position: 1,
  total_authors: 3, match_confidence: null,
  authors: [{ name: "Me", position: 1, user_id: "u", is_college: true, institution: null }],
  claim: null, eligible: true, ineligible_reason: null, ...over,
})

describe("appraisal scope", () => {
  it("is empty when there are no years, so the header has no stray 0", () => {
    expect(appraisalScope(0, 0)).toBe("")
    expect(appraisalScope(2024, 2024)).toBe("2024")
    expect(appraisalScope(2021, 2025)).toBe("2021 to 2025")
  })
})

describe("appraisal list", () => {
  it("names the author role", () => {
    expect(authorRole(paper({}))).toBe("First author")
    expect(authorRole(paper({ total_authors: 1 }))).toBe("Sole author")
    expect(authorRole(paper({ author_position: 2 }))).toBe("Co-author (2 of 3)")
  })
  it("writes a quoted CSV with DOI links", () => {
    const csv = appraisalCsv("Me", [paper({})])
    expect(csv).toContain('1,"A, study",Me,J,2024,Journal article,Scopus,Q1,https://doi.org/10.1/x,First author,,3')
  })
  it("marks the corresponding author only when a source says so", () => {
    expect(appraisalCsv("Me", [paper({ corresponding_author: true })])).toContain("First author,Yes,3")
    expect(appraisalCsv("Me", [paper({ corresponding_author: false })])).toContain("First author,No,3")
  })
  it("uses the claim's author order when the record has one", () => {
    expect(authorRole(paper({ source: "claim", author_position: 3, total_authors: 4, authors: [] }))).toBe("Co-author (3 of 4)")
  })
})

describe("journal papers", () => {
  it("counts only journal articles, not preprints, proceedings or uploads", () => {
    expect(isJournal(paper({ type: "article" }))).toBe(true)
    expect(isJournal(paper({ type: "Journal" }))).toBe(true)
    expect(isJournal(paper({ type: "conference-paper" }))).toBe(false)
    expect(isJournal(paper({ type: "proceedings-article" }))).toBe(false)
    expect(isJournal(paper({ type: "preprint" }))).toBe(false)
    expect(isJournal(paper({ type: "other" }))).toBe(false)
    expect(isJournal(paper({ type: null }))).toBe(false)
  })
})

describe("appraisal paragraph", () => {
  const rows = [
    paper({ id: "a", type: "article", author_position: 1, quartile: "Q1" }),
    paper({ id: "b", type: "conference-paper", author_position: 2, quartile: null, scopus_indexed: false }),
    paper({ id: "c", type: "article", author_position: 1, quartile: "Q2" }),
  ]
  it("is counted from the same rows as the list", () => {
    const t = tallyOf(rows)
    expect(t).toEqual({ all: 3, journals: 2, first: 2, q1: 1, q2: 1, scopus: 2 })
    expect(appraisalParagraph("Dr Me", "2021 to 2025", t)).toBe(
      "Between 2021 and 2025, Dr Me published 3 papers: 2 in journals and 1 in conference proceedings or other venues. 2 are as first author, 1 appeared in Q1 and 1 in Q2 journals, and 2 are indexed in Scopus."
    )
  })
  it("reads for a single year and for no papers", () => {
    expect(appraisalParagraph("Dr Me", "2024", tallyOf([rows[0]]))).toContain("In 2024, Dr Me published 1 paper: 1 in journals")
    expect(appraisalParagraph("Dr Me", "2024", tallyOf([]))).toBe("")
  })
})
