import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Top5Board, type Top5Payload, type Top5Row } from "@/pages/top5-board"
import { FACULTY, FINANCE, HOD, failing, fakeApi, renderWithProviders, type ApiHandler, type ApiTable } from "@/test/harness"
import type { Me } from "@/app/auth"

const PRINCIPAL: Me = { id: "u-principal", email: "p@example.edu", name: "The Principal", role: "PRINCIPAL", department: null }

const row = (rank: number, name: string, value: number, over: Partial<Top5Row> = {}): Top5Row => ({
  rank,
  user_id: `id-${rank}`,
  staff_id: `S${rank}`,
  name,
  department: "Physics",
  photo: null,
  photo_url: null,
  initials: name.slice(0, 2).toUpperCase(),
  value,
  ...over,
})

const FULL: Top5Payload = {
  period: "all",
  label: "All time",
  department: null,
  generated_at: "2026-11-17T09:00:00Z",
  snip: [row(1, "Asha Quiet", 12.5), row(2, "Ravi Steady", 9.256)],
  remuneration: [row(1, "Ravi Steady", 1234567), row(2, "Asha Quiet", 54000)],
  count: [row(1, "Asha Quiet", 31), row(2, "Ravi Steady", 4, { user_id: null, staff_id: "TSXX1" })],
}

function mount(me: Me, payload: Top5Payload | ApiHandler, extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/dashboard/top5": (path) => (typeof payload === "function" ? payload(path) : { ...payload, asked: path }),
      "/api/meta/departments": () => ["Physics", "Chemistry"],
      ...extra,
    })
  )
  renderWithProviders(<Top5Board />)
}

describe("Top5Board", () => {
  it("draws three ranked lists with the figures in the college's formats", async () => {
    mount(PRINCIPAL, FULL)
    const snip = await screen.findByTestId("top5-snip")
    expect(within(snip).getByRole("heading", { name: "Cumulative SNIP" })).toBeInTheDocument()
    expect(within(snip).getByText("12.50")).toBeInTheDocument()
    expect(within(snip).getByText("9.26")).toBeInTheDocument()

    const pay = screen.getByTestId("top5-remuneration")
    expect(within(pay).getByRole("heading", { name: "Incentive paid" })).toBeInTheDocument()
    expect(within(pay).getByText("₹12,34,567")).toBeInTheDocument()
    expect(within(pay).getByText("₹54,000")).toBeInTheDocument()

    const count = screen.getByTestId("top5-count")
    expect(within(count).getByText("31")).toBeInTheDocument()
  })

  it("links a name to the person, keeps an unmatched staff id as plain text, and shows the department", async () => {
    mount(PRINCIPAL, FULL)
    const count = await screen.findByTestId("top5-count")
    expect(within(count).getByRole("link", { name: "Asha Quiet" })).toHaveAttribute("href", "/u/id-1")
    expect(within(count).queryByRole("link", { name: "Ravi Steady" })).toBeNull()
    expect(within(count).getByText("Ravi Steady")).toBeInTheDocument()
    expect(within(count).getAllByText("Physics").length).toBeGreaterThan(0)
  })

  it("puts table tools on each list", async () => {
    mount(PRINCIPAL, FULL)
    const lists = await Promise.all(["snip", "remuneration", "count"].map((k) => screen.findByTestId(`top5-${k}`)))
    for (const list of lists) expect(within(list).getByRole("button", { name: /export/i })).toBeInTheDocument()
  })

  it("asks again when the period or the department changes", async () => {
    mount(PRINCIPAL, FULL)
    await screen.findByTestId("top5-snip")
    await screen.findByRole("option", { name: "Chemistry" })
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "month" } })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("/api/dashboard/top5?period=month"))
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "Chemistry" } })
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/dashboard/top5?period=month&department=Chemistry")
    )
  })

  it("offers the three periods", async () => {
    mount(FINANCE, FULL)
    await screen.findByTestId("top5-snip")
    const period = screen.getByLabelText("Period")
    expect(within(period).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "All time",
      "This academic year",
      "This month",
    ])
  })

  it("is the head's view: two lists, no incentive list and no department filter", async () => {
    mount(HOD, { ...FULL, department: "Physics", remuneration: null })
    await screen.findByTestId("top5-snip")
    expect(screen.getByTestId("top5-count")).toBeInTheDocument()
    expect(screen.queryByTestId("top5-remuneration")).toBeNull()
    expect(screen.queryByText("Incentive paid")).toBeNull()
    expect(screen.queryByLabelText("Department")).toBeNull()
    expect(screen.getByLabelText("Period")).toBeInTheDocument()
    expect(vi.mocked(api)).not.toHaveBeenCalledWith("/api/meta/departments")
  })

  it("says so when nothing has been settled in the period", async () => {
    mount(PRINCIPAL, { ...FULL, snip: [], remuneration: [], count: [] })
    expect(await screen.findByText("Nothing settled in this period")).toBeInTheDocument()
    expect(screen.queryByTestId("top5-snip")).toBeNull()
  })

  it("keeps the other lists when only one is empty", async () => {
    mount(PRINCIPAL, { ...FULL, snip: [] })
    const snip = await screen.findByTestId("top5-snip")
    expect(within(snip).getByText("Nothing settled in this period.")).toBeInTheDocument()
    expect(within(screen.getByTestId("top5-count")).getByText("31")).toBeInTheDocument()
  })

  it("reports a failed request rather than an empty list", async () => {
    mount(PRINCIPAL, failing(500))
    expect(await screen.findByText(/Could not load the Top 5/)).toBeInTheDocument()
    expect(screen.queryByText("Nothing settled in this period")).toBeNull()
  })

  it("draws nothing, and asks for nothing, for a faculty member", async () => {
    mount(FACULTY, FULL)
    await screen.findByTestId("top5-board", {}, { timeout: 300 }).catch(() => null)
    expect(screen.queryByTestId("top5-board")).toBeNull()
    expect(vi.mocked(api)).not.toHaveBeenCalledWith(expect.stringContaining("/api/dashboard/top5"))
  })
})
