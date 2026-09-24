import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Programme } from "@/pages/programme"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

/**
 * The "what to try next" panel on My research, in the two states a
 * production server is actually in: no model configured (one quiet line,
 * nothing to start), or a hosted model (which is named, and not described as
 * running on this machine).
 */

const COLLEGE = {
  window: { latest_year: 2026, recent_from: 2024, recent_to: 2026, prior_from: 2021, prior_to: 2023 },
  totals: {
    papers: 0, papers_prior: 0, classified: 0, unclassified: 0, areas: 0, departments: 0,
    people: 0, truncated: false, comparable: false, not_comparable_why: null,
  },
  areas: [], rising: [], fading: [], departments: [], journals: [], years: [],
}

const PROGRAMME = {
  areas: [], interests: [], search_terms: [], colleagues: [], live: [],
  totals: { my_papers: 0, my_areas: 0, colleagues: 0 }, classified: 0,
}

function mount(ai: Record<string, unknown>) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/programme/me": () => PROGRAMME,
      "/api/trends/me": () => ({
        college: COLLEGE,
        people: { people: [], grounded_on: { areas: [], interests: [], since: 2024 }, why_empty: null },
        ai,
      }),
    })
  )
  renderWithProviders(<Programme />, { route: "/programme" })
}

describe("Programme — the model's panel", () => {
  it("says in one line that AI is not set up, with nothing to start and no button", async () => {
    mount({ available: false, code: "not_configured", detail: "AI suggestions are not set up on this server.", model: "", provider: "none", hosted: false, host: "" })
    expect(await screen.findByText(/AI suggestions are not set up on this server/)).toBeInTheDocument()
    expect(document.body.textContent?.toLowerCase()).not.toContain("ollama")
    expect(screen.queryByRole("button", { name: /Suggest some directions/ })).toBeNull()
    // A line, not a caution box: nothing is wrong, nothing is configured.
    expect(screen.queryByText("Suggestions are switched off")).toBeNull()
  })

  it("names a hosted model and does not claim the text stays here", async () => {
    mount({ available: true, code: "ready", detail: null, model: "llama-3.3-70b-versatile", provider: "openai", hosted: true, host: "api.groq.com" })
    expect(await screen.findByRole("button", { name: /Suggest some directions/ })).toBeInTheDocument()
    expect(screen.getByText(/api\.groq\.com/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/leaves this machine|running on this server/)
  })
})
