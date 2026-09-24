import { fireEvent, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { navFor } from "@/app/nav"
import { Leaderboard } from "@/pages/leaderboard"
import { FACULTY, failing, fakeApi, renderWithProviders } from "@/test/harness"

/**
 * The leaderboard is open to every role and never carries money. These pin
 * what a reader checks first: where am I, which way did I move, what does
 * the score mean, and does changing a filter actually ask for that board.
 */

const PERIODS = [
  { key: "academic", label: "This academic year (2026–27)", from: "2026-06-01", to: "2027-05-31" },
  { key: "last_academic", label: "Last academic year (2025–26)", from: "2025-06-01", to: "2026-05-31" },
  { key: "calendar", label: "This calendar year (2026)", from: "2026-01-01", to: "2026-12-31" },
  { key: "all", label: "All time", from: null, to: null },
]

const SINCE = { key: "last_academic", label: "2025–26", from: "2025-06-01", to: "2026-05-31" }

const METHOD = {
  weights: { Q1: 4, Q2: 3, Q3: 2, Q4: 1, other_indexed: 1 },
  from_claims: 92,
  from_ledger: 2633,
  left_out: 282,
  citations: false,
  updated: "2026-09-24T06:00:00Z",
}

function person(id: string, name: string, rank: number, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    department: "ECE",
    designation: "Assistant Professor",
    rank,
    joint: false,
    papers: 5,
    q1: 2,
    score: 14,
    first_author: 1,
    movement: null,
    me: false,
    ...over,
  }
}

const PEOPLE = {
  board: "people",
  period: { ...PERIODS[0], compared_with: SINCE },
  periods: PERIODS,
  sort: "score",
  department: null,
  departments: ["CSE", "ECE"],
  rows: [
    person("u-ravi", "Dr Ravi Kumar", 1, { score: 20, movement: 2 }),
    person(FACULTY.id, FACULTY.name, 2, { me: true, score: 14, movement: -1, department: "Mechanical Engineering" }),
    person("u-mina", "Dr Mina Das", 3, { department: "CSE", score: 0, papers: 0, q1: 0 }),
  ],
  me: { rank: 2, of: 3, joint: false, value: 14, movement: -1 },
  totals: { papers: 11, people: 3, people_with_papers: 2 },
  method: METHOD,
}

const DEPARTMENTS = {
  board: "departments",
  period: { ...PERIODS[0], compared_with: SINCE },
  periods: PERIODS,
  sort: "score",
  per_head: false,
  rows: [
    {
      department: "ECE", people: 72, rank: 1, joint: false, papers: 18, q1: 3, score: 54,
      first_author: 4, per_head: { score: 0.75, papers: 0.25, q1: 0.04, first_author: 0.06 },
      movement: 0, me: false,
    },
    {
      department: "Mechanical Engineering", people: 28, rank: 2, joint: false, papers: 7, q1: 1,
      score: 20, first_author: 2, per_head: { score: 0.71, papers: 0.25, q1: 0.04, first_author: 0.07 },
      movement: 1, me: true,
    },
  ],
  me: { department: "Mechanical Engineering", rank: 2, of: 2, joint: false, movement: 1 },
  totals: { papers: 25, departments: 2, people: 100 },
  method: METHOD,
}

function mount(table: Record<string, (path: string) => unknown> = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/leaderboard": (path) => (path.includes("board=departments") ? DEPARTMENTS : PEOPLE),
      ...table,
    })
  )
  renderWithProviders(<Leaderboard />, { route: "/leaderboard" })
}

function askedFor(): string[] {
  return vi.mocked(api).mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith("/api/leaderboard"))
}

