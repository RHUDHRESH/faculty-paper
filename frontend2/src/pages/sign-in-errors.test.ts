import { describe, expect, it } from "vitest"

import { passwordStrength } from "@/app/password"
import { explainSignInError } from "@/pages/sign-in"

describe("explainSignInError", () => {
  it("rephrases the server's refusals", () => {
    expect(explainSignInError("Invalid credentials")).toMatch(/do not match/)
    expect(explainSignInError("Invalid credentials. Forgotten your password? The research office can reset it for you.")).toMatch(/lock/)
    expect(explainSignInError("Too many failed sign-ins — locked for about 5 more minutes.")).toBe(
      "Too many failed sign-ins. Locked for about 5 more minutes."
    )
    expect(explainSignInError("Inactive account")).toMatch(/switched off/)
    expect(explainSignInError("")).toMatch(/connection/)
  })
})

describe("passwordStrength", () => {
  it("grows with length and variety", () => {
    expect(passwordStrength("abc").score).toBe(1)
    expect(passwordStrength("aaaaaaaaaa").score).toBe(1)
    expect(passwordStrength("abcdefgh").score).toBe(2)
    expect(passwordStrength("Throwaway-9x!").score).toBe(4)
  })
})
