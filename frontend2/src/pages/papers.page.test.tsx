import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { answerSentence, Papers, rolePhrase, type RecordPaper } from "@/pages/papers"
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
  paper("gone", { title: "RETRACTED: A withdrawn study", eligible: false, ineligible_reason: "Retracted" }),
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
  it("opens with the answer in a sentence: what to file, what is with the college, what is paid", async () => {
    mount()
    expect(
      await screen.findByText("8 papers on your record. 2 papers are ready to file, 1 is with the college, 3 have been paid.")
    ).toBeTruthy()
    // The statement and the forms are buttons one press away, not four figures.
    expect(await screen.findByRole("link", { name: "Payment statement" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "List for appraisal" }).getAttribute("href")).toBe("/papers/appraisal")
  })

  it("says a zero as what it means, never as a bare count", () => {
    const none = { all: 0, unclaimed: 0, progress: 0, paid: 0, ineligible: 0 }
    expect(answerSentence(0, none)).toBe("0 papers on your record.")
    expect(answerSentence(1, { ...none, all: 1, unclaimed: 1 })).toBe("1 paper on your record. 1 paper is ready to file.")
  })

  it("counts the tabs from the same rows as the sentence", async () => {
    mount()
    const state = await screen.findByRole("tablist", { name: "Claim state" })
    expect(within(state).getByRole("tab", { name: /^All\s*8$/ })).toBeTruthy()
    expect(within(state).getByRole("tab", { name: /^Ready to file\s*2$/ })).toBeTruthy()
    expect(within(state).getByRole("tab", { name: /^With the college\s*1$/ })).toBeTruthy()
    expect(within(state).getByRole("tab", { name: /^Paid\s*3$/ })).toBeTruthy()
    expect(within(state).getByRole("tab", { name: /^Not eligible\s*2$/ })).toBeTruthy()
  })

  it("puts one 'File it' on each unclaimed paper and names the state of the rest", async () => {
    mount()
    await screen.findByText("Title open-1")
    expect(screen.getAllByRole("link", { name: "File it" })).toHaveLength(2)
    expect(screen.getByText(/^Being checked/).textContent).toBe("Being checked, 12 days")
    expect(screen.getByText("Paid Mar 2026")).toBeTruthy()
    expect(screen.getByText("₹1,600 to you")).toBeTruthy()
    expect(screen.getByText(/Not eligible: 14 authors, and the scheme pays up to 10/)).toBeTruthy()
    expect(screen.getByText("Not eligible: the title says this paper was retracted.")).toBeTruthy()
  })

  it("folds the same paper listed twice under one row with a version count", async () => {
    mount()
    await screen.findByText("Title open-1")
    expect(screen.queryByText("Listed twice")).toBeNull()
    const toggle = screen.getByRole("button", { name: "2 versions" })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("Another version")).toBeNull()
    await userEvent.click(toggle)
    expect(screen.getByRole("button", { name: "2 versions" }).getAttribute("aria-expanded")).toBe("true")
    expect(screen.getAllByText("Another version")).toHaveLength(1)
  })

  it("folds two versions whose titles differ by a typo into one row", async () => {
    const t1 =
      "An Experimental Research on Two-Fold Text: To Transform Sustainable Education for First-Year Engineering Graduates in India"
    const t2 = t1.toUpperCase().replace("GRADUATES", "GRADUTES")
    mount("/papers", [paper("n1", { title: t1 }), paper("n2", { title: t2 })])
    expect(await screen.findByRole("button", { name: "2 versions" })).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /versions$/ })).toHaveLength(1)
    expect(screen.queryByText("Another version")).toBeNull()
  })

  it("shows three versions of one title as one row, and reveals the two others on click", async () => {
    const three = [
      paper("v1", { title: "Same study of things", year: 2024, venue: null }),
      paper("v2", { title: "Same study of things.", claim: { id: "c7", stage: "Under review", days_waiting: 12 } }),
      paper("v3", { title: "same STUDY of things" }),
    ]
    mount("/papers", three)
    await screen.findByRole("button", { name: "3 versions" })
    expect(screen.getAllByText("Same study of things", { exact: false })).toHaveLength(1)
    expect(screen.queryByText("Another version")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "3 versions" }))
    expect(screen.getAllByText("Another version")).toHaveLength(2)
  })

  it("leads with the version whose claim is in progress", async () => {
    const three = [
      paper("v1", { title: "Same study of things", claim: { id: "c1", stage: "Paid", days_waiting: null, amount: 1600, paid_month: "2026-03" } }),
      paper("v2", { title: "Same study of things.", claim: { id: "c2", stage: "Under review", days_waiting: 4 } }),
      paper("v3", { title: "same STUDY of things" }),
    ]
    mount("/papers", three)
    await screen.findByRole("button", { name: "3 versions" })
    expect(screen.getByText(/^Being checked/).textContent).toBe("Being checked, 4 days")
    expect(screen.queryByText("Paid Mar 2026")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "3 versions" }))
    expect(screen.getByText("Paid Mar 2026")).toBeTruthy()
  })

  it("never names the desk holding a claim", async () => {
    mount()
    await screen.findByText("Title open-1")
    expect(document.body.textContent).not.toMatch(/research office|principal|director|finance|clearing/i)
  })

  it("says sole author once, not 'first author of 1'", () => {
    expect(rolePhrase(paper("s", { total_authors: 1 }))).toBe("Sole author")
    expect(rolePhrase(paper("f"))).toBe("First author")
    expect(rolePhrase(paper("c", { author_position: 2, total_authors: 4 }))).toBe("Author 2 of 4")
  })
})
