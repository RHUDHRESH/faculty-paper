import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { BatchCheck, type Finding } from "@/pages/batch-check"
import { fakeApi, failing, renderWithProviders } from "@/test/harness"

const RULES = {
  far_rupees: 1000,
  far_percent: 5,
  title_ratio_percent: 90,
  large_factor: 1.5,
  large_percentile: 90,
  large_floor: 10000,
  thin_left_percent: 10,
  recent_days: 14,
  daily_limit: 20,
}

const OFF_FORMULA: Finding = {
  id: "F1",
  kind: "amount_off_formula",
  severity: "high",
  title: "Amount differs from the calculator",
  reason: "Recorded ₹1,50,000, but the calculator gives ₹60,000, a difference of ₹90,000.",
  facts: { recorded: 150000, formula: 60000 },
  claim_id: "c1",
  ticket_number: "FP-2026-000001",
  paper_title: "A paper",
  name: "Fay Faculty",
  department: "CSE",
  link: "/review/c1?queue=authorisations",
}
const FIRST: Finding = {
  id: "F2",
  kind: "first_payee",
  severity: "low",
  title: "First payment to this person",
  reason: "No payment to this person is on the ledger or in the old payment record.",
  facts: {},
  claim_id: "c1",
  ticket_number: "FP-2026-000001",
  paper_title: "A paper",
  name: "Fay Faculty",
  department: "CSE",
  link: "/review/c1?queue=authorisations",
}
const BUDGET: Finding = {
  id: "F3",
  kind: "budget",
  severity: "medium",
  title: "Budget",
  reason: "Only ₹40,000 of the year's ₹10,00,000 is left once this batch is counted.",
  facts: {},
  claim_id: null,
  ticket_number: null,
  paper_title: "",
  name: null,
  department: null,
  link: "/budget",
}

type Ai = { state: string; model: string; host: string; hosted: boolean; message: string | null }
const READY: Ai = { state: "ready", model: "llama-test", host: "api.example.test", hosted: true, message: null }
const OFF: Ai = { state: "off", model: "", host: "", hosted: false, message: "AI is off for this college." }

function list(findings: Finding[], ai: Ai = READY) {
  return {
    stage: "authorise",
    batch: { count: 12, amount: 315370, truncated: false },
    findings,
    counts: {},
    fingerprint: "fp1",
    ai,
    summary: null,
    rules: RULES,
  }
}

const SUMMARY = {
  headline: "One amount is far from the calculator, and the budget is tight.",
  order: ["F3", "F1", "F2"],
  reasons: { F1: "This claim is recorded at more than double what the calculator gives." },
  model: "llama-test",
  host: "api.example.test",
  hosted: true,
  cached: false,
}

function stub(table: Parameters<typeof fakeApi>[0]) {
  vi.mocked(api).mockImplementation(fakeApi(table))
}

const calls = (path: string) => vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith(path))

beforeEach(() => {
  vi.mocked(api).mockReset()
})

