import { describe, expect, it } from "vitest"

import { amountLabel, amountUnrecorded, isOldSystemClaim, NOT_RECORDED_TITLE } from "@/lib/amount"

describe("amountLabel", () => {
  it("says Not recorded for a zero or missing amount on an old-system claim", () => {
    expect(amountLabel(0, "ERP-PROCESSED-120")).toBe("Not recorded")
    expect(amountLabel(null, "erp-raw-3")).toBe("Not recorded")
    expect(amountUnrecorded(0, "ERP-RAW-3")).toBe(true)
    expect(NOT_RECORDED_TITLE).toBe("The old system did not record an amount.")
  })

  it("keeps the money line for a filed claim, zero or not", () => {
    expect(amountLabel(0, "FP-2026-000001")).toBe("₹0")
    expect(amountLabel(52377.5, "ERP-RAW-3")).toBe("₹52,377.50")
    expect(amountUnrecorded(0, "FP-2026-000001")).toBe(false)
  })

  it("only reads an ERP prefix as the old system", () => {
    expect(isOldSystemClaim("ERP-PROC")).toBe(true)
    expect(isOldSystemClaim("FP-2026-000001")).toBe(false)
    expect(isOldSystemClaim(null)).toBe(false)
  })
})
