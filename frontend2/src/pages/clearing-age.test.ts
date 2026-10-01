import { describe, expect, it } from "vitest"
import { ageSplit, isAgeBucket } from "./clearing-desk"

describe("ageSplit", () => {
  it("splits waiting days into the queue's four buckets", () => {
    const rows = [0, 7, 8, 14, 15, 30, 31, 90].map((d) => ({ waiting_days: d }))
    expect(ageSplit(rows).map((b) => b.n)).toEqual([2, 2, 2, 2])
    expect(ageSplit(rows).map((b) => b.id)).toEqual(["week", "fortnight", "month", "older"])
  })
  it("accepts only known buckets from the URL", () => {
    expect(isAgeBucket("older")).toBe(true)
    expect(isAgeBucket("x")).toBe(false)
  })
})
