import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Standings, type StandingRow, type StandingsPayload } from "@/pages/standings"
import type { PapersPayload } from "@/pages/standing-papers"
import { FACULTY, FINANCE, HOD, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

const row = (n: number, name: string, snip: number, remuneration: number | undefined, count: number): StandingRow => ({
  key: `u:id-${n}`,
  user_id: `id-${n}`,
  staff_id: `S${n}`,
  name,
  department: "Physics",
  designation: "Professor",
  photo: null,
  initials: name.slice(0, 2).toUpperCase(),
  snip,
  count,
  ...(remuneration == null ? {} : { remuneration, rank_remuneration: n }),
  rank_snip: n,
  rank_count: n,
})

const CHOICES = { months: ["2026-09", "2026-08"], academic_years: [2026, 2025], calendar_years: [2026] }

const FULL: StandingsPayload = {
  period: "all",
  label: "All time",
  month: null,
  year: null,
  academic: true,
  scope: "college",
  money: true,
  department: null,
  choices: CHOICES,
  page: 1,
  page_size: 50,
  total: 3,
  totals: { snip: 25.5, remuneration: 1500000, count: 40 },
  rows: [row(1, "Asha Quiet", 12.5, 1234567, 31), row(2, "Ravi Steady", 9, 54000, 4), row(3, "Nobody Yet", 0, 0, 0)],
}
FULL.rows[2].rank_snip = null
FULL.rows[2].rank_count = null
FULL.rows[2].rank_remuneration = null

const PAPERS: PapersPayload = {
  label: "All time",
  money: true,
  person: { user_id: "id-1", key: "u:id-1", staff_id: "S1", name: "Asha Quiet", department: "Physics", designation: "Professor", photo: null },
  papers: [
    { title: "Deep Nets", journal: "Journal A", issn: "1234-5678", doi: null, month_paid: "2026-07-01", snip: 2, snip_source: "settled sheet", duplicate_of: null, counted: true, amount: 1000, counted_in: "paid" },
    { title: "deep nets.", journal: "Journal A", issn: null, doi: null, month_paid: "2026-09-01", snip: 0, snip_source: "none", duplicate_of: "Deep Nets", counted: false, amount: 500, counted_in: "paid" },
    { title: "From a claim", journal: null, issn: null, doi: "10.1/x", month_paid: "2026-09-01", snip: 1.25, snip_source: "claim", duplicate_of: null, counted: true, amount: 0, counted_in: "count only" },
  ],
  totals: { snip: 3.25, count: 2, remuneration: 1500 },
  voided: [{ title: "Voided one", month_paid: "2026-09-01", amount: 5000 }],
  rules: "A paper is counted once, however many times it was paid or listed.",
}

function mount(me: typeof FINANCE, payload: StandingsPayload | ((path: string) => unknown), extra: ApiTable = {}, route = "/standings") {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/dashboard/standings?": (path) => (typeof payload === "function" ? payload(path) : payload),
      "/api/meta/departments": () => ["Physics", "Chemistry"],
      "/api/dashboard/standings/": () => PAPERS,
      ...extra,
    })
  )
  renderWithProviders(<Standings />, { route })
}

afterEach(() => vi.unstubAllGlobals())

