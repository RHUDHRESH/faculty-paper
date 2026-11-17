import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { TeamCheckBlock, type TeamCheck } from "@/pages/review/team-check"

const PASSING: TeamCheck = {
  team_code: "ZZ26CS0001",
  team_url: "/teams/ZZ26CS0001",
  ok: true,
  lines: [
    { key: "roster", ok: true, text: "Team ZZ26CS0001 is on the roster." },
    { key: "mentor", ok: true, text: "Dr Asha Menon is the team's mentor." },
    { key: "unclaimed", ok: true, text: "The team is not claimed on any other claim." },
    { key: "students", ok: true, text: "2 students listed on the team." },
    { key: "conference", ok: true, text: "The paper is a conference paper (Conference Paper)." },
  ],
}

const wrap = (check: TeamCheck | null | undefined) =>
  render(
    <MemoryRouter>
      <TeamCheckBlock check={check} />
    </MemoryRouter>
  )

describe("the team check on a student-project claim", { timeout: 20_000 }, () => {
  it("draws nothing on any other claim", () => {
    const { container } = wrap(null)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the five lines, each passing, in the server's words", () => {
    wrap(PASSING)
    expect(screen.getByRole("heading", { name: "Team check" })).toBeInTheDocument()
    const lines = screen.getAllByRole("listitem")
    expect(lines).toHaveLength(5)
    for (const li of lines) expect(li).toHaveAttribute("data-ok", "true")
    expect(screen.getByText("The team passes every check.")).toBeInTheDocument()
    expect(screen.getByText("2 students listed on the team.")).toBeInTheDocument()
    expect(screen.getAllByText("Passes:", { exact: false }).length).toBe(5)
  })

  it("links to the team", () => {
    wrap(PASSING)
    expect(screen.getByRole("link", { name: "Open team ZZ26CS0001" })).toHaveAttribute("href", "/teams/ZZ26CS0001")
  })

  it("marks the lines that fail, says how many, and tells the reviewer to look first", () => {
    wrap({
      ...PASSING,
      ok: false,
      lines: PASSING.lines.map((l) =>
        l.key === "mentor"
          ? { ...l, ok: false, text: "The roster names Dr Roster Only as mentor, not Dr Asha Menon." }
          : l.key === "unclaimed"
            ? { ...l, ok: false, text: "The team is already claimed on claim FP-2025-000007." }
            : l
      ),
    })
    expect(screen.getByText(/2 of 5 checks do not pass/)).toBeInTheDocument()
    const mentor = screen.getByText(/names Dr Roster Only as mentor/).closest("li")!
    expect(mentor).toHaveAttribute("data-ok", "false")
    expect(within(mentor).getByText("Fails:", { exact: false })).toBeInTheDocument()
    const claimed = screen.getByText(/already claimed on claim FP-2025-000007/).closest("li")!
    expect(claimed).toHaveAttribute("data-check", "unclaimed")
    expect(screen.getAllByRole("listitem").filter((li) => li.getAttribute("data-ok") === "true")).toHaveLength(3)
  })

  it("says one failing line in the singular", () => {
    wrap({
      ...PASSING,
      ok: false,
      lines: PASSING.lines.map((l) => (l.key === "conference" ? { ...l, ok: false, text: "The paper is a Journal." } : l)),
    })
    expect(screen.getByText(/1 of 5 checks does not pass/)).toBeInTheDocument()
  })

  it("has no link when there is no team to open", () => {
    wrap({ team_code: null, team_url: null, ok: false, lines: [{ key: "roster", ok: false, text: "No team is named on this claim." }] })
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("No team is named on this claim.")).toBeInTheDocument()
  })
})
