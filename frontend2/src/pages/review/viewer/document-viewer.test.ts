import { describe, expect, it } from "vitest"

import type { Attachment } from "@/ui/attachments"

import { tabLabel } from "./document-viewer"

const file = (over: Partial<Attachment>): Attachment => ({ kind: "PUBLISHED_PAPER", url: "/media/claims/" + "a".repeat(32) + ".pdf", ...over })

describe("tabLabel", () => {
  it("names the paper and each reference by its number", () => {
    const all = [file({}), file({ kind: "SEC_REFERENCE", ref_number: "27" }), file({ kind: "SEC_REFERENCE", ref_number: " 28 " })]
    expect(all.map((f, i) => tabLabel(f, i, all))).toEqual(["Published paper", "Reference 27", "Reference 28"])
  })

  it("does not leave a reference with no number nameless", () => {
    const all = [file({ kind: "SEC_REFERENCE" })]
    expect(tabLabel(all[0], 0, all)).toBe("Reference")
  })

  it("falls back to the file name for anything else", () => {
    const all = [file({ kind: "OTHER", filename: "cover-letter.docx" })]
    expect(tabLabel(all[0], 0, all)).toBe("cover-letter.docx")
  })
})
