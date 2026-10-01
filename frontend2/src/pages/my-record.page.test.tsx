import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { AppraisalList, PaymentStatement } from "@/pages/my-record"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

const row = (month: string, fy: string, amount: number, over: Record<string, unknown> = {}) => ({
  payout_month: month, financial_year: fy, paper_title: `Paper ${month}`, journal_title: "A Journal",
  amount, voucher_number: null, claim_id: null, ...over,
})

function statement(over: Record<string, unknown> = {}) {
  return {
    name: "Dr A", staff_id: "S1", fy: null, fy_label: null,
    years: [{ fy: 2025, label: "2025-26", total: 6000 }, { fy: 2024, label: "2024-25", total: 1600 }],
    total: 7600, count: 3,
    rows: [row("2026-02", "2025-26", 1000), row("2025-09", "2025-26", 5000), row("2025-01", "2024-25", 1600)],
    ...over,
  }
}

function mount(node: React.ReactElement, path: string, body: unknown, route: string) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY, [path]: () => body }))
  renderWithProviders(node, { route })
}

describe("Payment statement", () => {
  it("shows each financial year's total up front and groups the rows under it", async () => {
    mount(<PaymentStatement />, "/api/me/payments/statement", statement(), "/papers/statement")
    const years = await screen.findByRole("group", { name: "Financial year" })
    expect(within(years).getByRole("button", { name: /2025-26.*₹6,000/ })).toBeTruthy()
    expect(within(years).getByRole("button", { name: /2024-25.*₹1,600/ })).toBeTruthy()
    expect(screen.getByText(/Financial year 2025-26/)).toBeTruthy()
    expect(screen.getByText(/Financial year 2024-25/)).toBeTruthy()
    // Whole rupees, no paise.
    expect(screen.getAllByText("₹7,600").length).toBeGreaterThan(0)
  })

  it("leaves out the voucher column when no payment has a voucher, and says so once", async () => {
    mount(<PaymentStatement />, "/api/me/payments/statement", statement(), "/papers/statement")
    await screen.findByRole("group", { name: "Financial year" })
    expect(screen.queryByRole("columnheader", { name: "Voucher" })).toBeNull()
    expect(screen.getByText(/did not record voucher numbers/)).toBeTruthy()
  })

  it("keeps the voucher column when the college recorded one", async () => {
    const body = statement({ rows: [row("2026-02", "2025-26", 1000, { voucher_number: "V-12" })] })
    mount(<PaymentStatement />, "/api/me/payments/statement", body, "/papers/statement")
    expect(await screen.findByRole("columnheader", { name: "Voucher" })).toBeTruthy()
    expect(screen.getByText("V-12")).toBeTruthy()
  })

  it("has one primary action, print", async () => {
    mount(<PaymentStatement />, "/api/me/payments/statement", statement(), "/papers/statement")
    expect(await screen.findByRole("button", { name: "Print or save as PDF" })).toBeTruthy()
  })
})

const paper = (id: string, year: number, type: string, over: Record<string, unknown> = {}) => ({
  id, title: `Title ${id}`, year, date: null, venue: "A Venue", type, quartile: null, doi: null, eid: null,
  openalex_id: null, citations: 0, source: "openalex", scopus_indexed: true, author_position: 1, total_authors: 2,
  match_confidence: null, authors: [], claim: null, eligible: true, ineligible_reason: null, ...over,
})

describe("List for appraisal", () => {
  it("answers first with the four figures and a paragraph counted from the same rows", async () => {
    const publications = [
      paper("a", 2025, "article", { quartile: "Q1" }),
      paper("b", 2024, "preprint"),
      paper("c", 2023, "conference-paper", { author_position: 2 }),
    ]
    mount(<AppraisalList />, "/api/me/publications", { user: { id: FACULTY.id, name: "Dr A" }, publications }, "/papers/appraisal")
    const summary = await screen.findByTestId("appraisal-summary")
    expect(summary.textContent).toContain("Between 2023 and 2025, Dr A published 3 papers: 1 in journals and 2 in conference proceedings or other venues.")
    const glance = screen.getByRole("group", { name: "At a glance" })
    expect(within(glance).getByText("papers in 2023 to 2025")).toBeTruthy()
    expect(within(glance).getByText("in journals")).toBeTruthy()
  })

  it("does not call a preprint a journal paper when the journal filter is on", async () => {
    const publications = [paper("a", 2025, "article"), paper("b", 2025, "preprint")]
    mount(<AppraisalList />, "/api/me/publications", { user: { id: FACULTY.id, name: "Dr A" }, publications }, "/papers/appraisal?journals=1")
    await screen.findByTestId("appraisal-summary")
    expect(screen.getByText("Title a")).toBeTruthy()
    expect(screen.queryByText("Title b")).toBeNull()
  })
})
