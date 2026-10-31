import { act, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { BADGES_IDLE_MS, BADGES_POLL_MS, stageCountsOf, useBadgeClock, useBadges } from "@/app/badges"
import { useUnreadMessages } from "@/app/unread"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

/**
 * The frame's three badges ride one request. What is claimed here is what the
 * network sees: how many requests, and when. The clock is fake so two minutes
 * (and five) cost nothing.
 */

let badges = {
  stage_counts: { counts: { filed: 4, all: 9 }, statuses: {}, stages: {} },
  notifications: { unread: 3 },
  dm: { unread: 5, conversations: 2 },
}

function calls(prefix: string) {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith(prefix)).length
}

/** The shell's use of the badges: one clock, and three readers of it. */
function Frame() {
  useBadgeClock(true)
  const counts = useBadges(stageCountsOf)
  const unread = useUnreadMessages()
  return (
    <p>
      filed {counts.data?.counts.filed ?? "-"} · messages {unread.data?.conversations ?? "-"}
    </p>
  )
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function press() {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  badges = {
    stage_counts: { counts: { filed: 4, all: 9 }, statuses: {}, stages: {} },
    notifications: { unread: 3 },
    dm: { unread: 5, conversations: 2 },
  }
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({ "/api/auth/me": () => FACULTY, "/api/shell/badges": () => badges })
  )
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the shell's badges", () => {
  it("asks once for everything, and never for the three old endpoints", async () => {
    renderWithProviders(<Frame />)
    await wait(0)
    expect(screen.getByText("filed 4 · messages 2")).toBeInTheDocument()
    expect(calls("/api/shell/badges")).toBe(1)
    expect(calls("/api/claims/counts")).toBe(0)
    expect(calls("/api/dm/unread")).toBe(0)
    expect(calls("/api/notifications/unread-count")).toBe(0)
  })

  it("asks again every two minutes, once per round however many things read it", async () => {
    renderWithProviders(<Frame />)
    await wait(0)
    await wait(BADGES_POLL_MS - 1)
    expect(calls("/api/shell/badges")).toBe(1)
    await wait(1)
    expect(calls("/api/shell/badges")).toBe(2)
    await wait(BADGES_POLL_MS)
    expect(calls("/api/shell/badges")).toBe(3)
  })

  it("shows the newer numbers when the next round answers differently", async () => {
    renderWithProviders(<Frame />)
    await wait(0)
    badges = { ...badges, dm: { unread: 9, conversations: 4 } }
    await wait(BADGES_POLL_MS)
    // Query Client hands a new answer to the page on its next tick.
    await wait(1)
    expect(screen.getByText("filed 4 · messages 4")).toBeInTheDocument()
  })

  it("stops asking once nobody has touched the page for five minutes", async () => {
    renderWithProviders(<Frame />)
    await wait(0)
    await wait(BADGES_IDLE_MS)
    const askedWhileActive = calls("/api/shell/badges")
    // Rounds at 2 and 4 minutes; the 6-minute round falls after the page went idle.
    expect(askedWhileActive).toBe(3)

    await wait(60 * 60_000)
    expect(calls("/api/shell/badges")).toBe(askedWhileActive)
  })

  it("asks at once when the person comes back, then carries on every two minutes", async () => {
    renderWithProviders(<Frame />)
    await wait(0)
    await wait(BADGES_IDLE_MS + 10 * 60_000)
    const before = calls("/api/shell/badges")

    badges = { ...badges, notifications: { unread: 8 } }
    press()
    await wait(0)
    expect(calls("/api/shell/badges")).toBe(before + 1)

    await wait(BADGES_POLL_MS - 1)
    expect(calls("/api/shell/badges")).toBe(before + 1)
    await wait(1)
    expect(calls("/api/shell/badges")).toBe(before + 2)
  })

  it("input while active does not cause extra requests", async () => {
    renderWithProviders(<Frame />)
    await wait(0)
    for (let i = 0; i < 20; i++) {
      press()
      await wait(1_000)
    }
    expect(calls("/api/shell/badges")).toBe(1)
  })
})
