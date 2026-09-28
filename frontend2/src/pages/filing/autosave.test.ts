import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useDebouncedSave } from "./autosave"

describe("useDebouncedSave", () => {
  afterEach(() => vi.useRealTimers())

  it("saves once, after the delay, when the form is still unsaved", () => {
    vi.useFakeTimers()
    const dirty = { current: true }
    const save = vi.fn()
    renderHook(() => useDebouncedSave(1, dirty, save, 100))
    vi.advanceTimersByTime(99)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("does not save a draft of a paper that was filed before the timer fired", () => {
    vi.useFakeTimers()
    const dirty = { current: true }
    const save = vi.fn()
    renderHook(() => useDebouncedSave(1, dirty, save, 100))
    dirty.current = false // filing succeeded and cleared the flag
    vi.advanceTimersByTime(200)
    expect(save).not.toHaveBeenCalled()
  })
})
