import { describe, expect, it } from "vitest"

import { firstName } from "./names"

describe("firstName", () => {
  it("skips titles and leading initials", () => {
    expect(firstName("Dr. R. Subhashini")).toBe("Subhashini")
    expect(firstName("Mr.V. Balasundaram")).toBe("Balasundaram")
    expect(firstName("Dr.A.Tajuddin")).toBe("Tajuddin")
  })
  it("keeps a first name followed by an initial", () => {
    expect(firstName("Srigitha S")).toBe("Srigitha")
    expect(firstName("Prof. Karthik Raja M")).toBe("Karthik")
  })
  it("falls back when there is nothing better", () => {
    expect(firstName("R. S.")).toBe("R")
    expect(firstName("")).toBe("")
    expect(firstName(undefined)).toBe("")
  })
})
