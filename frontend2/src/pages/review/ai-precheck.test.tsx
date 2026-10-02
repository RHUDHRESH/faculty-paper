import { useState } from "react"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { ApiError, api } from "@/lib/api"
import { renderWithProviders } from "@/test/harness"

import {
  AiPrecheckSection,
  AiReasonDraft,
  type AiItem,
  type AiPrecheckStatus,
  type AiResult,
} from "./ai-precheck"

const item = (over: Partial<AiItem> & Pick<AiItem, "key" | "label" | "status">): AiItem => ({
  detail: "A sentence about it.",
  evidence: [],
  locked: false,
  ai: null,
  ...over,
})

const RESULT: AiResult = {
  id: "pre1",
  created_at: "2026-10-02T09:00:00Z",
  ai_ok: true,
  ai_error: null,
  summary: "One thing to fix.",
  model: "llama-3.3-70b-versatile",
  host: "api.groq.com",
  hosted: true,
  items: [
    item({
      key: "affiliation",
      label: "College affiliation",
      status: "pass",
      detail: "“Saveetha Engineering College” is in the paper's text.",
      evidence: [
        { quote: "Asha Faculty, Saveetha Engineering College, Chennai", page: 1, file: "paper.pdf", by: "check" },
      ],
    }),
    item({ key: "author_position", label: "Author position", status: "warn", detail: "No author list on record." }),
    item({
      key: "sec_references",
      label: "SEC references",
      status: "fail",
      detail: "1 of the 2 SEC references the policy asks for are attached.",
      locked: true,
      ai: { status: "pass", note: "Both found.", raised: false },
    }),
    item({ key: "journal", label: "Journal and quartile", status: "pass" }),
    item({ key: "watch_list", label: "Watch-list and warning signs", status: "pass" }),
    item({ key: "duplicate", label: "Possible duplicate", status: "pass" }),
  ],
}

const ON: AiPrecheckStatus = {
  available: true,
  code: "ready",
  model: RESULT.model,
  host: RESULT.host,
  hosted: true,
  usage: { used: 3, limit: 40 },
  current: null,
  changed: false,
}

type Writes = Record<string, () => unknown>

const DRAFT = {
  reason: "Please fix the following.\n1. Attach both SEC references.",
  source: "ai",
  keys: ["sec_references"],
  model: "llama-3.1-8b-instant",
  host: "api.groq.com",
  hosted: true,
}

/** GET of the status answers `status`; every POST answers from `writes`, else a sensible default. */
function mount(ui: React.ReactElement, status: Partial<AiPrecheckStatus> | (() => never), writes: Writes = {}) {
  const defaults: Writes = {
    "/api/claims/c1/ai-precheck": () => RESULT,
    "/api/claims/c1/ai-precheck/feedback": () => ({ ok: true }),
    "/api/claims/c1/ai-precheck/send-back-draft": () => DRAFT,
  }
  vi.mocked(api).mockImplementation(((path: string, init?: { method?: string }) => {
    try {
      if (path === "/api/auth/me") {
        return Promise.resolve({ id: "u", email: "c@e.edu", name: "R Cell", role: "RESEARCH_CELL", department: null })
      }
      if (init?.method === "POST") return Promise.resolve({ ...defaults, ...writes }[path]?.())
      if (path === "/api/claims/c1/ai-precheck") return Promise.resolve(typeof status === "function" ? status() : { ...ON, ...status })
      return Promise.reject(new ApiError(404, "No handler in this test for " + path))
    } catch (err) {
      return Promise.reject(err)
    }
  }) as unknown as typeof api)
  return renderWithProviders(ui)
}

function posts(path: string) {
  return vi.mocked(api).mock.calls.filter(([p, o]) => p === path && (o as { method?: string } | undefined)?.method === "POST")
}

const section = (over: Partial<React.ComponentProps<typeof AiPrecheckSection>> = {}) => (
  <AiPrecheckSection claimId="c1" version="v1" role="RESEARCH_CELL" own={false} auto={false} {...over} />
)

