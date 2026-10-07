import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api, ApiError } from "@/lib/api"
import { Events } from "@/pages/events"
import type { Highlights } from "@/pages/events-model"
import { NOTHING_NEW, highlights, listing, paper } from "@/test/events-fixtures"
import { FACULTY, renderWithProviders } from "@/test/harness"

/**
 * The research half. It has to be worth opening on a month with little in it,
 * so a section with nothing to show is not drawn at all, and a period with
 * nothing in any of them says so kindly and points somewhere useful.
 */

function mount(data: Highlights | "fail" = highlights(), route = "/events?view=research") {
  const asked: string[] = []
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === "/api/auth/me") return FACULTY
    if (path.startsWith("/api/research/highlights")) {
      asked.push(path)
      if (data === "fail") throw new ApiError(500, "The server did not answer")
      return data
    }
    if (path.startsWith("/api/events")) return listing([])
    throw new ApiError(404, `No handler in this test for ${path}`)
  }) as unknown as typeof api)
  renderWithProviders(<Events />, { route })
  return { asked }
}

describe("Research showcase", () => {
  it("opens on the past three months and says what the college did in them", async () => {
    const { asked } = mount()
    expect(await screen.findByText("28 new papers in the past 3 months, 3 of them in Q1 journals, by 30 colleagues.")).toBeInTheDocument()
    expect(asked[0]).toContain("period=quarter")
    expect(screen.getByRole("radio", { name: "Past 3 months" })).toBeChecked()
  })

  it("draws each part as a heading over its papers", async () => {
    mount()
    for (const title of ["New in Q1 journals", "First papers in a journal", "Most cited lately", "New names"]) {
      expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument()
    }
    const q1 = screen.getByRole("region", { name: "New in Q1 journals" })
    expect(within(q1).getAllByRole("article")).toHaveLength(2)
  })

  it("hides a part that has nothing in it, rather than drawing an empty box", async () => {
    mount(highlights({ new_names: [], first_papers: [], counts: { q1: 2, first_papers: 0, most_cited: 1, new_names: 0 } }))
    await screen.findByRole("heading", { name: "New in Q1 journals" })
    expect(screen.queryByRole("heading", { name: "New names" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "First papers in a journal" })).toBeNull()
    expect(screen.getByRole("heading", { name: "Most cited lately" })).toBeInTheDocument()
  })

  it("shows a paper with where it came out, its Q1 mark, its date, its authors and why it is here", async () => {
    mount()
    const q1 = await screen.findByRole("region", { name: "New in Q1 journals" })
    const first = within(q1).getByRole("article", { name: "Quantum sensing at the edge" })
    expect(within(first).getByRole("button", { name: "Quantum sensing at the edge" })).toBeInTheDocument() // opens the paper
    expect(within(first).getByRole("button", { name: "Quantum Letters" })).toBeInTheDocument() // opens the journal
    expect(first).toHaveTextContent("Q1")
    expect(first).toHaveTextContent("30 Sep 2026")
    expect(within(first).getByRole("button", { name: /Asha Menon/ })).toBeInTheDocument() // opens the person
    expect(first).toHaveTextContent("First Q1 paper for Asha Menon")
    const radar = within(q1).getByRole("article", { name: "Sparse filters for radar" })
    expect(within(radar).getByRole("button", { name: /Ravi Kumar/ })).toBeInTheDocument()
    expect(within(radar).getByRole("button", { name: /Meera Pillai/ })).toBeInTheDocument()
  })

  it("says what the citation count is and is not, on the most cited", async () => {
    mount()
    const cited = await screen.findByRole("region", { name: "Most cited lately" })
    expect(cited).toHaveTextContent("Cited 12 times since it came out in Jun 2026")
    expect(cited).toHaveTextContent("Papers from the last 12 months")
  })

  it("lists the departments with a bar for each and the number behind it", async () => {
    mount()
    const list = await screen.findByRole("list", { name: "By department" })
    const ece = within(list).getByRole("listitem", { name: /ECE/ })
    expect(ece).toHaveTextContent("20")
    expect(ece).toHaveAccessibleName("ECE: 20 papers, 3 in Q1 journals")
    expect(within(list).getAllByRole("listitem")).toHaveLength(2)
  })

  it("changes the stretch of time, and asks the server for it", async () => {
    const user = userEvent.setup()
    const { asked } = mount()
    await screen.findByRole("heading", { name: "New in Q1 journals" })
    await user.click(screen.getByRole("radio", { name: "Past month" }))
    await waitFor(() => expect(asked.some((p) => p.includes("period=month"))).toBe(true))
    await user.click(screen.getByRole("radio", { name: "Past year" }))
    await waitFor(() => expect(asked.some((p) => p.includes("period=year"))).toBe(true))
  })

  it("narrows to a department", async () => {
    const user = userEvent.setup()
    const { asked } = mount()
    await screen.findByRole("heading", { name: "New in Q1 journals" })
    await user.selectOptions(screen.getByLabelText("Department"), "ECE")
    await waitFor(() => expect(asked.some((p) => p.includes("department=ECE"))).toBe(true))
  })

  it("starts from the period in the address, so Home can link to a month", async () => {
    const { asked } = mount(highlights({ period: "month", label: "Past month" }), "/events?view=research&period=month")
    await screen.findByText(/new papers in the past month/)
    expect(asked[0]).toContain("period=month")
    expect(screen.getByRole("radio", { name: "Past month" })).toBeChecked()
  })

  it("says kindly that nothing is new, and points to Discover, when every part is empty", async () => {
    mount(NOTHING_NEW)
    expect(await screen.findByText("Nothing new in the past 3 months")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Look at Discover" })).toHaveAttribute("href", "/discover")
    expect(screen.queryByRole("heading", { name: "New in Q1 journals" })).toBeNull()
    expect(screen.getByRole("button", { name: "Try the past year" })).toBeInTheDocument()
  })

  it("says it could not load, and does not say nothing is new, when the server did not answer", async () => {
    mount("fail")
    expect(await screen.findByText("Could not load the research showcase")).toBeInTheDocument()
    expect(screen.queryByText(/Nothing new/)).toBeNull()
  })

  it("carries no money, whatever else it shows", async () => {
    mount(highlights({ most_cited: [paper({ id: "p-9", citations: 40, reason: "Cited 40 times since it came out in May 2026" })] }))
    await screen.findByRole("heading", { name: "Most cited lately" })
    expect(document.body.textContent).not.toMatch(/₹|rupee|incentive|remuneration/i)
  })
})