describe("Standings", () => {
  it("draws the college figures and one table of everybody, with ranks, SNIP, incentive and papers", async () => {
    mount(FINANCE, FULL)
    const table = await screen.findByRole("table")
    const figures = screen.getByTestId("standings-figures")
    expect(within(figures).getByText("25.50")).toBeInTheDocument()
    expect(within(figures).getByText("₹15,00,000")).toBeInTheDocument()
    expect(within(figures).getByText("40")).toBeInTheDocument()
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent)
    expect(heads).toEqual(expect.arrayContaining(["Rank", "Faculty", "Department", "Cumulative SNIP", "Incentive paid", "Papers settled"]))
    const asha = within(table).getByText("Asha Quiet").closest("tr")!
    expect(within(asha).getByText("12.50")).toBeInTheDocument()
    expect(within(asha).getByText("₹12,34,567")).toBeInTheDocument()
    expect(within(asha).getByText("31")).toBeInTheDocument()
    // Somebody with nothing is listed, and is not ranked.
    expect(within(within(table).getByText("Nobody Yet").closest("tr")!).getByText("Not ranked")).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1, name: "Standings" })).toBeInTheDocument()
  })

  it("has the vertical period strip, and asks again for a month, a year and a search", async () => {
    mount(FINANCE, FULL)
    await screen.findByRole("table")
    expect(screen.getByRole("tablist", { name: "Period" })).toHaveAttribute("aria-orientation", "vertical")
    fireEvent.click(screen.getByRole("tab", { name: "Monthly" }))
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("/api/dashboard/standings?period=month&sort=snip&dir=desc"))
    )
    fireEvent.change(await screen.findByLabelText("Month"), { target: { value: "2026-08" } })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("period=month&month=2026-08")))
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "ravi" } })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("&q=ravi")))
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "Chemistry" } })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("&department=Chemistry")))
  })

  it("sorts on the server by the heading chosen", async () => {
    mount(FINANCE, FULL)
    await screen.findByRole("table")
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: /Incentive paid/ }))
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("sort=remuneration&dir=desc")))
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: /Incentive paid/ }))
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("sort=remuneration&dir=asc")))
  })

  it("has table tools with an export", async () => {
    mount(FINANCE, FULL)
    await screen.findByRole("table")
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument()
  })

  it("opens how a person's numbers are counted, and the three sums are the sums of the columns", async () => {
    mount(FINANCE, FULL)
    fireEvent.click(await screen.findByRole("button", { name: "How Asha Quiet's numbers are counted" }))
    const panel = await screen.findByRole("dialog")
    expect(within(panel).getByText("How this is counted")).toBeInTheDocument()
    expect(await within(panel).findByText("Deep Nets")).toBeInTheDocument()
    expect(within(panel).getByTestId("standing-rules")).toHaveTextContent("counted once")
    // Where each SNIP came from, the repeat, and the count-only paper.
    expect(within(panel).getByText("From the settled sheet")).toBeInTheDocument()
    expect(within(panel).getByText("From the claim")).toBeInTheDocument()
    expect(within(panel).getByText("Counted once, repeats an earlier row")).toBeInTheDocument()
    expect(within(panel).getByText("Counted, nothing paid")).toBeInTheDocument()
    expect(within(panel).getByText(/Voided one/)).toBeInTheDocument()
    // The sums at the foot.
    const sums = within(panel).getByTestId("standing-sums")
    expect(within(sums).getByText("2")).toBeInTheDocument()
    expect(within(sums).getByText("3.25")).toBeInTheDocument()
    expect(within(sums).getByText("₹1,500")).toBeInTheDocument()
    // The sums are what you get by adding the columns of the rows.
    const shownSnip = PAPERS.papers.reduce((a, p) => a + p.snip, 0)
    const shownAmount = PAPERS.papers.reduce((a, p) => a + (p.amount ?? 0), 0)
    const shownCount = PAPERS.papers.filter((p) => p.counted).length
    expect([shownSnip, shownAmount, shownCount]).toEqual([PAPERS.totals.snip, PAPERS.totals.remuneration, PAPERS.totals.count])
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/dashboard/standings/id-1/papers?period=all")
  })

  it("opens a person from a link, in the period the link names", async () => {
    mount(FINANCE, FULL, {}, "/standings?person=id-1&period=year&year=2025&academic=false")
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/dashboard/standings/id-1/papers?period=year&year=2025&academic=false")
    )
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("is the head's view: no incentive column, no incentive figure, no incentive in the panel", async () => {
    const blind: StandingsPayload = {
      ...FULL,
      scope: "department",
      money: false,
      totals: { snip: 25.5, count: 40 },
      rows: FULL.rows.map(({ remuneration: _a, rank_remuneration: _b, ...rest }) => rest),
    }
    const papers: PapersPayload = {
      ...PAPERS,
      money: false,
      totals: { snip: 3.25, count: 2 },
      voided: undefined,
      papers: PAPERS.papers.map(({ amount: _a, counted_in: _b, ...rest }) => rest),
    }
    mount(HOD, blind, { "/api/dashboard/standings/": () => papers })
    await screen.findByRole("table")
    const figures = screen.getByTestId("standings-figures")
    expect(within(figures).queryByText(/Incentive/)).toBeNull()
    expect(screen.queryByText("Incentive paid")).toBeNull()
    expect(screen.queryByLabelText("Department")).toBeNull()
    fireEvent.click(await screen.findByRole("button", { name: "How Asha Quiet's numbers are counted" }))
    const panel = await screen.findByRole("dialog")
    await within(panel).findByText("Deep Nets")
    expect(within(panel).queryByText(/Incentive/)).toBeNull()
    expect(within(panel).queryByText("Amount")).toBeNull()
    expect(within(panel).queryByText(/nothing paid/)).toBeNull()
    expect(within(panel).queryByText(/Voided/)).toBeNull()
    expect(within(panel).getAllByText("3.25").length).toBeGreaterThan(0)
  })

  it("is My standing for a faculty member: their own row, their place, no search", async () => {
    const mine: StandingsPayload = {
      ...FULL,
      scope: "self",
      total: 1,
      totals: { snip: 12.5, remuneration: 1234567, count: 31 },
      rows: [{ ...FULL.rows[0], rank_snip: 2, rank_remuneration: 1, rank_count: 3 }],
    }
    mount(FACULTY, mine)
    expect(await screen.findByRole("heading", { level: 1, name: "My standing" })).toBeInTheDocument()
    expect(await screen.findByTestId("standings-mine")).toHaveTextContent(
      "2nd for cumulative SNIP, 1st for incentive paid, 3rd for papers settled"
    )
    expect(screen.queryByLabelText("Search")).toBeNull()
    expect(screen.queryByLabelText("Department")).toBeNull()
    expect(screen.getAllByRole("row")).toHaveLength(2) // the heading and their own row
  })

  it("reports a failure rather than an empty table", async () => {
    mount(FINANCE, () => {
      throw new Error("down")
    })
    expect(await screen.findByText(/Could not load the standings/)).toBeInTheDocument()
  })

  it("keeps the period strip on a phone as a segmented control", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    mount(FINANCE, FULL)
    await screen.findByRole("table")
    const strip = screen.getByRole("tablist", { name: "Period" })
    expect(strip).toHaveAttribute("data-variant", "segmented")
    expect(strip).toHaveAttribute("aria-orientation", "horizontal")
  })
})
