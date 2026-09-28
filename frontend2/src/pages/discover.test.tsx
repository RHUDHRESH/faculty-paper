import { fireEvent, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Discover } from "@/pages/discover"
import { FACULTY, failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * Discover on a server with no AI configured — the free deployment's normal
 * state — must still be useful and must not look broken: the counted
 * suggestions lead, and the AI parts are one quiet line, not an error box,
 * a daemon to start or a button that can only fail.
 */

const NOT_SET_UP = {
  available: false,
  model: "",
  provider: "none",
  code: "not_configured",
  detail: "AI suggestions are not set up on this server.",
  hosted: false,
  host: "",
}

const HOSTED = {
  available: true,
  model: "llama-3.3-70b-versatile",
  provider: "openai",
  code: "ready",
  detail: null,
  hosted: true,
  host: "api.groq.com",
}

const NEXT = {
  people: [
    {
      id: "u-ravi",
      name: "Dr Ravi Kumar",
      department: "CSE",
      designation: "Professor",
      papers: 4,
      shared_areas: ["Computer Vision and Pattern Recognition"],
      shared_journals: ["Neural Letters"],
      cross_department: true,
      reasons: ["Publishes in Neural Letters, as you do.", "In CSE, not your department."],
      score: 12,
    },
  ],
  journals: [
    {
      title: "Pattern Recognition",
      quartile: "Q1",
      colleagues: 3,
      areas: ["Artificial Intelligence"],
      reason: "Q1 in Artificial Intelligence. 3 colleagues here published in it since 2024; you have not yet.",
      score: 14,
    },
  ],
  topics: [
    {
      area: "Signal Processing",
      alongside: 5,
      next_to: "Artificial Intelligence",
      people: 7,
      q1: 1,
      reason: "Appears alongside Artificial Intelligence on 5 papers here since 2024, and 7 colleagues publish in it. You have not yet.",
      score: 18,
    },
  ],
  grounded_on: { papers: 6, areas: ["Artificial Intelligence"], interests: [], since: 2024 },
  why_empty: null,
}

const FEED = {
  items: [
    {
      kind: "direction", id: "topic:speech", title: "Speech assessment", source: "counted",
      why: "You have 3 papers here.",
      payload: { papers: 14, before: 5, growth_pct: 180, topic: "Speech assessment", spark: [1, 2, 3, 5, 9, 14] },
    },
    {
      kind: "venue", id: "venue:pr", title: "Pattern Recognition", source: "counted",
      why: "Q1 in Artificial Intelligence. 3 colleagues here published in it since 2024; you have not yet.",
      payload: { quartile: "Q1", colleagues: 3, areas: ["Artificial Intelligence"] },
    },
    {
      kind: "person", id: "person:u-ravi", title: "Dr Ravi Kumar", source: "counted",
      why: "Publishes in Neural Letters, as you do.",
      payload: { user_id: "u-ravi", department: "CSE", designation: "Professor", affiliation: "Saveetha" },
    },
    {
      kind: "paper", id: "paper:p1", title: "A fresh paper on speech", source: "counted",
      why: "In your topic Speech assessment · by Dr X (CSE)",
      payload: { venue: "J Speech", year: 2026, quartile: null, doi: null },
    },
  ],
  counts: { directions: 1, venues: 1, people: 1, papers: 1 },
  tuned_to: [],
  my_topics: ["Speech assessment"],
  grounded_on: { papers: 6, followed: 0 },
}

function mount(status: unknown, extra: ApiTable = {}, route = "/discover") {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/discover/status": () => status,
      "/api/discover/for-you": () => FEED,
      "/api/discover/next": () => NEXT,
      "/api/discover/directions": () => ({ directions: [], grounded_on: { papers: 0, interests: [] } }),
      "/api/me/interests": () => ({ domains: [] }),
      "/api/meta/research-domains": () => ({ domains: ["Artificial Intelligence"] }),
      ...extra,
    })
  )
  renderWithProviders(<Discover />, { route })
}

function asked(prefix: string): boolean {
  return vi.mocked(api).mock.calls.some((c) => String(c[0]).startsWith(prefix))
}

