import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { ACTIONS, matchActions } from "@/app/search-engine"
import { api, ApiError } from "@/lib/api"
import { Research } from "@/pages/research"
import {
  ResearchHelper,
  ResearchHelperLink,
  type AiBlock,
  type HelperColleague,
  type HelperResult,
  type HelperSetup,
  type HelperVenue,
} from "@/pages/research-helper"
import { FACULTY, renderWithProviders } from "@/test/harness"

/**
 * The research helper's panel in each state it can be in: AI off, AI on and
 * answering, a warned journal, a draft message, nothing found, a failure.
 * The server is stubbed; what is pinned is what a person sees and what the
 * page will and will not do (it never writes to Messages by itself).
 */

const ON: AiBlock = {
  state: "ready", label: "AI suggestion", model: "llama-3.3-70b-versatile", host: "api.groq.com",
  hosted: true, detail: null, cached: false, per_day: 30, left: 30,
}
const OFF: AiBlock = {
  state: "off", label: "AI suggestion", model: "", host: "", hosted: false,
  detail: "AI is off for this college. The lists below are counted from the college's record.",
  cached: false, per_day: 30, left: 30,
}

const SETUP = (ai: AiBlock): HelperSetup => ({
  ai,
  papers: [{ id: "pub1", title: "Photovoltaic tracking in my own lab", year: 2022 }],
})

const venue = (over: Partial<HelperVenue>): HelperVenue => ({
  id: "v1", title: "Solar Test Journal", issn: "1111-2222", quartile: "Q1", subject: "Renewable Energy", sjr: 1.8,
  snip: 1.77, dataset_year: 2025, indexed: true, source: "history",
  history: { papers: 5, on_topic: 2, first_year: 2016, last_year: 2026, citations: 12, colleagues: 3, quartiles: { Q1: 2 } },
  caution: null, why: "Colleagues published 2 papers on similar topics here, 5 in all (2016 to 2026).",
  picked: false, ai_why: null, fit: null, ...over,
})

const person = (over: Partial<HelperColleague>): HelperColleague => ({
  id: "p1", user_id: "u-anita", name: "Dr Anita Solar", department: "EEE", designation: "Professor",
  photo_url: null, initials: "AS", papers_on_topic: 4, papers_together: 0,
  shared_coauthors: [{ user_id: "u-c", name: "Dr Chitra Both" }], shared_count: 1,
  papers: [{ id: "x1", title: "Maximum power point tracking for photovoltaic arrays", year: 2024, venue: "Solar Test Journal", doi: "10.1/mppt" }],
  why: "Has 4 papers on similar topics, for example â€œMaximum power point tracking for photovoltaic arraysâ€ (2024). You have both written with Dr Chitra Both.",
  picked: false, ai_why: null, ...over,
})

const RESULT = (over: Partial<HelperResult> = {}): HelperResult => ({
  input: { hash: "a".repeat(24), title: "Shaded arrays", chars: 120, terms: ["photovoltaic", "solar", "mppt"], paper_id: null, matched_papers: 9 },
  venues: [
    venue({}),
    venue({
      id: "v2", title: "Watched Energy Letters", quartile: "Q2", snip: null, history: null,
      caution: { kind: "watch", level: "warning", text: "The college is keeping a close eye on this journal. Ask the research office before you submit." },
      why: "Colleagues publish here, 1 in all (2025).",
    }),
    venue({
      id: "v3", title: "Obscure Quarterly", quartile: null, snip: null, indexed: false, subject: null, issn: null, history: null,
      caution: { kind: "unlisted", level: "check", text: "Not in the Scimago list, so there is no quartile or SNIP to show. Check that it is indexed before you submit." },
      why: "Colleagues publish here.",
    }),
  ],
  colleagues: [person({}), person({ id: "p2", user_id: "u-bala", name: "Dr Bala Converter", department: "ECE", shared_coauthors: [], shared_count: 0, why: "Has 3 papers on similar topics." })],
  papers: [{
    id: "pub9", title: "Shaded photovoltaic arrays and tracking methods", year: 2025, venue: "Watched Energy Letters",
    quartile: "Q2", doi: null, mine: false, authors: [{ user_id: "u-anita", name: "Dr Anita Solar" }], authors_more: 0, matched: ["photovoltaic", "shaded"],
  }],
  ai: ON,
  summary: null,
  ...over,
})

type Handler = (body: Record<string, unknown>, method: string) => unknown

