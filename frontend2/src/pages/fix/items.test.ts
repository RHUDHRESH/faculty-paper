import { describe, expect, it } from "vitest"

import { fixItemsFor, itemsFromMarks, itemsFromReason, suggestField, suggestFix, type ClaimantMark } from "./items"

describe("the send-back reason as items", () => {
  it("makes one item per line, bullets and numbers dropped", () => {
    const items = itemsFromReason("1. Attach the paper.\n- Number reference 2.\n\n  * Fix the author position.")
    expect(items.map((i) => i.body)).toEqual(["Attach the paper.", "Number reference 2.", "Fix the author position."])
    expect(new Set(items.map((i) => i.id)).size).toBe(3)
  })
  it("keeps a single-paragraph reason as one item and an empty one as none", () => {
    expect(itemsFromReason("Please attach the right file.")).toHaveLength(1)
    expect(itemsFromReason("  \n ")).toHaveLength(0)
    expect(itemsFromReason(null)).toHaveLength(0)
  })
  it("gives a repeated line its own id", () => {
    const items = itemsFromReason("Same.\nSame.")
    expect(items[0].id).not.toBe(items[1].id)
  })
  it("keeps ids stable, so 'done' survives a reload", () => {
    expect(itemsFromReason("Attach it.")[0].id).toBe(itemsFromReason("Attach it.")[0].id)
  })
})

describe("which fix is offered first", () => {
  it("offers a correction for an unnumbered reference even when the mark is on the references item", () => {
    expect(suggestFix("Reference 1 has no number. Give the number it has in your reference list.", "sec_refs")).toBe("FIELD")
    expect(suggestFix("Add a third reference.", "sec_refs")).toBe("REFERENCE")
  })
  it("reads the reviewer's words", () => {
    expect(suggestFix("The affiliation line is not in the published paper.", null)).toBe("FILE")
    expect(suggestFix("The PDF is a blurred scan.", null)).toBe("FILE")
    expect(suggestFix("Reference 2 has no number. Add the number it has in your reference list.", null)).toBe("FIELD")
    expect(suggestFix("Add a third SEC-affiliated reference.", null)).toBe("REFERENCE")
    expect(suggestFix("Your author position looks wrong.", null)).toBe("FIELD")
  })
  it("prefers the mark's checklist key", () => {
    expect(suggestFix("see page 2", "affiliation")).toBe("FILE")
    expect(suggestFix("see page 2", "sec_refs")).toBe("REFERENCE")
    expect(suggestFix("see page 2", "author_position")).toBe("FIELD")
  })
  it("opens the field form on the field the item is about", () => {
    expect(suggestField("Reference 2 has no number.")).toBe("ref_number")
    expect(suggestField("Your author position looks wrong.")).toBe("author_position")
    expect(suggestField("The DOI does not resolve.")).toBe("doi")
    expect(suggestField("Something else entirely.")).toBeNull()
  })
})

describe("marks slotted in", () => {
  const mark = (over: Partial<ClaimantMark>): ClaimantMark => ({
    id: "m1",
    kind: "ISSUE",
    audience: "CLAIMANT",
    body: "The affiliation is missing here.",
    page: 1,
    rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
    checklist_key: "affiliation",
    ...over,
  })
  it("shows only issues and notes meant for the claimant that are not yet fixed", () => {
    const items = itemsFromMarks([
      mark({}),
      mark({ id: "m2", kind: "OK" }),
      mark({ id: "m3", audience: "STAFF" }),
      mark({ id: "m4", resolved_in_resubmission: true }),
      mark({ id: "m5", kind: "NOTE", body: "Also: mind the year.", page: null, rect: null }),
    ])
    expect(items.map((i) => i.id)).toEqual(["m-m1", "m-m5"])
    expect(items[0]).toMatchObject({ page: 1, suggest: "FILE", source: "mark" })
  })
  it("says something for a mark that is only a box on the page", () => {
    const [box] = itemsFromMarks([mark({ body: "  ", checklist_key: null })])
    expect(box.body).toMatch(/marked part of the page/)
    const [quoted] = itemsFromMarks([mark({ body: "", checklist_key: null, quoted_text: "Dept of X" })])
    expect(quoted.body).toMatch(/highlighted passage/)
    expect(quoted.quotedText).toBe("Dept of X")
  })
  it("wins over the reason text when there are any", () => {
    expect(fixItemsFor("One.\nTwo.", [mark({})])).toHaveLength(1)
    expect(fixItemsFor("One.\nTwo.", [])).toHaveLength(2)
  })
})