describe("Discover — the For-you magazine", () => {
  it("mixes directions, venues, people and papers, each with a why and no model label on counted cards", async () => {
    mount(NOT_SET_UP)
    expect(await screen.findByText("This week: 1 direction, 1 fresh paper, 1 person near your work.")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Speech assessment" })).toBeInTheDocument()
    expect(screen.getByText("You have 3 papers here.")).toBeInTheDocument()
    expect(screen.getByText("Pattern Recognition")).toBeInTheDocument()
    expect(screen.getAllByRole("link", { name: /Dr Ravi Kumar/ })[0]).toHaveAttribute("href", "/u/u-ravi")
    expect(screen.getByText("A fresh paper on speech")).toBeInTheDocument()
    expect(screen.queryByText(/Suggested by the model/)).toBeNull()
  })

  it("asks what you work on when it knows nothing yet", async () => {
    mount(NOT_SET_UP, {
      "/api/discover/for-you": () => ({ ...FEED, items: [], my_topics: [], grounded_on: { papers: 0, followed: 0 } }),
    })
    expect(await screen.findByText("Tell us what you work on")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose topics" })).toBeInTheDocument()
  })

  it("keeps a failed load to its own region", async () => {
    mount(NOT_SET_UP, { "/api/discover/for-you": failing(500) })
    expect(await screen.findByText("Couldn't load for you")).toBeInTheDocument()
    expect(screen.getByText("The rest of the page still works.")).toBeInTheDocument()
  })

  it("hides a card marked Not interested", async () => {
    mount(NOT_SET_UP, { "/api/discover/dismiss": () => ({ dismissed: true }) })
    await screen.findByText("A fresh paper on speech")
    fireEvent.pointerDown(screen.getByRole("button", { name: "More about A fresh paper on speech" }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Not interested" }))
    expect(screen.queryByText("A fresh paper on speech")).toBeNull()
    await waitFor(() => expect(asked("/api/discover/dismiss")).toBe(true))
    const call = vi.mocked(api).mock.calls.find((c) => String(c[0]) === "/api/discover/dismiss")
    expect(call?.[1]).toMatchObject({ method: "POST", json: { kind: "paper" } })
  })
})

describe("Discover with no AI set up", () => {
  it("never mentions the model in the main flow, and asks it nothing", async () => {
    mount(NOT_SET_UP)
    await screen.findByText("Pattern Recognition")
    expect(document.body.textContent).not.toMatch(/Could not tell whether suggestions/)
    expect(document.body.textContent?.toLowerCase()).not.toContain("ollama")
    expect(screen.queryByText(/Suggested by the model/)).toBeNull()
    expect(asked("/api/discover/partners")).toBe(false)
    expect(asked("/api/discover/directions")).toBe(false)
  })

  it("says in one line on Venues that the finder needs AI", async () => {
    mount(NOT_SET_UP, {}, "/discover?tab=venues")
    expect(await screen.findByText(/venue finder needs AI/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Find venues/ })).toBeNull()
  })

  it("stays quiet when the status call itself fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mount(failing(500) as unknown, { "/api/discover/status": failing(500) })
    await screen.findByText("Pattern Recognition")
    expect(document.body.textContent).not.toMatch(/switched on/)
    warn.mockRestore()
  })
})

describe("Discover with a hosted model", () => {
  it("says which service answers, instead of promising nothing leaves the building", async () => {
    mount(HOSTED, {}, "/discover?tab=venues")
    expect(
      await screen.findByText(/Suggestions come from llama-3.3-70b-versatile at api\.groq\.com/)
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/running on this server/)
  })

  it("suggests industry partners on request, marked as unchecked", async () => {
    mount(HOSTED, {
      "/api/discover/partners": () => ({
        partners: [
          { name: "Acme Agritech", kind: "company", why: "Builds farm sensors.", first_step: "Write to their lab." },
        ],
        unverified: true,
        grounded_on: { papers: 6, areas: ["Artificial Intelligence"], interests: [] },
        model: "llama-3.3-70b-versatile",
        hosted: true,
      }),
    }, "/discover?tab=people")
    fireEvent.click(await screen.findByRole("button", { name: /Suggest organisations/ }))
    const name = await screen.findByText("Acme Agritech")
    // Read aloud as "Acme Agritech · company", not "Acme Agritechcompany".
    expect(name.textContent).toBe("Acme Agritech · company")
    expect(screen.getByText(/not checked against anything we hold/i)).toBeInTheDocument()
  })
})
