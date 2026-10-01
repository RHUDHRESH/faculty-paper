import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { AnswerLine, AnswerWord } from "@/ui/answer"
import { DotField } from "@/ui/dot-field"
import { FaceStack } from "@/ui/person"
import { Plate } from "@/ui/plate"
import { Stamp } from "@/ui/stamp"
import { Tabs } from "@/ui/tabs"
import { ClaimThread, Thread, THREAD_STAGES } from "@/ui/thread"

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

/** The pieces the art direction added (DESIGN.md): the Thread, the Stamp, the
 *  Plate, the dot field, the face stack, Tabs and the answer sentence. Each
 *  has one thing that must stay true when somebody restyles it. */

describe("Thread", () => {
  it("draws the five stations in the chain's order, each with its real count", () => {
    wrap(<Thread counts={{ filed: 14, checked: 3, approved: 1, authorised: 0, paid: 1284 }} />)
    const list = screen.getAllByRole("list", { name: "Where every claim is" })[0]
    const items = within(list).getAllByRole("listitem")
    expect(items).toHaveLength(THREAD_STAGES.length)
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Filed: 14 claims"),
      expect.stringContaining("Checked: 3 claims"),
      expect.stringContaining("Approved: 1 claim"),
      expect.stringContaining("Authorised: 0 claims"),
      // Never "99+": the real number, with Indian grouping.
      expect.stringContaining("Paid: 1,284 claims"),
    ])
  })

  it("rings the reader's own desk and says so in words, not only colour", () => {
    wrap(<Thread counts={{ filed: 14 }} you="filed" />)
    const list = screen.getAllByRole("list", { name: "Where every claim is" })[0]
    expect(within(list).getAllByText(/Your desk/).length).toBeGreaterThan(0)
    expect(within(list).getAllByRole("listitem")[0]).toHaveAttribute("aria-current", "step")
  })

  it("makes a station a link when it has a list behind it", () => {
    wrap(<Thread counts={{ filed: 2 }} to={{ filed: "/track?stage=submitted" }} />)
    expect(screen.getAllByRole("link", { name: /Filed/ })[0]).toHaveAttribute("href", "/track?stage=submitted")
  })

  it("reads a station that has not loaded as loading, not as zero", () => {
    wrap(<Thread counts={undefined} />)
    expect(screen.getAllByText(/Filed: loading/).length).toBeGreaterThan(0)
  })
})

describe("ClaimThread", () => {
  it("fills the stations up to the claim and marks where it is", () => {
    wrap(<ClaimThread at="approved" />)
    const list = screen.getByRole("list", { name: /Approved/ })
    const items = within(list).getAllByRole("listitem")
    expect(items[0]).toHaveTextContent("done")
    expect(items[2]).toHaveAttribute("aria-current", "step")
    expect(items[3]).toHaveTextContent("not yet")
  })
})

describe("Stamp", () => {
  it("names the verb and the date for a screen reader", () => {
    render(<Stamp verb="Approved" date="1 Oct 2026" />)
    expect(screen.getByRole("img", { name: "Approved, 1 Oct 2026" })).toBeInTheDocument()
  })
})

describe("Plate", () => {
  it("mounts the picture and puts its caption under it, on the page", () => {
    const { container } = render(<Plate name="spot-home-faculty" width={160} caption="A desk, as it should be." />)
    expect(container.querySelector(".plate")).not.toBeNull()
    const caption = screen.getByText("A desk, as it should be.")
    expect(caption.tagName).toBe("FIGCAPTION")
    expect(container.querySelector(".plate")?.contains(caption)).toBe(false)
  })
})

describe("DotField", () => {
  it("draws one dot per paper and names every group with its real count", () => {
    const { container } = render(
      <DotField
        groups={[
          { key: "q1", label: "Q1", count: 12 },
          { key: "q3", label: "Q3", count: 40 },
        ]}
      />
    )
    expect(container.querySelectorAll('[role="img"] > span')).toHaveLength(52)
    expect(screen.getByRole("img", { name: "52 papers: 12 Q1, 40 Q3" })).toBeInTheDocument()
    expect(screen.getByText("40")).toBeInTheDocument()
  })

  it("says so when one dot stands for several, and still prints the real counts", () => {
    const { container } = render(<DotField max={50} groups={[{ key: "a", label: "A", count: 400 }]} />)
    expect(container.querySelectorAll('[role="img"] > span').length).toBeLessThanOrEqual(50)
    expect(screen.getByText(/One dot is 8 papers/)).toBeInTheDocument()
    expect(screen.getByText("400")).toBeInTheDocument()
  })
})

describe("FaceStack", () => {
  it("shows four faces and counts the rest, under one accessible name", () => {
    const people = Array.from({ length: 6 }, (_, i) => ({ name: `Person ${i}`, initials: `P${i}`, photo_url: null }))
    render(<FaceStack people={people} label="Co-authors" />)
    const group = screen.getByRole("group")
    expect(group).toHaveAttribute("aria-label", expect.stringContaining("Co-authors: Person 0"))
    expect(within(group).getByText("+2")).toBeInTheDocument()
  })
})

describe("Tabs", () => {
  function Harness() {
    const [v, setV] = useState("a")
    return (
      <Tabs
        label="Papers"
        value={v}
        onChange={setV}
        tabs={[
          { id: "a", label: "All", count: 145 },
          { id: "b", label: "Paid", count: 119 },
          { id: "c", label: "Not eligible", count: 1 },
        ]}
      />
    )
  }

  it("is one tab stop and moves with the arrow keys, Home and End", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"])
    tabs[0].focus()
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: /Paid/ })).toHaveAttribute("aria-selected", "true")
    await user.keyboard("{End}")
    expect(screen.getByRole("tab", { name: /Not eligible/ })).toHaveAttribute("aria-selected", "true")
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: /All/ })).toHaveAttribute("aria-selected", "true")
  })

  it("prints the count as a real number", () => {
    render(<Harness />)
    expect(screen.getByRole("tab", { name: /All/ })).toHaveTextContent("145")
  })
})

describe("AnswerLine", () => {
  it("is a status line in the display face, with a word that can be a pill", () => {
    render(
      <AnswerLine>
        Nothing needs you. One claim is <AnswerWord tone="sage">being checked</AnswerWord>.
      </AnswerLine>
    )
    const line = screen.getByRole("status")
    expect(line).toHaveClass("display-xl")
    expect(line).toHaveTextContent("Nothing needs you. One claim is being checked.")
  })
})
