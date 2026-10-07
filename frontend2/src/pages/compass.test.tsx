import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Compass } from "@/pages/compass"
import type { Action, CompassState, Path, Portrait } from "@/pages/compass-model"
import { FACULTY, failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

const FACTS: CompassState["facts"] = {
  papers: 14,
  citations: 120,
  h_index: 6,
  rank: 12,
  q1: 3,
  first_author_share: 0.4,
  journal_share: 0.8,
  topics: [
    { name: "Microgrids", papers: 6 },
    { name: "Battery storage", papers: 4 },
    { name: "Power quality", papers: 2 },
  ],
}

function portrait(counted = false): Portrait {
  return {
    headline: "You make small power grids steadier.",
    strengths: [
      { text: "Control of microgrids", evidence: [{ kind: "paper", id: "p1", label: "Droop control in islanded grids" }] },
      { text: "You write with people", evidence: [{ kind: "person", id: "u2", label: "Dr Ravi" }] },
      { text: "You publish in good journals", evidence: [{ kind: "metric", id: "q1", label: "3 in Q1" }] },
    ],
    topics: [
      { name: "Microgrids", papers: 6 },
      { name: "Battery storage", papers: 4 },
    ],
    standing: "You are among the top 15 in your department for citations.",
    counted,
  }
}

const PATHS: Path[] = [
  {
    key: "q1",
    name: "Q1 specialist",
    why: "Your best work already lands in strong journals.",
    evidence: [{ kind: "journal", id: "j1", label: "IEEE Trans. Smart Grid" }],
    metrics: [{ label: "Q1 papers", now: 3, target: 6, unit: "papers" }],
    peers: [{ id: "u3", name: "Dr Meena", dept: "EEE" }],
  },
  { key: "bridge", name: "Bridge builder", why: "You write across departments.", evidence: [], metrics: [], peers: [] },
  { key: "lead", name: "Lead author", why: "Lead more of your own work.", evidence: [], metrics: [], peers: [] },
]

const PLAN: Action[] = [
  { id: "a1", kind: "journal", title: "Aim one paper at IEEE Trans. Smart Grid", why: "It fits.", ref: { name: "IEEE Trans. Smart Grid", quartile: "Q1", snip: 2.1 }, done: false },
  { id: "a2", kind: "person", title: "Write to Dr Meena", why: "Shared topics.", ref: { user_id: "u3", name: "Dr Meena", dept: "EEE" }, done: false },
]

function sent(path: string) {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p) === path)
}

function mount(state: Partial<CompassState>, extra: ApiTable = {}) {
  const full: CompassState = { ai: true, facts: FACTS, portrait: null, paths: null, chosen_path: null, plan: null, ...state }
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/compass": () => full,
      "/api/compass/summary": () => ({ headline: null, path_name: null, progress: null, next_action: null }),
      ...extra,
    })
  )
  renderWithProviders(<Compass />, { route: "/compass" })
  return userEvent.setup()
}

