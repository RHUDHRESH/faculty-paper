import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { coverColours, JournalCover, monogram } from "@/ui/journal-cover"

describe("JournalCover", () => {
  it("is deterministic for a title", () => {
    expect(coverColours("Journal of Physics")).toEqual(coverColours("Journal of Physics"))
  })

  it("colours the band by quartile", () => {
    expect(coverColours("Anything", "Q1").band).toBe("#b8860b")
    expect(coverColours("Anything", "Q2").band).not.toBe(coverColours("Anything", "Q1").band)
  })

  it("draws a monogram from the title", () => {
    expect(monogram("Journal of Cleaner Production")).toBe("JCP")
    expect(monogram("IEEE Transactions on Neural Networks and Learning Systems")).toBe("IEEE")
    expect(monogram("")).toBe("J")
  })

  it("names the journal for assistive tech", () => {
    render(<JournalCover title="Scientific Reports" quartile="Q1" size="md" />)
    expect(screen.getByRole("img", { name: "Scientific Reports, Q1" })).toBeTruthy()
  })
})
