import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { VerticalTabs } from "@/ui/vertical-tabs"

const ITEMS = [
  { id: "month", label: "Monthly" },
  { id: "year", label: "Yearly" },
  { id: "all", label: "All time" },
]

function Harness({ start = "month" }: { start?: string }) {
  const [value, setValue] = useState(start)
  return (
    <>
      <VerticalTabs label="Period" value={value} onChange={setValue} items={ITEMS} idPrefix="p" />
      <p data-testid="now">{value}</p>
    </>
  )
}

function phone(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe("VerticalTabs", () => {
  it("is a vertical tab list: tablist, tabs, one selected, one tab stop", () => {
    phone(false)
    render(<Harness />)
    const list = screen.getByRole("tablist", { name: "Period" })
    expect(list).toHaveAttribute("aria-orientation", "vertical")
    expect(list).toHaveAttribute("data-variant", "vertical")
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((t) => t.textContent)).toEqual(["Monthly", "Yearly", "All time"])
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"])
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1])
    expect(tabs[0]).toHaveAttribute("aria-controls", "p-month")
    expect(tabs[0]).toHaveAttribute("id", "p-tab-month")
  })

  it("moves and selects with the arrow keys, wraps, and jumps with Home and End", () => {
    phone(false)
    render(<Harness />)
    const key = (k: string) => fireEvent.keyDown(screen.getByRole("tablist"), { key: k })
    key("ArrowDown")
    expect(screen.getByTestId("now")).toHaveTextContent("year")
    expect(screen.getByRole("tab", { name: "Yearly" })).toHaveFocus()
    key("ArrowDown")
    expect(screen.getByTestId("now")).toHaveTextContent("all")
    key("ArrowDown")
    expect(screen.getByTestId("now")).toHaveTextContent("month")
    key("ArrowUp")
    expect(screen.getByTestId("now")).toHaveTextContent("all")
    key("Home")
    expect(screen.getByTestId("now")).toHaveTextContent("month")
    key("End")
    expect(screen.getByTestId("now")).toHaveTextContent("all")
  })

  it("selects on click", () => {
    phone(false)
    render(<Harness />)
    fireEvent.click(screen.getByRole("tab", { name: "All time" }))
    expect(screen.getByTestId("now")).toHaveTextContent("all")
  })

  it("becomes a horizontal segmented control on a phone, with the same roles and keys", () => {
    phone(true)
    render(<Harness />)
    const list = screen.getByRole("tablist", { name: "Period" })
    expect(list).toHaveAttribute("aria-orientation", "horizontal")
    expect(list).toHaveAttribute("data-variant", "segmented")
    expect(screen.getAllByRole("tab")).toHaveLength(3)
    fireEvent.keyDown(list, { key: "ArrowRight" })
    expect(screen.getByTestId("now")).toHaveTextContent("year")
    fireEvent.keyDown(list, { key: "ArrowLeft" })
    expect(screen.getByTestId("now")).toHaveTextContent("month")
  })
})
