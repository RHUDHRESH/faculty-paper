import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let reduce = false
vi.mock("motion/react", async (orig) => {
  const real = await orig<typeof import("motion/react")>()
  return { ...real, useReducedMotion: () => reduce }
})

import { CountUp } from "./count-up"
import { Stagger, STAGGER_CAP } from "./list"
import { StreamingText, ThinkingIndicator, useTypewriter } from "./stream"

afterEach(() => {
  reduce = false
  vi.useRealTimers()
})

describe("StreamingText", () => {
  it("animates only newly arrived words", () => {
    const { container, rerender } = render(<StreamingText text="Hello there " />)
    expect(container.querySelectorAll(".stream-word")).toHaveLength(2)
    rerender(<StreamingText text="Hello there general Kenobi" />)
    const words = [...container.querySelectorAll(".stream-word")].map((n) => n.textContent)
    expect(words).toEqual(["general", "Kenobi"])
    expect(container.textContent).toBe("Hello there general Kenobi")
  })

  it("re-renders a half-arrived word whole", () => {
    const { container, rerender } = render(<StreamingText text="Hel" />)
    rerender(<StreamingText text="Hello world" />)
    expect([...container.querySelectorAll(".stream-word")].map((n) => n.textContent)).toEqual(["Hello", "world"])
  })

  it("treats replaced text as all new", () => {
    const { container, rerender } = render(<StreamingText text="first answer" />)
    rerender(<StreamingText text="other" />)
    expect(container.querySelectorAll(".stream-word")).toHaveLength(1)
  })

  it("renders plain text under reduced motion", () => {
    reduce = true
    const { container } = render(<StreamingText text="no motion here" />)
    expect(container.querySelectorAll(".stream-word")).toHaveLength(0)
    expect(container.textContent).toBe("no motion here")
  })
})

function Typed({ s }: { s: string }) {
  return <p data-testid="t">{useTypewriter(s, 1, 10)}</p>
}

describe("useTypewriter", () => {
  beforeEach(() => vi.useFakeTimers())
  it("reveals progressively then completely", () => {
    render(<Typed s="one two three" />)
    expect(screen.getByTestId("t").textContent).toBe("")
    act(() => vi.advanceTimersByTime(10))
    expect(screen.getByTestId("t").textContent).toBe("one ")
    for (let i = 0; i < 5; i++) act(() => vi.advanceTimersByTime(10))
    expect(screen.getByTestId("t").textContent).toBe("one two three")
  })
  it("shows everything at once under reduced motion", () => {
    reduce = true
    render(<Typed s="one two three" />)
    expect(screen.getByTestId("t").textContent).toBe("one two three")
  })
})

describe("reduced motion", () => {
  it("CountUp shows the final value immediately", () => {
    reduce = true
    const { container } = render(<CountUp value={1234} />)
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("1,234")
  })
  it("CountUp starts from zero with motion, final value still readable", () => {
    const { container } = render(<CountUp value={50} />)
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("0")
    expect(screen.getByText("50")).toHaveClass("sr-only")
  })
  it("Stagger adds no classes under reduced motion and caps otherwise", () => {
    const items = Array.from({ length: 12 }, (_, i) => <li key={i}>x</li>)
    const { container, rerender } = render(<ul><Stagger>{items}</Stagger></ul>)
    expect(container.querySelectorAll(".stagger-in")).toHaveLength(STAGGER_CAP)
    reduce = true
    rerender(<ul><Stagger>{[...items]}</Stagger></ul>)
    expect(container.querySelectorAll(".stagger-in")).toHaveLength(0)
  })
  it("ThinkingIndicator is announced", () => {
    render(<ThinkingIndicator label="Scouting" />)
    expect(screen.getByRole("status").textContent).toContain("Scouting")
  })
})
