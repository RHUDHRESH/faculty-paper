import { describe, expect, it } from "vitest"

import { plural } from "@/lib/count"

describe("plural", () => {
  it("is singular only for exactly one", () => {
    expect(plural(1, "claim")).toBe("1 claim")
    expect(plural(0, "claim")).toBe("0 claims")
    expect(plural(2, "claim")).toBe("2 claims")
    expect(plural(1, "person", "people")).toBe("1 person")
    expect(plural(3, "person", "people")).toBe("3 people")
  })

  it("groups the Indian way and does not round a fraction away", () => {
    expect(plural(1284, "row")).toBe("1,284 rows")
    expect(plural(109265, "payment")).toBe("1,09,265 payments")
    expect(plural(1.5, "paper")).toBe("1.5 papers")
  })

  it("reads a missing count as none", () => {
    expect(plural(null, "claim")).toBe("0 claims")
    expect(plural(undefined, "claim")).toBe("0 claims")
  })
})