describe("Research compass", () => {
  it("walks from who you are to asking, with AI on", async () => {
    const user = mount(
      {},
      {
        "/api/compass/portrait": () => portrait(),
        "/api/compass/topics": () => ({ ok: true, topics: ["Microgrids", "Power quality"] }),
        "/api/compass/paths": () => ({ paths: PATHS, counted: false }),
        "/api/compass/choose": () => ({ plan: PLAN, counted: false }),
        "/api/compass/ask": () => ({ answer: "It publishes your kind of control work.", evidence: [{ kind: "journal", id: "j1", label: "IEEE Trans. Smart Grid" }], counted: false }),
      }
    )

    // 1. Who you are
    expect(await screen.findByText("You make small power grids steadier.")).toBeInTheDocument()
    expect(screen.getByRole("navigation", { name: "Steps" })).toHaveTextContent("Who you are")
    // Evidence opens the person panel in place of leaving the compass.
    expect(screen.getByRole("button", { name: /Dr Ravi/ })).toBeInTheDocument()
    expect(screen.getByText(/top 15 in your department/)).toBeInTheDocument()
    expect(screen.queryByText(/AI is off/)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Remove Battery storage" }))
    await user.click(screen.getByRole("button", { name: "Add Power quality" }))
    await user.click(screen.getByRole("button", { name: "That's me" }))
    expect(sent("/api/compass/topics")[0][1]).toMatchObject({ method: "POST", json: { topics: ["Microgrids", "Power quality"] } })

    // 2. What you could be
    expect(await screen.findByRole("heading", { name: "Q1 specialist" })).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "Q1 papers" })).toHaveAttribute("aria-valuenow", "3")
    expect(screen.getByRole("link", { name: "Dr Meena" })).toHaveAttribute("href", "/u/u3")
    await user.click(screen.getAllByRole("button", { name: "Take this path" })[0])
    expect(sent("/api/compass/choose")[0][1]).toMatchObject({ json: { path: "q1" } })

    // 3. Your next steps
    expect(await screen.findByText("0 of 2 done")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /See the journal/ })).toHaveAttribute("href", "/search?scope=journals&q=IEEE%20Trans.%20Smart%20Grid")
    expect(screen.getByRole("link", { name: /^Message$/ })).toHaveAttribute("href", "/messages?to=u3")
    expect(screen.getByRole("link", { name: "Draft an intro" }).getAttribute("href")).toMatch(/^\/messages\?to=u3&draft=/)
    await user.click(screen.getByRole("button", { name: "Ask about your plan" }))

    // 4. Ask
    const prompts = await screen.findByRole("group", { name: "Try asking" })
    expect(within(prompts).getByRole("button", { name: "Draft an email to Dr Meena" })).toBeInTheDocument()
    await user.click(within(prompts).getByRole("button", { name: "Why this journal?" }))
    expect(await screen.findByText("It publishes your kind of control work.")).toBeInTheDocument()
    expect(sent("/api/compass/ask")[0][1]).toMatchObject({ json: { question: "Why this journal?" } })

    // Back is there.
    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(await screen.findByText("0 of 2 done")).toBeInTheDocument()
  })

  it("says quietly when it was written from the record, and still walks on", async () => {
    const user = mount(
      { ai: false },
      {
        "/api/compass/portrait": () => portrait(true),
        "/api/compass/topics": () => ({ ok: true, topics: ["Microgrids", "Battery storage"] }),
        "/api/compass/paths": () => ({ paths: PATHS, counted: true }),
        "/api/compass/choose": () => ({ plan: PLAN, counted: true }),
      }
    )
    expect(await screen.findByText("Written from your record. AI is off right now.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "That's me" }))
    expect(await screen.findByRole("heading", { name: "Q1 specialist" })).toBeInTheDocument()
    expect(screen.getByText("Written from your record. AI is off right now.")).toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: "Take this path" })[0])
    expect(await screen.findByText("0 of 2 done")).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/error|failed/i)
  })

  it("resumes at the plan, and ticking an action saves it and moves the count", async () => {
    const user = mount(
      { portrait: portrait(), paths: PATHS, chosen_path: "q1", plan: PLAN },
      { "/api/compass/actions/a1": () => ({ ok: true, done: true, progress: { done: 1, total: 2 } }) }
    )
    expect(await screen.findByText("0 of 2 done")).toBeInTheDocument()
    await user.click(screen.getByRole("checkbox", { name: /Done: Aim one paper/ }))
    await waitFor(() => expect(screen.getByText("1 of 2 done")).toBeInTheDocument())
    expect(sent("/api/compass/actions/a1")[0][1]).toMatchObject({ method: "POST", json: { done: true } })
  })

  it("doing a step with its own button ticks it, without asking twice", async () => {
    const goal: Action = { id: "g1", kind: "goal", title: "Set a goal: 1 Q1 paper in 2027", why: "One more.", ref: { metric: "Q1", target: 1, year: 2027 }, done: false }
    const user = mount(
      { portrait: portrait(), paths: PATHS, chosen_path: "q1", plan: [PLAN[0], goal] },
      {
        "/api/me/goals": () => ({ year: 2027, goals: [] }),
        "/api/compass/actions/g1": () => ({ ok: true, done: true, progress: { done: 1, total: 2 } }),
      }
    )
    expect(await screen.findByText("0 of 2 done")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Set it/ }))
    await waitFor(() => expect(screen.getByText("1 of 2 done")).toBeInTheDocument())
    expect(sent("/api/me/goals")[0][1]).toMatchObject({ method: "PUT", json: { year: 2027, goals: [{ metric: "Q1", target: 1 }] } })
    expect(sent("/api/compass/actions/g1")[0][1]).toMatchObject({ method: "POST", json: { done: true } })
  })

  it("shows the daily limit inline when asking is used up", async () => {
    const user = mount(
      { portrait: portrait(), paths: PATHS, chosen_path: "q1", plan: PLAN },
      { "/api/compass/ask": failing(429, "You have asked 20 questions today. Ask again tomorrow.") }
    )
    await user.click(await screen.findByText("Ask a question about this"))
    await user.type(screen.getByRole("textbox", { name: "Your question" }), "What next?{Enter}")
    expect(await screen.findByText("You have asked 20 questions today. Ask again tomorrow.")).toBeInTheDocument()
  })

  it("offers a retry in place when the portrait cannot be written", async () => {
    mount({}, { "/api/compass/portrait": failing(503, "The writer is busy.") })
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not write your portrait/)
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })
})
