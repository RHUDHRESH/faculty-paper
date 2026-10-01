import { describe, expect, it } from "vitest"

import { actionSentence, formatDateTime } from "./history"
import type { ClaimAction } from "./types"

const action = (over: Partial<ClaimAction>): ClaimAction => ({
  id: "1",
  action: "CLEAR",
  from_status: "SUBMITTED",
  to_status: "CLEARED",
  note: null,
  actor_name: "Ravi",
  created_at: "2026-09-30T08:00:00Z",
  ...over,
})

describe("actionSentence", () => {
  it("says who did what", () => {
    expect(actionSentence(action({}))).toBe("Ravi checked it and sent it to the Principal")
  })
  it("adds the note after a colon, never a dash", () => {
    expect(actionSentence(action({ action: "REJECT", note: "Affiliation missing" }))).toBe(
      "Ravi sent it back: Affiliation missing"
    )
  })
  it("humanises a code it does not know", () => {
    expect(actionSentence(action({ action: "SOME_NEW_THING" }))).toBe("Ravi some new thing")
  })
})

describe("formatDateTime", () => {
  it("is empty for nothing or nonsense", () => {
    expect(formatDateTime(null)).toBe("")
    expect(formatDateTime("not a date")).toBe("")
  })
})
