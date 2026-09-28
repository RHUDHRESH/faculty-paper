import { describe, expect, it } from "vitest"
import { recordPosition } from "./clearing-position"
import { officeThreadLink } from "./clearing-thread"

describe("officeThreadLink", () => {
  it("opens the office thread for the claim", () => {
    expect(officeThreadLink([{ id: "t1", title: "x", post_count: 3 }]).to).toBe("/messages/o/t1")
  })
  it("falls back to the office inbox", () => {
    expect(officeThreadLink([]).to).toBe("/messages/office")
  })
})

describe("recordPosition", () => {
  it("says matches when the record agrees", () => {
    expect(
      recordPosition({ author_position: 2, record_author_position: 2, record_total_authors: 4, record_has_authors: true }),
    ).toEqual({ text: "Matches", differs: false })
  })
  it("names the stored position when it differs", () => {
    expect(
      recordPosition({ author_position: 1, record_author_position: 3, record_total_authors: 5, record_has_authors: true }),
    ).toEqual({ text: "Record says 3 of 5", differs: true })
  })
  it("never repeats the claim when there is no record", () => {
    expect(recordPosition({ author_position: 1, record_has_authors: false }).text).toBe("No author list on record")
  })
})
