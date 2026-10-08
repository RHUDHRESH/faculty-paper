import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { JournalRow, PersonRow } from "@/ui/entity"

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe("entity rows", () => {
  it("PersonRow: a face, a linked name, the department and designation, the reason, and one Message link", () => {
    wrap(
      <PersonRow
        person={{ name: "Dr Asha Rao", initials: "AR", photo_url: null, department: "ECE", designation: "Professor" }}
        to="/u/u1"
        context="3 papers on Language assessment"
        messageTo="/messages/u1"
      />
    )
    expect(screen.getByRole("link", { name: "Dr Asha Rao" })).toHaveAttribute("href", "/u/u1")
    expect(screen.getByText("ECE · Professor")).toBeInTheDocument()
    expect(screen.getByText("3 papers on Language assessment")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Message" })).toHaveAttribute("href", "/messages/u1")
    expect(screen.getAllByRole("link")).toHaveLength(2)
  })

  it("JournalRow: a linked name, the quartile, subjects and colleagues on one line, and no action", () => {
    wrap(<JournalRow name="IEEE Access" to="/search?scope=journals&q=IEEE" quartile="Q1" colleagues={4} subjects={["Power", "Grids"]} />)
    expect(screen.getByRole("link", { name: "IEEE Access" })).toBeInTheDocument()
    expect(screen.getByText("Q1")).toBeInTheDocument()
    expect(screen.getByText("Power · Grids · 4 colleagues published here")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})
