import { fireEvent, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { navFor } from "@/app/nav"
import { Leaderboard, rankText, standing, toCsv, type HonoursBoard } from "@/pages/leaderboard"
import { FACULTY, failing, fakeApi, renderWithProviders } from "@/test/harness"

function row(id: string, name: string, rank: number | null, value: number, over: Record<string, unknown> = {}) {
  return {
    rank, joint: false,
    person: { id, name, initials: "XX", photo_url: null, department: "ECE", designation: null },
    value, papers: value, score: value * 2, q1: 1, first: 1, cited: 3, h_index: 1,
    breakdown: { Q1: 1 }, spark: [0, 1, 2, 1, value], move: null, new: false,
    ...over,
  }
}

const SPAN = { key: "academic", label: "This academic year (2026–27)", from: "2026-06-01", to: "2027-05-31" }

function board(over: Partial<HonoursBoard> = {}): HonoursBoard {
  const rows = [
    row("u-ravi", "Dr Ravi Kumar", 1, 9, { move: 2 }),
    row("u-lila", "Dr Lila Rao", 2, 7),
    row("u-joe", "Dr Joe Paul", 3, 4),
    row(FACULTY.id, FACULTY.name, 4, 3, { move: -1 }),
    row("u-mina", "Dr Mina Das", null, 0),
  ]
  return {
    measure: "papers", label: "Most papers", unit: "papers",
    period: { ...SPAN, compared_with: null }, periods: [SPAN], scope: null,
    departments_list: ["CSE", "ECE"], filters: { topic: null, journal: null },
    podium: rows.slice(0, 3), rows, ranked: 4, population: 5,
    distribution: [{ bucket: "0", lo: null, hi: 0, count: 1 }, { bucket: "1–9", lo: 1, hi: 9, count: 4 }],
    departments: [{
      department: "ECE", faculty: 5, value: 23, per_faculty: 4.6, papers: 23, papers_per_faculty: 4.6,
      score_per_faculty: 9.2, rank: 1, rank_per_faculty: 1, trend: [{ year: 2026, papers: 23 }],
    }],
    college_trend: [{ year: 2025, papers: 10 }, { year: 2026, papers: 23 }],
    top_topics: [], top_journals: [], topic_options: ["AI"], journal_options: ["IEEE Access"],
    totals: { papers: 23, people: 5, people_with_papers: 4 }, spark_years: [2022, 2023, 2024, 2025, 2026],
    method: { weights: { Q1: 4, Q2: 3, Q3: 2, Q4: 1, other: 1 }, source: "publication record", papers_in_record: 40, newcomer_months: 24, updated: "" },
    me: { id: FACULTY.id, rank: 4, joint: false, of: 4, population: 5, dept_rank: 4, dept_of: 4, department: "ECE", percentile: 100, move: -1, value: 3, alltime_rank: null },
    ...over,
  }
}

function mount(data: HonoursBoard | ReturnType<typeof failing> = board(), route = "/leaderboard") {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/leaderboard": typeof data === "function" ? data : () => data,
      "/api/wall": () => ({ month: "2026-09", months: [], cards: [], departments: [] }),
    })
  )
  renderWithProviders(<Leaderboard />, { route })
}

const asked = () => vi.mocked(api).mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/leaderboard"))

describe("Leaderboard", () => {
  it("is in the sidebar for every role", () => {
    for (const role of ["FACULTY", "HOD", "PRINCIPAL", "DIRECTOR", "FINANCE", "SUPER_ADMIN", "RESEARCH_CELL"] as const) {
      expect(navFor(role).map((i) => i.to)).toContain("/leaderboard")
    }
  })

  it("shows a podium, the reader's place, and marks their row", async () => {
    mount()
    expect(await screen.findByRole("list", { name: "Podium" })).toBeInTheDocument()
    expect(screen.getByText(/You: #4 of 4 in the college/)).toBeInTheDocument()
    const mine = document.querySelector('tr[aria-current="true"]') as HTMLElement
    expect(within(mine).getByText(/Dr Asha Menon/)).toBeInTheDocument()
  })

  it("never gives a zero a rank", async () => {
    mount()
    await screen.findByRole("list", { name: "Podium" })
    const row = screen.getAllByText("Dr Mina Das")[0].closest("tr")!
    expect(within(row).getByText("—")).toBeInTheDocument()
    expect(rankText(null, true)).toBe("—")
    expect(rankText(4, true)).toBe("=4")
  })

  it("does not contradict the table when the reader has nothing counted", () => {
    const b = board({ me: { ...board().me!, rank: null, value: 0, percentile: null, alltime_rank: 12 } })
    expect(standing(b)).toBe("No papers counted for you in this academic year (2026–27) yet — your all-time rank is #12.")
  })

  it("asks for the chosen category and period", async () => {
    mount()
    await screen.findByRole("list", { name: "Podium" })
    fireEvent.click(screen.getByRole("button", { name: /Q1/ }))
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "last12" } })
    await screen.findByRole("list", { name: "Podium" })
    expect(asked().some((p) => p.includes("category=q1") && p.includes("period=last12"))).toBe(true)
  })

  it("shows departments per faculty member", async () => {
    mount(board(), "/leaderboard?view=departments")
    expect(await screen.findByText(/per faculty member/i, { selector: "h2,h3,figcaption,p,span,div" })).toBeInTheDocument()
  })

  it("exports CSV without money", () => {
    const csv = toCsv(board())
    expect(csv.split("\n")[0]).toContain("Rank,Name,Department")
    expect(csv).not.toMatch(/₹|amount/i)
  })

  it("never prints a rupee figure", async () => {
    mount()
    await screen.findByRole("list", { name: "Podium" })
    expect(document.body.textContent).not.toMatch(/₹/)
  })

  it("shows a failure as a failure", async () => {
    mount(failing())
    expect(await screen.findByText("Could not load the leaderboard.")).toBeInTheDocument()
  })
})
