import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { Answer, AnswerWord } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { EmptyState } from "@/ui/state"
import { Thread } from "@/ui/thread"

describe("the plain kit", () => {
  it("Answer renders a KPI row with one panel per item", () => {
    render(
      <MemoryRouter>
        <Answer
          items={[
            { value: 3, label: "Waiting" },
            { value: 5, label: "Paid", to: "/x" },
            { value: 0, label: "Late", zero: "Nothing late" },
          ]}
        />
      </MemoryRouter>
    )
    const group = screen.getByRole("group", { name: "At a glance" })
    expect(group.children).toHaveLength(3)
    expect(group.children[0].className).toContain("bg-surface")
  })

  it("AnswerWord has no background class", () => {
    render(<AnswerWord tone="sage">approved</AnswerWord>)
    const el = screen.getByText("approved")
    expect(el.className).not.toMatch(/\bbg-/)
    expect(el.className).toContain("text-positive")
  })

  it("EmptyState renders no img", () => {
    const { container } = render(<EmptyState title="Nothing here" illustration="empty-no-papers" />)
    expect(container.querySelector("img, picture")).toBeNull()
    expect(screen.getByText("Nothing here")).toBeTruthy()
  })

  it("Thread renders five cells", () => {
    render(
      <MemoryRouter>
        <Thread counts={{ filed: 1, checked: 2 }} you="checked" late={{ checked: 1 }} />
      </MemoryRouter>
    )
    const list = screen.getByRole("list", { name: "Where every claim is" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(5)
    expect(screen.getByText("Your desk")).toBeTruthy()
    expect(screen.getByText("1 late").className).toContain("text-caution")
  })

  it("Chip tones are washes with coloured text and no border", () => {
    const { rerender } = render(<Chip tone="positive">ok</Chip>)
    expect(screen.getByText("ok").className).toContain("bg-positive-wash")
    rerender(<Chip tone="critical">ok</Chip>)
    expect(screen.getByText("ok").className).toContain("text-critical")
    rerender(<Chip tone="gold">ok</Chip>)
    expect(screen.getByText("ok").className).toContain("bg-sunken")
    expect(screen.getByText("ok").className).not.toMatch(/border|ring|shadow/)
  })

  it("Button variants are flat", () => {
    render(
      <>
        <Button kind="primary">P</Button>
        <Button kind="default">D</Button>
        <Button kind="quiet">Q</Button>
        <Button kind="danger">X</Button>
      </>
    )
    expect(screen.getByText("P").className).toContain("bg-accent")
    expect(screen.getByText("D").className).toContain("border-edge")
    expect(screen.getByText("Q").className).toContain("hover:bg-sunken")
    expect(screen.getByText("X").className).toContain("bg-critical")
    for (const t of ["P", "D", "Q", "X"]) expect(screen.getByText(t).className).not.toMatch(/shadow|gradient/)
  })
})
