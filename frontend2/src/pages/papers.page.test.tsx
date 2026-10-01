import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Papers, rolePhrase, type RecordPaper } from "@/pages/papers"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

const paper = (id: string, over: Partial<RecordPaper> = {}): RecordPaper => ({
  id, title: `Title ${id}`, year: 2025, date: null, venue: "A Venue", type: "article", quartile: null, doi: null,
  eid: null, openalex_id: null, citations: 0, source: "openalex", author_position: 1, total_authors: 3,
  match_confidence: null,
  authors: [
    { name: "Dr Me", position: 1, user_id: FACULTY.id, is_college: true, institution: null },
    { name: "Ravi K", position: 2, user_id: "u-ravi", is_college: true, institution: null, photo_url: null },
    { name: "Someone Far", position: 3, user_id: null, is_college: false, institution: "Elsewhere" },
  ],
  claim: null, eligible: true, ineligible_reason: null, ...over,
})

const RECORD: RecordPaper[] = [
  paper("open-1"),
  paper("open-2"),
  paper("moving", { claim: { id: "c1", stage: "Under review", days_waiting: 12 } }),
  paper("done", { claim: { id: "c2", stage: "Paid", days_waiting: null, amount: 1600, paid_month: "2026-03" } }),
  paper("many", { eligible: false, ineligible_reason: "More than 10 authors", total_authors: 14 }),
  // The same paper listed twice (two uploads of one title).
  paper("z1", { title: "A ZIGBEE Security System", claim: { id: null, stage: "Paid", days_waiting: null } }),
  paper("z2", { title: "A zigbee security system!", claim: { id: null, stage: "Paid", days_waiting: null } }),
]

function mount(route = "/papers", publications = RECORD) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/me/publications": () => ({
        user: { id: FACULTY.id, name: FACULTY.name },
        metrics: { total_publications: publications.length, total_citations: 9, first_year: 2020 },
        count: publications.length,
        unclaimed: 2,
        publications,
      }),
      "/api/me/payments": () => ({ total: 396703.75, count: 89, rows: [] }),
      "/api/me/research-threshold": () => ({ research: false }),
    })
  )
  renderWithProviders(<Papers />, { route })
}

describe("My papers", () => {
  it("opens with the answer: what to claim, what is moving, what is paid, what was received", async () => {
    mount()
    const glance = await screen.findByRole("group", { name: "At a glance" })
    expect(within(glance).getByText("papers ready to claim").previousSibling?.textContent).toBe("2")
    expect(within(glance).getByText("with the college").previousSibling?.textContent).toBe("1")
    expect(within(glance).getByText("paid").previousSibling?.textContent).toBe("3")
    expect(await within(glance).findByText("₹3,96,703.75")).toBeTruthy()
    // Each figure is a link to the list behind it.
    expect(within(glance).getByRole("link", { name: /papers ready to claim/ }).getAttribute("href")).toBe("/papers?tab=unclaimed")
  })

  it("counts the tabs from the same rows as the figures", async () => {
    mount()
    const state = await screen.findByRole("group", { name: "Claim state" })
    expect(within(state).getByRole("button", { name: /^All\s*7$/ })).toBeTruthy()
    expect(within(state).getByRole("button", { name: /^Not claimed\s*2$/ })).toBeTruthy()
    expect(within(state).getByRole("button", { name: /^In progress\s*1$/ })).toBeTruthy()
    expect(within(state).getByRole("button", { name: /^Paid\s*3$/ })).toBeTruthy()
    expect(within(state).getByRole("button", { name: /^Not eligible\s*1$/ })).toBeTruthy()
  })

  it("puts one 'File it' on each unclaimed paper and names the state of the rest", async () => {
    mount()
    await screen.findByText("Title open-1")
    expect(screen.getAllByRole("link", { name: "File it" })).toHaveLength(2)
    expect(screen.getByText("Under review, 12 days")).toBeTruthy()
    expect(screen.getByText("Paid Mar 2026")).toBeTruthy()
    expect(screen.getByText("₹1,600 to you")).toBeTruthy()
    expect(screen.getByText(/Not eligible: 14 authors, and the scheme pays up to 10/)).toBeTruthy()
  })

  it("flags the same paper listed twice and offers to report it", async () => {
    mount()
    await screen.findByText("Title open-1")
    expect(screen.getAllByText("Listed twice")).toHaveLength(2)
  })

  it("never names the desk holding a claim", async () => {
    mount()
    await screen.findByText("Title open-1")
    expect(document.body.textContent).not.toMatch(/research cell|principal|director|finance|clearing/i)
  })

  it("says sole author once, not 'first author of 1'", () => {
    expect(rolePhrase(paper("s", { total_authors: 1 }))).toBe("Sole author")
    expect(rolePhrase(paper("f"))).toBe("First author")
    expect(rolePhrase(paper("c", { author_position: 2, total_authors: 4 }))).toBe("Author 2 of 4")
  })
})
