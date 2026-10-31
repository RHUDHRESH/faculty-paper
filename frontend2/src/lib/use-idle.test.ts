import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useIdle } from "@/lib/use-idle"

/**
 * "Idle" is a tab that is on screen with nobody at it. The clock is fake so a
 * five-minute wait costs nothing, and every claim is about what a person did
 * (or did not do) rather than about which listener was attached.
 */

const LIMIT = 5 * 60_000

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe("useIdle", () => {
  it("is active at first, and idle once the time has passed without any input", async () => {
    const { result } = renderHook(() => useIdle(LIMIT))
    expect(result.current).toBe(false)
    await wait(LIMIT - 1)
    expect(result.current).toBe(false)
    await wait(1)
    expect(result.current).toBe(true)
  })

  it.each([
    ["pointerdown", () => window.dispatchEvent(new Event("pointerdown"))],
    ["pointermove", () => document.body.dispatchEvent(new Event("pointermove", { bubbles: true }))],
    ["keydown", () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))],
    ["touchstart", () => document.body.dispatchEvent(new Event("touchstart", { bubbles: true }))],
    ["wheel", () => document.body.dispatchEvent(new Event("wheel", { bubbles: true }))],
    // Scroll does not bubble; it is seen on the way down.
    ["scroll", () => document.body.dispatchEvent(new Event("scroll"))],
  ])("%s counts as being there, and starts the time again", async (_name, act_) => {
    const { result } = renderHook(() => useIdle(LIMIT))
    await wait(LIMIT - 1_000)
    act(act_)
    // Without the input this would have gone idle a second ago.
    await wait(LIMIT - 1)
    expect(result.current).toBe(false)
    await wait(1)
    expect(result.current).toBe(true)
  })

  it("comes back the moment there is input, and can go idle again after", async () => {
    const { result } = renderHook(() => useIdle(LIMIT))
    await wait(LIMIT)
    expect(result.current).toBe(true)

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
    })
    expect(result.current).toBe(false)

    await wait(LIMIT)
    expect(result.current).toBe(true)
  })

  it("treats returning to the window as coming back", async () => {
    const { result } = renderHook(() => useIdle(LIMIT))
    await wait(LIMIT)
    expect(result.current).toBe(true)
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(result.current).toBe(false)
  })

  it("stops listening when the component goes away", async () => {
    const remove = vi.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => useIdle(LIMIT))
    unmount()
    const removed = remove.mock.calls.map(([type]) => type)
    for (const type of ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "scroll"]) {
      expect(removed).toContain(type)
    }
    // And no timer is left to wake a component that no longer exists.
    expect(vi.getTimerCount()).toBe(0)
    remove.mockRestore()
  })
})