describe("Leaderboard", () => {
  it("is in the sidebar for every role", () => {
    for (const role of ["FACULTY", "HOD", "PRINCIPAL", "DIRECTOR", "FINANCE", "SUPER_ADMIN", "RESEARCH_CELL"] as const) {
      expect(navFor(role).map((i) => i.to)).toContain("/leaderboard")
    }
  })

  it("tells the reader where they stand and which way they moved", async () => {
    mount()
    expect(await screen.findByText("You're 2nd of 3")).toBeInTheDocument()
    expect(screen.getByText(/Down 1 place since 2025–26/)).toBeInTheDocument()
  })

  it("marks the reader's own row, and links every name to a profile", async () => {
    mount()
    const table = await screen.findByRole("table")
    const mine = within(table).getByText("You")
    expect(mine.closest("tr")).toHaveAttribute("aria-current", "true")
    expect(within(table).getByRole("link", { name: /Dr Ravi Kumar/ })).toHaveAttribute("href", "/people/u-ravi")
  })

  it("says movement in words as well as with an arrow", async () => {
    mount()
    await screen.findByRole("table")
    expect(screen.getByLabelText("Up 2 places")).toBeInTheDocument()
    expect(screen.getByLabelText("Down 1 place")).toBeInTheDocument()
  })

  it("prints the weighting it ranks by and where the papers came from", async () => {
    mount()
    await screen.findByRole("table")
    expect(screen.getByText(/Q1 = 4, Q2 = 3, Q3 = 2, Q4 = 1/)).toBeInTheDocument()
    expect(screen.getByText(/2,633 from the payment ledger/)).toBeInTheDocument()
    expect(screen.getByText(/Citations are not recorded/)).toBeInTheDocument()
  })

  it("asks for the period, measure and department the reader picks", async () => {
    mount()
    await screen.findByRole("table")
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "last_academic" } })
    fireEvent.change(screen.getByLabelText("Rank by"), { target: { value: "q1" } })
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "ECE" } })
    const last = askedFor().at(-1) ?? ""
    expect(last).toContain("period=last_academic")
    expect(last).toContain("sort=q1")
    expect(last).toContain("department=ECE")
  })

  it("shows the department board with a per-person column and the reader's department", async () => {
    mount()
    await screen.findByRole("table")
    fireEvent.click(screen.getByRole("tab", { name: "Departments" }))
    expect(await screen.findByText("Your department is 2nd of 2")).toBeInTheDocument()
    expect(screen.getByText("0.71")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch", { name: /per person/i }))
    expect(askedFor().at(-1)).toContain("per_head=true")
  })

  it("never prints a rupee figure", async () => {
    mount()
    await screen.findByRole("table")
    expect(document.body.textContent).not.toMatch(/₹/)
  })

  it("says so plainly when the reader has nothing in the period", async () => {
    mount({
      "/api/leaderboard": () => ({
        ...PEOPLE,
        rows: PEOPLE.rows.map((r) => (r.me ? { ...r, papers: 0, score: 0, q1: 0, rank: 3, joint: true } : r)),
        me: { rank: 3, of: 3, joint: true, value: 0, movement: null },
      }),
    })
    expect(await screen.findByText(/You have no papers counted in this period yet/)).toBeInTheDocument()
  })

  it("does not tell somebody with papers they have none because they have no Q1", async () => {
    // Found in review: "no papers" was decided by the ranked measure.
    mount({
      "/api/leaderboard": () => ({
        ...PEOPLE,
        sort: "q1",
        rows: PEOPLE.rows.map((r) => (r.me ? { ...r, papers: 5, q1: 0, rank: 3, joint: true } : r)),
        me: { rank: 3, of: 3, joint: true, value: 0, movement: null },
      }),
    })
    expect(await screen.findByText("You're joint 3rd of 3")).toBeInTheDocument()
    expect(screen.queryByText(/You have no papers counted/)).toBeNull()
  })

  it("shows a failure as a failure, not as an empty board", async () => {
    mount({ "/api/leaderboard": failing(500) })
    expect(await screen.findByText("Could not load the leaderboard")).toBeInTheDocument()
  })
})
