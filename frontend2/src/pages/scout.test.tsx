import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Scout } from "@/pages/scout"
import { fakeApi, renderWithProviders } from "@/test/harness"

const DONE = {
  status: "done",
  id: "r1",
  runs_left: 4,
  limit: 5,
  result: {
    profile: { name: "A", department: "IT", papers: 9, citations: 40, h_index: 3, topics: ["Edge"] },
    web: {
      summary: "Take edge AI into federated diagnosis.",
      opportunities: [{ title: "AI for Agriculture topic", kind: "special_issue", why: "fits", deadline: "", url: "https://www.frontiersin.org/x" }],
      directions: [{ title: "Federated edge learning", builds_on: "IoT", why: "next step", urls: [] }],
      external_people: [{ name: "Hossain S.", affiliation: "BRAC University", work: "ViT tumours", url: "" }],
    },
    literature: [],
    colleagues: [{ user_id: "u2", name: "Dr. B", department: "CSE", papers: 7, shared_topics: ["Edge"], their_topics: ["Blockchain"], why: "ledger + edge", picked: true }],
    sources: [{ url: "https://www.frontiersin.org/x", title: "Frontiers" }],
    generated_at: "2026-09-28T10:00:00Z",
  },
}

describe("Research scout", () => {
  it("shows web findings and our-record colleagues, labelled apart, with no money", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/scout": () => DONE }))
    renderWithProviders(<Scout />, { route: "/scout" })
    expect(await screen.findByText("AI for Agriculture topic")).toBeInTheDocument()
    expect(screen.getByText("Dr. B")).toBeInTheDocument()
    expect(screen.getAllByText("From the web").length).toBeGreaterThan(0)
    expect(screen.getByText("From our records")).toBeInTheDocument()
    expect(screen.getByText(/frontiersin.org/, { selector: "a" })).toBeInTheDocument()
    expect(screen.getAllByText(/No link found/).length).toBe(1)
    expect(document.body.textContent).not.toMatch(/₹|\$|cost|token/i)
  })

  it("offers a first run when there is none, and says what the scout will do", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/scout": () => ({ status: "none", runs_left: 5, limit: 5 }) }))
    renderWithProviders(<Scout />, { route: "/scout" })
    expect(await screen.findByRole("button", { name: /Scout for me/ })).toBeEnabled()
    expect(screen.getAllByRole("button", { name: /Scout for me/ })).toHaveLength(1)
    expect(screen.getByText(/reads your papers, then searches the web/)).toBeInTheDocument()
    expect(screen.getByText("5 of 5 runs left today. Results are kept for 24 hours.")).toBeInTheDocument()
  })

  it("tells a reader who has used every run why the button is off", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/scout": () => ({ status: "none", runs_left: 0, limit: 5 }) }))
    renderWithProviders(<Scout />, { route: "/scout" })
    expect(await screen.findByRole("button", { name: /Scout for me/ })).toBeDisabled()
    expect(screen.getByText(/You have used today's runs/)).toBeInTheDocument()
  })

  it("opens with what was found, and each colleague can be messaged", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/scout": () => DONE }))
    renderWithProviders(<Scout />, { route: "/scout" })
    const glance = await screen.findByRole("group", { name: "At a glance" })
    expect(glance).toHaveTextContent(/1\s*Open call/)
    expect(glance).toHaveTextContent(/1\s*Colleague to write with/)
    expect(screen.getByRole("link", { name: "Message Dr. B" })).toHaveAttribute("href", "/messages?to=u2")
  })
})

import { sentenceEnd } from "@/pages/scout"

describe("sentenceEnd", () => {
  it("does not end the lead at a title or an initial", () => {
    const s = "Mr. S. Joyal Isac's work in microgrids can grow. Next comes federated learning."
    expect(s.slice(0, sentenceEnd(s))).toBe("Mr. S. Joyal Isac's work in microgrids can grow.")
  })
  it("returns -1 for one sentence", () => {
    expect(sentenceEnd("Just one sentence here.")).toBe(-1)
  })
})