describe("Check with AI, the section on the Check tab", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })

  it("says AI is off, in one line, and offers nothing to press", async () => {
    mount(section(), { available: false, code: "not_configured" })
    expect(await screen.findByText(/AI is off for this college/)).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
    expect(posts("/api/claims/c1/ai-precheck")).toHaveLength(0)
  })

  it("says the service is not answering, rather than off, when it is configured but down", async () => {
    mount(section(), { available: false, code: "service_down" })
    expect(await screen.findByText(/AI is not answering right now/)).toBeInTheDocument()
    expect(screen.queryByText(/AI is off/)).toBeNull()
  })

  it("draws nothing, and asks nothing, for a seat that may not use it or on one's own claim", async () => {
    for (const props of [{ role: "DIRECTOR" as const }, { role: "FINANCE" as const }, { role: "FACULTY" as const }, { role: "PRINCIPAL" as const }, { own: true }]) {
      vi.mocked(api).mockReset()
      const view = mount(section(props), {})
      await waitFor(() => expect(view.container.querySelector("section")).toBeNull())
      expect(vi.mocked(api).mock.calls.filter(([p]) => p === "/api/claims/c1/ai-precheck")).toHaveLength(0)
      view.unmount()
    }
  })

  it("offers the check, and runs it only when asked", async () => {
    const user = userEvent.setup()
    mount(section(), {})
    await user.click(await screen.findByRole("button", { name: /Check with AI/ }))
    await waitFor(() => expect(posts("/api/claims/c1/ai-precheck")).toHaveLength(1))
    expect(posts("/api/claims/c1/ai-precheck")[0][1]).toMatchObject({ json: { force: false } })
  })

  it("shows the answer with status in words, the quoted line with its page, and who wrote it", async () => {
    mount(section(), { current: RESULT })
    expect(await screen.findByText("1 failed, 1 to check")).toBeInTheDocument()
    expect(screen.getByText(/One thing to fix/)).toBeInTheDocument()
    expect(screen.getAllByText("Pass")).toHaveLength(4)
    expect(screen.getByText("Check this")).toBeInTheDocument()
    expect(screen.getByText("Fail")).toBeInTheDocument()
    expect(screen.getByText(/Asha Faculty, Saveetha Engineering College, Chennai/)).toBeInTheDocument()
    expect(screen.getByText(/Page 1 · paper\.pdf · Found by the check/)).toBeInTheDocument()
    // The model's own view is shown beside the record's verdict, and does not change it.
    expect(screen.getByText(/Both found\./)).toBeInTheDocument()
    expect(screen.getByText(/llama-3\.3-70b-versatile on api\.groq\.com/)).toBeInTheDocument()
    expect(screen.getAllByText("AI draft").length).toBeGreaterThan(0)
    // It never decides: nothing here clears, sends back or ticks.
    expect(screen.queryByRole("button", { name: /^(Clear|Send back|Approve)/ })).toBeNull()
  })

  it("names the college's own server when the model is not hosted", async () => {
    mount(section(), { current: { ...RESULT, hosted: false, host: "", model: "gemma3:12b" }, hosted: false })
    expect(await screen.findByText(/gemma3:12b on the college's own server/)).toBeInTheDocument()
  })

  it("runs once on opening when asked to, and never twice for the same claim", async () => {
    mount(section({ auto: true }), {})
    await waitFor(() => expect(posts("/api/claims/c1/ai-precheck")).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(posts("/api/claims/c1/ai-precheck")).toHaveLength(1)
  })

  it("does not run on opening when the answer is already stored, AI is off, or the day is spent", async () => {
    for (const status of [{ current: RESULT }, { available: false }, { usage: { used: 40, limit: 40 } }]) {
      vi.mocked(api).mockReset()
      const view = mount(section({ auto: true }), status)
      await waitFor(() => expect(screen.queryByRole("status", { name: /Looking/ })).toBeNull())
      await new Promise((r) => setTimeout(r, 30))
      expect(posts("/api/claims/c1/ai-precheck")).toHaveLength(0)
      view.unmount()
    }
  })

  it("shows the record's checks and says so when the model's answer could not be read", async () => {
    mount(section(), {
      current: { ...RESULT, id: null, ai_ok: false, ai_error: "The AI's answer could not be read, so only the record checks are shown." },
    })
    expect(await screen.findByText("The AI's reading is missing")).toBeInTheDocument()
    expect(screen.getByText(/only the record checks are shown/)).toBeInTheDocument()
    expect(screen.getByText("Fail")).toBeInTheDocument()
    // Nothing was stored, so there is nothing to rate.
    expect(screen.queryByRole("button", { name: "Useful" })).toBeNull()
  })

  it("checks again on request, with the stored answer bypassed", async () => {
    const user = userEvent.setup()
    mount(section(), { current: RESULT })
    await user.click(await screen.findByRole("button", { name: /Check again/ }))
    await waitFor(() => expect(posts("/api/claims/c1/ai-precheck")).toHaveLength(1))
    expect(posts("/api/claims/c1/ai-precheck")[0][1]).toMatchObject({ json: { force: true } })
  })

  it("says when the day's checks are used and stops offering a run", async () => {
    mount(section(), { usage: { used: 40, limit: 40 } })
    expect(await screen.findByText(/used today's 40 AI checks/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Check with AI/ })).toBeDisabled()
  })

  it("shows the server's sentence when a run is refused", async () => {
    const user = userEvent.setup()
    mount(section(), {}, {
      "/api/claims/c1/ai-precheck": () => {
        throw new ApiError(503, "AI is off for this college.")
      },
    })
    await user.click(await screen.findByRole("button", { name: /Check with AI/ }))
    expect(await screen.findByText("AI is off for this college.")).toBeInTheDocument()
  })

  it("sends a thumbs up or down for the stored answer", async () => {
    const user = userEvent.setup()
    mount(section(), { current: RESULT })
    await user.click(await screen.findByRole("button", { name: "Not useful" }))
    await waitFor(() => expect(posts("/api/claims/c1/ai-precheck/feedback")).toHaveLength(1))
    expect(posts("/api/claims/c1/ai-precheck/feedback")[0][1]).toMatchObject({
      json: { target_id: "pre1", rating: -1, feature: "claim_precheck" },
    })
    expect(screen.getByRole("button", { name: "Not useful" })).toHaveAttribute("aria-pressed", "true")
  })

  it("keeps working, without the section's help, when the status cannot be read", async () => {
    mount(section(), () => {
      throw new ApiError(500, "down")
    })
    expect(await screen.findByText(/could not be reached just now/)).toBeInTheDocument()
  })
})

function ReasonBox({ initial = "" }: { initial?: string }) {
  const [reason, setReason] = useState(initial)
  return (
    <>
      <label htmlFor="reason">Reason</label>
      <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <AiReasonDraft claimId="c1" version="v1" role="RESEARCH_CELL" onUse={(t) => setReason((r) => (r ? `${r}\n\n${t}` : t))} />
    </>
  )
}

describe("Draft send-back reason, beside the reason box", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })


  it("is not offered before a check has found something", async () => {
    mount(<ReasonBox />, { current: { ...RESULT, items: RESULT.items.map((i) => ({ ...i, status: "pass" as const })) } })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByRole("button", { name: /Draft send-back reason/ })).toBeNull()
  })

  it("is not offered when AI is off", async () => {
    mount(<ReasonBox />, { available: false })
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByRole("button", { name: /Draft send-back reason/ })).toBeNull()
  })

  it("puts the draft in its own editable box, and into the reason only on Use this", async () => {
    const user = userEvent.setup()
    mount(<ReasonBox initial="1. Marked on the paper." />, { current: RESULT })
    await user.click(await screen.findByRole("button", { name: /Draft send-back reason/ }))

    const box = (await screen.findByLabelText("Drafted reason, editable")) as HTMLTextAreaElement
    expect(box.value).toContain("Attach both SEC references.")
    expect(screen.getByText(/llama-3\.1-8b-instant on api\.groq\.com/)).toBeInTheDocument()
    expect(screen.getByText("AI draft")).toBeInTheDocument()
    // Not yet in the reason.
    expect((screen.getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("1. Marked on the paper.")

    await user.type(box, " Thank you.")
    await user.click(screen.getByRole("button", { name: "Use this" }))
    const reason = screen.getByLabelText("Reason") as HTMLTextAreaElement
    expect(reason.value).toBe("1. Marked on the paper.\n\nPlease fix the following.\n1. Attach both SEC references. Thank you.")
    expect(screen.queryByLabelText("Drafted reason, editable")).toBeNull()
  })

  it("leaves the reason alone on Discard, and says when it was written without the AI", async () => {
    const user = userEvent.setup()
    mount(<ReasonBox initial="Mine." />, { current: RESULT }, { "/api/claims/c1/ai-precheck/send-back-draft": () => ({ ...DRAFT, source: "template" }) })
    await user.click(await screen.findByRole("button", { name: /Draft send-back reason/ }))
    const group = await screen.findByRole("group", { name: "Drafted reason" })
    expect(within(group).getByText("Written without AI from the findings")).toBeInTheDocument()
    await user.click(within(group).getByRole("button", { name: "Discard" }))
    expect((screen.getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("Mine.")
  })

  it("shows the server's sentence when the draft is refused", async () => {
    const user = userEvent.setup()
    mount(<ReasonBox />, { current: RESULT }, {
      "/api/claims/c1/ai-precheck/send-back-draft": () => {
        throw new ApiError(429, "You have used today's 40 AI checks.")
      },
    })
    await user.click(await screen.findByRole("button", { name: /Draft send-back reason/ }))
    expect(await screen.findByText(/used today's 40 AI checks/)).toBeInTheDocument()
  })
})
