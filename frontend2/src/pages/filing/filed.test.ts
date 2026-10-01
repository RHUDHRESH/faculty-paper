import { describe, expect, it } from "vitest"

import { receiptAmount } from "./filed"

describe("receiptAmount", () => {
  it("shows what the server priced the filed claim at, not the form's estimate", () => {
    expect(receiptAmount(74_500, 2_500)).toBe(74_500)
  })

  it("falls back to the estimate when the server has not priced it", () => {
    expect(receiptAmount(null, 2_500)).toBe(2_500)
    expect(receiptAmount(undefined, 2_500)).toBe(2_500)
    expect(receiptAmount(0, 2_500)).toBe(2_500)
  })

  it("says nothing rather than inventing a figure", () => {
    expect(receiptAmount(null, null)).toBeNull()
    expect(receiptAmount(0, null)).toBe(0)
  })
})