describe("Check this batch", () => {
  it("asks nothing until the button is pressed", () => {
    stub({})
    renderWithProviders(<BatchCheck stage="authorise" />)
    expect(screen.getByRole("button", { name: "Check this batch" })).toBeInTheDocument()
    expect(calls("/api/batch-check")).toHaveLength(0)
  })

  it("with AI off shows the whole list and says so, and never asks for a summary", async () => {
    stub({ "/api/batch-check/authorise": () => list([OFF_FORMULA, FIRST, BUDGET], OFF) })
    renderWithProviders(<BatchCheck stage="authorise" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))

    expect(await screen.findByText(/3 things worth a look in 12 claims/)).toBeInTheDocument()
    const rows = within(screen.getByRole("list", { name: "What stands out" })).getAllByRole("listitem")
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText("Look first")).toBeInTheDocument()
    expect(within(rows[0]).getByText(/the calculator gives ₹60,000/)).toBeInTheDocument()
    expect(screen.getByText(/AI is off for this college\. The list below is complete without it\./)).toBeInTheDocument()
    expect(screen.queryByText("AI summary")).toBeNull()
    expect(calls("/api/batch-check/authorise/summary")).toHaveLength(0)
  })

  it("links each finding to its claim, and the budget one to the budget", async () => {
    stub({ "/api/batch-check/authorise": () => list([OFF_FORMULA, BUDGET], OFF) })
    renderWithProviders(<BatchCheck stage="authorise" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))
    await screen.findByText(/2 things worth a look/)
    expect(screen.getByRole("link", { name: "Open claim" })).toHaveAttribute("href", "/review/c1?queue=authorisations")
    expect(screen.getByRole("link", { name: "Open budget" })).toHaveAttribute("href", "/budget")
  })

  it("says plainly when nothing is unusual, and does not ask the model", async () => {
    stub({ "/api/batch-check/authorise": () => list([]) })
    renderWithProviders(<BatchCheck stage="authorise" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))
    expect(await screen.findByText("Nothing unusual in 12 claims, ₹3,15,370.")).toBeInTheDocument()
    expect(calls("/api/batch-check/authorise/summary")).toHaveLength(0)
  })

  it("shows the AI summary labelled, with the model and host, in the model's order", async () => {
    stub({
      "/api/batch-check/authorise": () => list([OFF_FORMULA, FIRST, BUDGET]),
      "/api/batch-check/authorise/summary": () => ({ ...list([OFF_FORMULA, FIRST, BUDGET]), summary: SUMMARY }),
    })
    renderWithProviders(<BatchCheck stage="authorise" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))

    expect(await screen.findByText("AI summary")).toBeInTheDocument()
    expect(screen.getByText("Written by llama-test via api.example.test")).toBeInTheDocument()
    expect(screen.getByText(SUMMARY.headline)).toBeInTheDocument()
    expect(screen.getByText(SUMMARY.reasons.F1)).toBeInTheDocument()
    // the deterministic reason stays beside the AI wording
    expect(screen.getByText(OFF_FORMULA.reason)).toBeInTheDocument()
    const kinds = within(screen.getByRole("list", { name: "What stands out" }))
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("data-kind"))
    expect(kinds).toEqual(["budget", "amount_off_formula", "first_payee"])
    expect(calls("/api/batch-check/authorise/summary")).toHaveLength(1)
  })

  it("shows the list while the summary is being written", async () => {
    let release: (v: never) => void = () => {}
    vi.mocked(api).mockImplementation((path: string) => {
      if (path.startsWith("/api/batch-check/authorise/summary"))
        return new Promise((resolve) => (release = resolve)) as Promise<never>
      return Promise.resolve(list([OFF_FORMULA, FIRST])) as Promise<never>
    })
    renderWithProviders(<BatchCheck stage="authorise" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))
    expect(await screen.findByText("Writing a short summary…")).toBeInTheDocument()
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(2)
    release({ ...list([OFF_FORMULA, FIRST]), summary: { ...SUMMARY, order: ["F1", "F2"] } } as never)
    expect(await screen.findByText("AI summary")).toBeInTheDocument()
  })

  it("keeps the list when the summary is over the day's limit, with the reason", async () => {
    stub({
      "/api/batch-check/authorise": () => list([OFF_FORMULA]),
      "/api/batch-check/authorise/summary": () => ({
        ...list([OFF_FORMULA]),
        ai: { ...READY, state: "limit", message: "That is a lot of batch checks for one day. The limit is 20." },
        summary: null,
      }),
    })
    renderWithProviders(<BatchCheck stage="authorise" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))
    expect(await screen.findByText(/The limit is 20\. The list below is complete without it\./)).toBeInTheDocument()
    expect(screen.getByText(/the calculator gives ₹60,000/)).toBeInTheDocument()
  })

  it("keeps the list when the summary request fails", async () => {
    stub({
      "/api/batch-check/authorise": () => list([OFF_FORMULA]),
      "/api/batch-check/authorise/summary": failing(500),
    })
    renderWithProviders(<BatchCheck stage="authorise" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))
    await waitFor(() => expect(calls("/api/batch-check/authorise/summary")).toHaveLength(1))
    expect(await screen.findByText(/the calculator gives ₹60,000/)).toBeInTheDocument()
    expect(screen.queryByText("AI summary")).toBeNull()
  })

  it("sends feedback once and says thanks", async () => {
    stub({
      "/api/batch-check/authorise": () => list([OFF_FORMULA]),
      "/api/batch-check/authorise/summary": () => ({ ...list([OFF_FORMULA]), summary: { ...SUMMARY, order: ["F1"] } }),
      "/api/batch-check-feedback": () => ({ ok: true }),
    })
    renderWithProviders(<BatchCheck stage="authorise" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))
    await userEvent.click(await screen.findByRole("button", { name: "Not useful" }))
    expect(await screen.findByText(/Thanks/)).toBeInTheDocument()
    const [, init] = calls("/api/batch-check-feedback")[0]
    expect(init).toMatchObject({ method: "POST", json: { stage: "authorise", fingerprint: "fp1", helpful: false } })
    expect(screen.queryByRole("button", { name: "Not useful" })).toBeNull()
  })

  it("shows a failed check as a failure, not as a clean batch", async () => {
    stub({ "/api/batch-check/pay": failing(500) })
    renderWithProviders(<BatchCheck stage="pay" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check the batch")
    expect(screen.queryByText(/Nothing unusual/)).toBeNull()
  })

  it("passes the department filter through", async () => {
    stub({ "/api/batch-check/authorise": () => list([], OFF) })
    renderWithProviders(<BatchCheck stage="authorise" department="CSE & IT" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))
    await screen.findByText(/Nothing unusual/)
    expect(String(calls("/api/batch-check/authorise")[0][0])).toBe("/api/batch-check/authorise?department=CSE%20%26%20IT")
  })

  it("explains the thresholds behind a disclosure and offers no decision", async () => {
    stub({ "/api/batch-check/pay": () => list([OFF_FORMULA], OFF) })
    renderWithProviders(<BatchCheck stage="pay" />)
    await userEvent.click(screen.getByRole("button", { name: "Check this batch" }))
    await screen.findByText(/worth a look/)
    await userEvent.click(screen.getByRole("button", { name: /how this is decided/i }))
    expect(screen.getByText(/at least ₹1,000 and 5% away/)).toBeInTheDocument()
    expect(screen.getByText(/never looks at the research cell's notes/)).toBeInTheDocument()
    for (const word of ["Authorise", "Pay", "Approve", "Block", "Hold"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${word}`) })).toBeNull()
    }
  })
})