/** The stubbed server: records every call so a test can say what was asked. */
function server(setup: HelperSetup, handlers: { find?: Handler; draft?: Handler; feedback?: Handler } = {}) {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((async (path: string, opts: { method?: string; json?: Record<string, unknown> } = {}) => {
    const method = (opts.method ?? "GET").toUpperCase()
    const body = opts.json ?? {}
    calls.push({ path, method, body })
    if (path === "/api/auth/me") return FACULTY
    if (path === "/api/institution") return { college_name: "Saveetha" }
    if (path === "/api/research-helper" && method === "GET") return setup
    if (path === "/api/research-helper" && method === "POST") return (handlers.find ?? (() => RESULT()))(body, method)
    if (path === "/api/research-helper/draft") return (handlers.draft ?? (() => ({})))(body, method)
    if (path === "/api/research-helper/feedback") return (handlers.feedback ?? (() => ({ ok: true })))(body, method)
    throw new ApiError(404, `No handler in this test for ${path}`)
  }) as never)
  return calls
}

const IDEA = "We design a maximum power point tracking controller for photovoltaic arrays under partial shading."

async function fillAndFind(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Abstract or idea"), IDEA)
  await user.click(screen.getByRole("button", { name: /Find journals and colleagues/ }))
}

describe("Research helper: the form", () => {
  it("asks for an abstract, will not search on a few words, and says where the AI runs", async () => {
    server(SETUP(ON))
    renderWithProviders(<ResearchHelper />)
    const find = await screen.findByRole("button", { name: /Find journals and colleagues/ })
    expect(find).toBeDisabled()
    await userEvent.setup().type(screen.getByLabelText("Abstract or idea"), "solar")
    expect(find).toBeDisabled()
    expect(await screen.findByText(/llama-3.3-70b-versatile at api.groq.com\. What you paste is sent there/)).toBeInTheDocument()
    expect(screen.getByText(/30 of 30 AI suggestions left today/)).toBeInTheDocument()
    expect(screen.getByText("What you get")).toBeInTheDocument()
  })

  it("lets a person pick one of their own papers instead", async () => {
    const calls = server(SETUP(OFF))
    const user = userEvent.setup()
    renderWithProviders(<ResearchHelper />)
    await user.click(await screen.findByRole("button", { name: "One of my papers" }))
    const find = screen.getByRole("button", { name: /Find journals and colleagues/ })
    expect(find).toBeDisabled()
    await user.selectOptions(screen.getByLabelText("Your paper"), "pub1")
    await user.click(find)
    await screen.findByText("Journals that fit")
    const post = calls.find((c) => c.method === "POST")!
    expect(post.body).toMatchObject({ paper_id: "pub1", ai: false })
  })
})

describe("Research helper: AI off", () => {
  it("shows the counted lists and says AI is off, with no AI marks and no AI request", async () => {
    const calls = server(SETUP(OFF), { find: () => RESULT({ ai: OFF }) })
    const user = userEvent.setup()
    renderWithProviders(<ResearchHelper />)
    expect(await screen.findByText(/AI is off for this college\./)).toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /Let AI rank and explain/ })).not.toBeInTheDocument()
    await fillAndFind(user)
    expect(await screen.findByText("Journals that fit")).toBeInTheDocument()
    expect(screen.getByText("Colleagues on the same topic")).toBeInTheDocument()
    expect(screen.getByText("Related papers at the college")).toBeInTheDocument()
    expect(screen.getByText("Solar Test Journal")).toBeInTheDocument()
    expect(screen.getAllByRole("link", { name: "Dr Anita Solar" }).length).toBeGreaterThan(0)
    expect(screen.queryByText("AI suggestion")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body.ai)).toEqual([false])
  })
})

