import { describe, expect, it } from "vitest"

import { calcRequest, emptyForm } from "@/pages/file-paper"

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
