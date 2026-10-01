import { describe, expect, it } from "vitest"

import { buildPageText, findAffiliation, findAll, mergeSpans, phrasePattern, piecesOf } from "./pdf-text"

describe("phrasePattern", () => {
  it("finds a phrase whatever the case or spacing", () => {
    const page = buildPageText(["Department of CSE,", "Saveetha", "Engineering College"])
    const spans = findAll(page.text, phrasePattern("saveetha  engineering college")!)
    expect(spans).toHaveLength(1)
    expect(page.text.slice(spans[0].start, spans[0].end)).toBe("Saveetha Engineering College")
  })

  it("treats punctuation in the query as text", () => {
    const page = buildPageText(["see (a+b) here"])
    expect(findAll(page.text, phrasePattern("(a+b)")!)).toHaveLength(1)
  })

  it("has no pattern for an empty query", () => {
    expect(phrasePattern("   ")).toBeNull()
  })
})

describe("findAffiliation", () => {
  const found = (s: string) => findAffiliation(s).map((x) => s.slice(x.start, x.end))

  it("knows the spellings the college turns up under", () => {
    expect(found("at Saveetha Engineering College, Chennai")).toEqual(["Saveetha Engineering College"])
    expect(found("Saveetha Engg. College")).toEqual(["Saveetha Engg. College"])
    expect(found("Saveetha Engg College")).toEqual(["Saveetha Engg College"])
    expect(found("saveetha school of engineering")).toEqual(["saveetha school of engineering"])
  })

  it("takes the abbreviation only as a whole capitalised word", () => {
    expect(found("SEC, Thandalam")).toEqual(["SEC"])
    expect(found("in this section we second the motion")).toEqual([])
  })

  it("does not report one place twice", () => {
    const s = "Saveetha Engineering College (SEC)"
    expect(found(s)).toEqual(["Saveetha Engineering College", "SEC"])
  })

  it("finds nothing on a paper from elsewhere", () => {
    expect(found("Indian Institute of Technology Madras")).toEqual([])
  })
})

describe("mergeSpans", () => {
  it("joins overlapping and touching spans", () => {
    expect(mergeSpans([{ start: 5, end: 9 }, { start: 0, end: 5 }, { start: 8, end: 12 }])).toEqual([
      { start: 0, end: 12 },
    ])
  })
})

describe("piecesOf", () => {
  it("cuts a span inside one run to those characters", () => {
    const page = buildPageText(["Hello world"])
    expect(piecesOf(page, { start: 6, end: 11 })).toEqual([{ run: 0, from: 6, to: 11 }])
  })

  it("gives each run its share of a span that crosses runs", () => {
    const page = buildPageText(["Saveetha", "Engineering College"])
    const span = findAll(page.text, phrasePattern("Saveetha Engineering")!)[0]
    expect(piecesOf(page, span)).toEqual([
      { run: 0, from: 0, to: 8 },
      { run: 1, from: 0, to: 11 },
    ])
  })
})
