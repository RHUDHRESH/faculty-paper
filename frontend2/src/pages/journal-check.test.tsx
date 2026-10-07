import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { JournalCheckPage, JournalVerdictInline, type JournalCheck } from "@/pages/journal-check"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

const SAFE: JournalCheck = {
  query: "solar energy",
  kind: "name",
  domain: null,
  data_latest_year: 2025,
  matches: [
    { id: "j1", name: "Solar Energy", issns: ["0038-092X"], quartile: "Q1", latest_year_in_data: 2025 },
    { id: "j2", name: "Solar Energy Materials", issns: ["0927-0248"], quartile: "Q1", latest_year_in_data: 2025 },
  ],
  journal: {
    id: "j1", name: "Solar Energy", issns: ["0038-092X"], publisher: "Elsevier", quartile: "Q1",
    subject: "Renewable Energy", sjr: 1.6, snip: 1.7, categories: [], latest_year_in_data: 2025,
  },
  checks: [
    { key: "listed", status: "ok", title: "In our Scopus/Scimago list", detail: "Listed in the Scimago data for 2025." },
    { key: "discontinued", status: "unknown", title: "Discontinued list", detail: "Unknown: the discontinued list has not been loaded yet." },
  ],
  verdict: { level: "safe", text: "Looks safe: Q1, in Scopus, the college has 12 papers here." },
  college: {
    papers: 12, colleagues: [{ id: "u2", name: "Dr Ravi" }], colleague_count: 1, mine: [],
    claims: { total: 3, in_review: 0, cleared: 1, paid: 2, sent_back: 0 },
  },
  estimate: {
    assumes: "A Scopus journal article with 3 authors.",
    positions: [
      { position: 1, amount: 50000, why_not: null },
      { position: 2, amount: 30000, why_not: null },
      { position: 3, amount: 20000, why_not: null },
    ],
  },
}

function mount(handler: (path: string) => unknown) {
  vi.mocked(api).mockImplementation(
    fakeApi({ "/api/auth/me": () => FACULTY, "/api/follows": () => ({ people: [], departments: [], topics: [], journals: [] }), "/api/journals/check": handler }) as typeof api
  )
}

describe("Check a journal", () => {
  it("searches and shows the verdict, checks, colleagues and estimate", async () => {
    const seen: string[] = []
    mount((p) => (seen.push(p), SAFE))
    renderWithProviders(<JournalCheckPage />, { route: "/journal-check" })
    await userEvent.type(screen.getByLabelText("Journal name, ISSN or website"), "solar energy")
    await userEvent.click(screen.getByRole("button", { name: "Check" }))
    expect(await screen.findByTestId("verdict")).toHaveTextContent("Looks safe: Q1")
    const checks = screen.getByRole("list", { name: "Checks" })
    expect(within(checks).getByText(/has not been loaded yet/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Dr Ravi" })).toHaveAttribute("href", "/u/u2")
    expect(screen.getByText("First author")).toBeInTheDocument()
    expect(seen[0]).toContain("q=solar%20energy")
  })

  it("offers a pick list when several journals match", async () => {
    const seen: string[] = []
    mount((p) => (seen.push(p), SAFE))
    renderWithProviders(<JournalCheckPage />, { route: "/journal-check?q=solar" })
    const picks = await screen.findByRole("list", { name: "Matching journals" })
    await userEvent.click(within(picks).getByRole("button", { name: /Solar Energy Materials/ }))
    await waitFor(() => expect(seen.some((p) => p.includes("pick=j2"))).toBe(true))
  })

  it("shows a warning verdict inline while filing", async () => {
    mount(() => ({ ...SAFE, verdict: { level: "caution", text: "Think twice: no longer listed." } }))
    renderWithProviders(<JournalVerdictInline journal="Lapsed Letters" issn="" />)
    const line = await screen.findByTestId("inline-verdict", {}, { timeout: 2000 })
    expect(line).toHaveTextContent("Think twice: no longer listed.")
    expect(within(line).getByRole("link", { name: "See the full check" })).toHaveAttribute(
      "href", "/journal-check?q=Lapsed%20Letters"
    )
  })
})
