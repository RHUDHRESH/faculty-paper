import { fireEvent, screen, within } from "@testing-library/react"
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

function mount(status: unknown, extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/discover/status": () => status,
      "/api/discover/next": () => NEXT,
      "/api/discover/directions": () => ({ directions: [], grounded_on: { papers: 0, interests: [] } }),
      "/api/me/interests": () => ({ domains: [] }),
      "/api/meta/research-domains": () => ({ domains: ["Artificial Intelligence"] }),
      ...extra,
    })
  )
  renderWithProviders(<Discover />, { route: "/discover" })
}

function asked(prefix: string): boolean {
  return vi.mocked(api).mock.calls.some((c) => String(c[0]).startsWith(prefix))
}

describe("Discover — new things to work on", () => {
  it("leads with people, journals and topics, each with its reason", async () => {
    mount(NOT_SET_UP)
    const people = await screen.findByRole("region", { name: "People to work with" })
    expect(within(people).getByRole("link", { name: /Dr Ravi Kumar/ })).toHaveAttribute("href", "/people/u-ravi")
    expect(within(people).getByText("Publishes in Neural Letters, as you do.")).toBeInTheDocument()
    const journals = screen.getByRole("region", { name: "Journals to aim for" })
    expect(within(journals).getByText("Pattern Recognition")).toBeInTheDocument()
    expect(within(journals).getByText(/3 colleagues here published in it/)).toBeInTheDocument()
    const topics = screen.getByRole("region", { name: "Topics to try" })
    expect(within(topics).getByText("Signal Processing")).toBeInTheDocument()
  })

  it("says why it is empty when we know nothing about the reader yet", async () => {
    mount(NOT_SET_UP, {
      "/api/discover/next": () => ({
        ...NEXT, people: [], journals: [], topics: [],
        why_empty: "We do not know what you work on yet.",
      }),
    })
    expect(await screen.findByText("We do not know what you work on yet.")).toBeInTheDocument()
  })

  it("shows a failed load as a failure", async () => {
    mount(NOT_SET_UP, { "/api/discover/next": failing(500) })
    expect(await screen.findByText("Could not load suggestions")).toBeInTheDocument()
  })
})

describe("Discover with no AI set up", () => {
  it("says so in one line, with no daemon to start and no button that can only fail", async () => {
    mount(NOT_SET_UP)
    await screen.findByRole("region", { name: "People to work with" })
    expect(await screen.findByText(/AI suggestions are not set up on this server/)).toBeInTheDocument()
    expect(document.body.textContent?.toLowerCase()).not.toContain("ollama")
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull()
    expect(screen.queryByRole("button", { name: /Suggest organisations/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Find venues/ })).toBeNull()
    expect(asked("/api/discover/partners")).toBe(false)
    expect(asked("/api/discover/directions")).toBe(false)
  })
})

describe("Discover with a hosted model", () => {
  it("says which service answers, instead of promising nothing leaves the building", async () => {
    mount(HOSTED)
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
    })
    fireEvent.click(await screen.findByRole("button", { name: /Suggest organisations/ }))
    expect(await screen.findByText("Acme Agritech")).toBeInTheDocument()
    expect(screen.getByText(/not checked against anything we hold/i)).toBeInTheDocument()
  })
})
