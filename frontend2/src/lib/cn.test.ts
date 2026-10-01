import { describe, expect, it } from "vitest"
import { cn } from "@/lib/cn"

describe("cn", () => {
  it("keeps our custom type sizes next to a colour", () => {
    expect(cn("display text-display min-w-0 text-fg")).toContain("text-display")
    expect(cn("figure text-figure-xl text-fg-muted")).toContain("text-figure-xl")
  })
  it("still lets a later size win", () => {
    expect(cn("text-display", "text-sm")).toBe("text-sm")
  })
})