describe("Research helper: the lists", () => {
  it("shows quartile, SNIP, the college's history and a plain warning for a watched journal", async () => {
    server(SETUP(OFF), { find: () => RESULT({ ai: OFF }) })
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(userEvent.setup())
    const rows = await screen.findAllByTestId("venue-row")
    expect(within(rows[0]).getByText("Q1")).toBeInTheDocument()
    expect(within(rows[0]).getByText("SNIP 1.77")).toBeInTheDocument()
    expect(within(rows[0]).getByText(/The college: 5 papers, 2016 to 2026, 3 colleagues, 12 citations, quartiles on record Q1 2/)).toBeInTheDocument()
    expect(screen.getByText(/Quartile and SNIP are the 2025 figures from Scimago/)).toBeInTheDocument()
    // The warning is spoken, in words, on the journal itself.
    expect(within(rows[1]).getByText("Be careful with this journal")).toBeInTheDocument()
    expect(within(rows[1]).getByText(/Ask the research office before you submit/)).toBeInTheDocument()
    expect(within(rows[2]).getByText("Check before you submit")).toBeInTheDocument()
    // Nothing about a desk, a status or money.
    expect(document.body.textContent).not.toMatch(/â‚¹|rupee|incentive|research cell|watch-list|flag/i)
  })

  it("shows faces, departments, shared co-authors and each colleague's papers", async () => {
    server(SETUP(OFF), { find: () => RESULT({ ai: OFF }) })
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(userEvent.setup())
    const rows = await screen.findAllByTestId("colleague-row")
    expect(within(rows[0]).getByText("AS")).toBeInTheDocument() // the face falls back to initials
    expect(within(rows[0]).getByText("EEE, Professor")).toBeInTheDocument()
    expect(within(rows[0]).getByText(/You have both written with Dr Chitra Both/)).toBeInTheDocument()
    expect(within(rows[0]).getByRole("link", { name: "Maximum power point tracking for photovoltaic arrays" }).getAttribute("href")).toBe("https://doi.org/10.1/mppt")
    expect(within(rows[0]).getByRole("link", { name: "Dr Anita Solar" }).getAttribute("href")).toBe("/u/u-anita")
  })

  it("says so when nothing at the college matches", async () => {
    server(SETUP(OFF), { find: () => RESULT({ ai: OFF, venues: [], colleagues: [], papers: [] }) })
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(userEvent.setup())
    expect(await screen.findByText("Nothing at the college matches this yet")).toBeInTheDocument()
  })

  it("keeps a failed search to itself, with a way to try again", async () => {
    let n = 0
    server(SETUP(OFF), {
      find: () => {
        n += 1
        if (n === 1) throw new ApiError(400, "Paste an abstract or describe the idea in a sentence or two, so there is something to match.")
        return RESULT({ ai: OFF })
      },
    })
    const user = userEvent.setup()
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(user)
    expect(await screen.findByText(/Paste an abstract or describe the idea/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Try again|Retry/ }))
    expect(await screen.findByText("Journals that fit")).toBeInTheDocument()
  })

  it("shows nothing but the lists, and one line, when the AI could not answer", async () => {
    server(SETUP(ON), {
      find: (body) =>
        body.ai
          ? RESULT({ ai: { ...ON, state: "failed", detail: "The AI did not answer this time. The lists below are counted from the college's record." } })
          : RESULT(),
    })
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(userEvent.setup())
    expect(await screen.findByText(/The AI did not answer this time/)).toBeInTheDocument()
    expect(screen.getByText("Solar Test Journal")).toBeInTheDocument()
    expect(screen.queryByText("AI suggestion", { selector: "span" })).not.toBeInTheDocument()
  })
})

