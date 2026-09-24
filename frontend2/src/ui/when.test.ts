import { describe, expect, it } from "vitest"

import { relativeTime } from "@/ui/when"

/** A feed says when something was said the way people do, to the minute. */
describe("relativeTime", () => {
  const now = new Date("2026-09-24T12:00:00+05:30")
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const MIN = 60_000
  const HOUR = 60 * MIN

  it("says just now for the last minute", () => {
    expect(relativeTime(ago(20_000), now)).toBe("just now")
  })

  it("counts minutes, then hours, in words", () => {
    expect(relativeTime(ago(MIN), now)).toBe("1 minute ago")
    expect(relativeTime(ago(5 * MIN), now)).toBe("5 minutes ago")
    expect(relativeTime(ago(HOUR), now)).toBe("1 hour ago")
    expect(relativeTime(ago(3 * HOUR), now)).toBe("3 hours ago")
  })

  it("falls back to days, then to the date", () => {
    expect(relativeTime(ago(30 * HOUR), now)).toBe("yesterday")
    expect(relativeTime(ago(4 * 24 * HOUR), now)).toBe("4 days ago")
    expect(relativeTime(new Date("2026-08-02T10:00:00+05:30"), now)).toBe("2 Aug")
    expect(relativeTime(new Date("2025-08-02T10:00:00+05:30"), now)).toBe("2 Aug 2025")
  })

  it("does not claim something happened in the future", () => {
    expect(relativeTime(new Date(now.getTime() + 90_000), now)).toBe("just now")
  })
})
