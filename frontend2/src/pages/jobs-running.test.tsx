import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { RunningJobs } from "./jobs"

describe("RunningJobs", () => {
  it("lists in-progress jobs with how long they have run", () => {
    render(<RunningJobs rows={[{ id: "r", func: "core.tasks.run_scout", name: "Research scout", running_s: 125 }]} />)
    expect(screen.getByText("Research scout")).toBeTruthy()
    expect(screen.getByText(/Running for 2 min/)).toBeTruthy()
  })
  it("says so when nothing is running", () => {
    render(<RunningJobs rows={[]} />)
    expect(screen.getByText("Nothing is running at the moment.")).toBeTruthy()
  })
})