describe("Research helper: AI on", () => {
  const ranked = (): HelperResult =>
    RESULT({
      ai: { ...ON, state: "used", left: 29 },
      summary: "Tracking the maximum power point of shaded photovoltaic arrays.",
      venues: [
        venue({ picked: true, fit: "strong", ai_why: "Colleagues publish on this topic here." }),
        venue({ id: "v4", title: "Power Conv Journal", picked: false }),
        RESULT().venues[1],
      ],
      colleagues: [person({ picked: true, ai_why: "Writes about the same arrays." }), person({ id: "p2", user_id: "u-bala", name: "Dr Bala Converter" })],
    })

  it("shows the lists first, then asks the AI, and marks every sentence it wrote", async () => {
    const calls = server(SETUP(ON), { find: (b) => (b.ai ? ranked() : RESULT()) })
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(userEvent.setup())
    expect(await screen.findByText("Writes about the same arrays.")).toBeInTheDocument()
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body.ai)).toEqual([false, true])
    expect(screen.getByText("Strong fit")).toBeInTheDocument()
    expect(screen.getByText("Tracking the maximum power point of shaded photovoltaic arrays.")).toBeInTheDocument()
    expect(screen.getAllByText(/llama-3.3-70b-versatile at api.groq.com/).length).toBeGreaterThan(0)
    // The AI's sentences carry the mark; the counted one stays under it.
    expect(screen.getAllByText("AI suggestion").length).toBeGreaterThanOrEqual(3)
    const row = screen.getAllByTestId("venue-row")[0]
    expect(within(row).getByText("Colleagues publish on this topic here.")).toBeInTheDocument()
    expect(within(row).getByText(/Colleagues published 2 papers on similar topics here/)).toBeInTheDocument()
    // The warned journal is still there, still warned.
    expect(screen.getByText("Be careful with this journal")).toBeInTheDocument()
  })

  it("does not ask the AI when the person turns it off for this search", async () => {
    const calls = server(SETUP(ON))
    const user = userEvent.setup()
    renderWithProviders(<ResearchHelper />)
    await user.click(await screen.findByRole("checkbox", { name: /Let AI rank and explain/ }))
    await fillAndFind(user)
    await screen.findByText("Journals that fit")
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body.ai)).toEqual([false])
    expect(screen.getByText(/AI is switched off for this search/)).toBeInTheDocument()
  })

  it("keeps thumbs for each part and sends them with the answer's hash", async () => {
    const calls = server(SETUP(ON), { find: (b) => (b.ai ? ranked() : RESULT()) })
    const user = userEvent.setup()
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(user)
    await screen.findByText("Writes about the same arrays.")
    const groups = screen.getAllByRole("group", { name: "Was this useful?" })
    expect(groups).toHaveLength(2)
    await user.click(within(groups[0]).getByRole("button", { name: "This does not help" }))
    await waitFor(() => expect(screen.getAllByText("Thanks, noted.")).toHaveLength(1))
    const sent = calls.find((c) => c.path === "/api/research-helper/feedback")!
    expect(sent.body).toEqual({ part: "venues", value: "down", input_hash: "a".repeat(24) })
  })

  it("asks again, without the cache, when the person says try again", async () => {
    const calls = server(SETUP(ON), { find: (b) => (b.ai ? ranked() : RESULT()) })
    const user = userEvent.setup()
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(user)
    await user.click(await screen.findByRole("button", { name: "Try again" }))
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(3))
    expect(calls.filter((c) => c.method === "POST")[2].body).toMatchObject({ ai: true, refresh: true })
  })

  it("says plainly when today's allowance is used up and keeps the lists", async () => {
    server(SETUP(ON), {
      find: (b) =>
        b.ai
          ? RESULT({ ai: { ...ON, state: "limit", left: 0, detail: "You have used your 30 AI suggestions for today. The lists below are counted from the college's record." } })
          : RESULT(),
    })
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(userEvent.setup())
    expect(await screen.findByText(/You have used your 30 AI suggestions for today/)).toBeInTheDocument()
    expect(screen.getByText("Solar Test Journal")).toBeInTheDocument()
  })
})

describe("Research helper: the message draft", () => {
  const DRAFT = "Hello Dr Anita Solar,\n\nI am working on shaded arrays and read your paper on tracking. Would you be open to a short chat?\n\nThank you,\nDr Asha Menon"

  async function openDraft(handlers: Parameters<typeof server>[1] = {}, setup = SETUP(OFF)) {
    const calls = server(setup, { find: () => RESULT({ ai: setup.ai }), ...handlers })
    const user = userEvent.setup()
    renderWithProviders(<ResearchHelper />)
    await fillAndFind(user)
    const row = (await screen.findAllByTestId("colleague-row"))[0]
    await user.click(within(row).getByRole("button", { name: "Draft a message" }))
    await user.click(within(row).getByRole("button", { name: "Write a draft" }))
    return { calls, user, row }
  }

  it("writes nothing until asked, then offers an editable draft and a Use this that only opens Messages", async () => {
    const { calls, user, row } = await openDraft({
      draft: () => ({ to: { user_id: "u-anita", name: "Dr Anita Solar" }, message: DRAFT, template: false, ai: { ...ON, state: "used" } }),
    }, SETUP(ON))
    const box = await within(row).findByRole("textbox", { name: "Message to Dr Anita Solar" })
    expect(box).toHaveValue(DRAFT)
    expect(within(row).getByText("AI suggestion")).toBeInTheDocument()
    expect(within(row).getByText(/Nothing is sent\. Use this opens Messages with this text in the box, and you press send yourself\./)).toBeInTheDocument()
    await user.clear(box)
    await user.type(box, "Hello, shall we talk?")
    const use = within(row).getByRole("link", { name: /Use this/ })
    expect(use.getAttribute("href")).toBe(`/messages?to=u-anita&draft=${encodeURIComponent("Hello, shall we talk?")}`)
    // The page itself never writes to Messages: only the lists, the draft and (when pressed) feedback were asked.
    const paths = new Set(calls.filter((c) => c.method === "POST").map((c) => c.path))
    expect([...paths].every((p) => p.startsWith("/api/research-helper"))).toBe(true)
    expect([...paths].some((p) => p.includes("/dm") || p.includes("/messages"))).toBe(false)
  })

  it("sends the same input and the chosen colleague, and calls a template a starting point, not AI", async () => {
    const { calls, row } = await openDraft({
      draft: () => ({ to: { user_id: "u-anita", name: "Dr Anita Solar" }, message: "Hello Dr Anita Solar,\n\nThank you,\nDr Asha Menon", template: true, ai: OFF }),
    })
    expect(await within(row).findByText("A plain starting point")).toBeInTheDocument()
    expect(within(row).queryByText("AI suggestion")).not.toBeInTheDocument()
    const sent = calls.find((c) => c.path === "/api/research-helper/draft")!
    expect(sent.body).toMatchObject({ colleague_id: "u-anita", text: IDEA, refresh: false })
  })

  it("shows a failure to draft in the box, not as a crash", async () => {
    const { row } = await openDraft({ draft: () => { throw new ApiError(400, "Pick a colleague from the list.") } })
    expect(await within(row).findByText("Pick a colleague from the list.")).toBeInTheDocument()
  })
})

