import { describe, expect, it } from "vitest"

import { BLANK_ARTICLE, calcRequest, emptyForm, ticksHold } from "@/pages/file-paper"

describe("the live estimate's request", () => {
  it("tells the server a final-year project claim is one, so it is priced at the team rate", () => {
    const body = calcRequest(
      { ...emptyForm(), claimReason: "STUDENT_PROJECT", publicationType: "Conference Proceeding" },
      null,
      2
    )
    expect(body.claim_reason).toBe("STUDENT_PROJECT")
  })

  it("sends no reason for the ordinary incentive, and marks count-only as a student publication", () => {
    expect(calcRequest({ ...emptyForm(), claimReason: "INCENTIVE" }, null, 2).claim_reason).toBeUndefined()
    const countOnly = calcRequest({ ...emptyForm(), claimReason: "COUNT_ONLY" }, null, 2)
    expect(countOnly.is_student_publication).toBe(true)
  })
})

describe("whether the three conditions still stand", () => {
  it("holds for the same article, and not once its DOI or title changes", () => {
    expect(ticksHold("10.1/a|a title", "10.1/a|a title")).toBe(true)
    expect(ticksHold("10.1/a|a title", "10.1/b|a title")).toBe(false)
  })

  it("holds for the paper typed in by hand after the conditions were ticked", () => {
    expect(ticksHold(BLANK_ARTICLE, "|edge vision attendance for large classrooms")).toBe(true)
  })
})
