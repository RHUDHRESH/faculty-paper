import { describe, expect, it } from "vitest"

import { describeChange, maxAuthors, tabOf, toBibtex, toCsv, type RecordPaper } from "./papers"

const base: RecordPaper = {
  id: "p1",
  title: 'A "quoted", title',
  year: 2024,
  date: "2024-03-01",
  venue: "Journal of Things",
  type: "article",
  quartile: "Q1",
  doi: "10.1/x",
  eid: null,
  openalex_id: "W1",
  citations: 3,
  source: "openalex",
  author_position: 2,
  total_authors: 3,
  match_confidence: 1,
  authors: [{ name: "A. Kumar", position: 1, user_id: null, is_college: false, institution: null }],
  claim: null,
  eligible: true,
  ineligible_reason: null,
}

describe("My papers", () => {
  it("files each paper under one claim state", () => {
    expect(tabOf(base)).toBe("unclaimed")
    expect(tabOf({ ...base, eligible: false })).toBe("ineligible")
    expect(tabOf({ ...base, claim: { id: "c", stage: "Under review", days_waiting: 3 } })).toBe("progress")
    expect(tabOf({ ...base, claim: { id: "c", stage: "Paid", days_waiting: null, amount: 10 } })).toBe("paid")
  })

  it("exports CSV with quoting and BibTeX entries", () => {
    const csv = toCsv([base])
    expect(csv.split("\n")[1]).toContain('"A ""quoted"", title"')
    expect(csv).toContain("2 of 3")
    const bib = toBibtex([base])
    expect(bib).toMatch(/^@article\{kumar20240,/)
    expect(bib).toContain("doi = {10.1/x}")
  })

  it("reports what a Scopus pull changed, in words", () => {
    const paid: RecordPaper = { ...base, claim: { id: "c", stage: "Paid", days_waiting: null } }
    expect(describeChange([base], [base])).toBe("nothing new")
    expect(describeChange([base], [paid, { ...base, id: "p2" }])).toBe("1 new paper, 1 now paid")
    expect(maxAuthors("More than 10 authors")).toBe(10)
  })
})