describe("Research helper: where it lives", () => {
  function mountResearch(route: string, me = FACULTY) {
    server(SETUP(OFF), { find: () => RESULT({ ai: OFF }) })
    vi.mocked(api).mockImplementation(((path: string) => {
      if (path === "/api/auth/me") return Promise.resolve(me)
      if (path === "/api/research-helper") return Promise.resolve(SETUP(OFF))
      if (path === "/api/institution") return Promise.resolve({ college_name: "Saveetha" })
      return Promise.reject(new ApiError(404, `No handler in this test for ${path}`))
    }) as never)
    renderWithProviders(<Research />, { route })
  }

  it("is a tab on My research that the Discover link and the palette open", async () => {
    mountResearch("/research?tab=helper")
    expect(await screen.findByRole("button", { name: "Research helper" })).toHaveAttribute("aria-pressed", "true")
    expect(await screen.findByLabelText("Abstract or idea")).toBeInTheDocument()
    expect(screen.getByText(/find journals and colleagues at the college that fit/)).toBeInTheDocument()

    render(
      <MemoryRouter>
        <ResearchHelperLink />
      </MemoryRouter>
    )
    expect(screen.getByRole("link", { name: /Ask the research helper/ }).getAttribute("href")).toBe("/research?tab=helper")
  })

  it("is found by Ctrl-K for roles that file their own research and not for the super admin", () => {
    for (const q of ["research helper", "where to publish", "which journal"]) {
      expect(matchActions(q, "FACULTY").map((a) => a.id)).toContain("helper")
    }
    expect(matchActions("research helper", "HOD").map((a) => a.id)).toContain("helper")
    expect(matchActions("research helper", "SUPER_ADMIN").map((a) => a.id)).not.toContain("helper")
    const action = ACTIONS.find((a) => a.id === "helper")!
    const go = vi.fn()
    action.run({ navigate: go, signOut: async () => {} })
    expect(go).toHaveBeenCalledWith("/research?tab=helper")
  })

  it("is not offered to a role that does not file research", async () => {
    mountResearch("/research?tab=helper", { ...FACULTY, role: "SUPER_ADMIN" })
    await screen.findByRole("button", { name: "Me" })
    expect(screen.queryByRole("button", { name: "Research helper" })).not.toBeInTheDocument()
  })

  it("explains itself if the server refuses the role", async () => {
    server(SETUP(OFF))
    vi.mocked(api).mockImplementation(((path: string) => {
      if (path === "/api/research-helper") return Promise.reject(new ApiError(403, "The research helper is for people who file their own research."))
      if (path === "/api/auth/me") return Promise.resolve(FACULTY)
      return Promise.reject(new ApiError(404, path))
    }) as never)
    renderWithProviders(<ResearchHelper />)
    expect(await screen.findByText("The research helper is for people who file their own research")).toBeInTheDocument()
  })
})
