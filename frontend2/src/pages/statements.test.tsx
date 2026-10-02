import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import type { Me } from "@/app/auth"
import { Statements } from "@/pages/statements"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

const DIRECTOR: Me = { ...FINANCE, id: "u-dir", role: "DIRECTOR", name: "Dr Rao" }

const ROW = {
  source: "app", ledger_id: "l1", claim_id: "c1", ticket: "FP-2026-000016", staff_id: "S1", name: "Dr Revathi",
  department: "AIDS", paper_title: "A study of SRAM", journal: "Sensors", voucher: "PV-1", amount: 7600,
  authorised_on: "2026-08-30", paid_on: "2026-09-02", held_back: 10000,
}
const ZERO = { ...ROW, ledger_id: "l2", claim_id: "c2", ticket: "ERP-PROCESSED-12", name: "Dr Arun", amount: 0, voucher: null, held_back: 0 }

function statement(over: Record<string, unknown> = {}) {
  return {
    month: "2026-09", label: "September 2026", college: "College", count: 1, people: 1, total: 7600, ledger_total: 7600,
    total_in_words: "Rupees Seven Thousand Six Hundred only",
    by_department: [{ department: "AIDS", amount: 7600, count: 1 }, { department: "CSE", amount: 0, count: 1 }],
    rows: [ROW, ZERO],
    reconciliation: { app_tickets: 2, matched: 2, imported: { count: 0, amount: 0 }, reversals: { count: 0, amount: 0 }, month_not_recorded: 1, issues: [], balanced: true },
    ...over,
  }
}

function load(me: Me, st = statement()) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/payouts/months": () => ({ months: [{ month: "2026-09", label: "September 2026", amount: 7600, count: 1 }] }),
      "/api/payouts/statement": () => st,
      "/api/payouts/bank-exports": () => ({ month: "2026-09", exports: [], new_count: 1, new_total: 7600, all_count: 1, all_total: 7600 }),
      "/api/payouts/financial-year": () => ({ financial_year: "2026-27", allocation: 2_000_000, paid: 7600, committed: 0, months: [] }),
    })
  )
}

describe("the monthly statement", () => {
  it("lists the payments, not the claims closed at ₹0, and says how many are folded away", async () => {
    load(FINANCE)
    renderWithProviders(<Statements />)
    expect(await screen.findByText("Dr Revathi")).toBeInTheDocument()
    expect(screen.queryByText("Dr Arun")).toBeNull()
    expect(screen.getByRole("button", { name: /Show claims closed at ₹0\s*\(1\)/ })).toBeInTheDocument()
  })

  it("shows the research threshold on the amount it reduced", async () => {
    load(FINANCE)
    renderWithProviders(<Statements />)
    expect(await screen.findByText("₹10,000 held back by the research threshold")).toBeInTheDocument()
  })

  it("gives Finance the bank file and says it equals the statement; the Director gets none", async () => {
    load(FINANCE)
    const { unmount } = renderWithProviders(<Statements />)
    expect(await screen.findByRole("button", { name: /Bank file/ })).toBeInTheDocument()
    expect(await screen.findByText(/Bank file not released yet.*the same as this statement/)).toBeInTheDocument()
    unmount()
    load(DIRECTOR)
    renderWithProviders(<Statements />)
    expect(await screen.findByRole("link", { name: /Statement to sign/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Bank file/ })).toBeNull()
  })

  it("names each line to explain and links it to the claim", async () => {
    load(FINANCE, statement({
      reconciliation: { app_tickets: 2, matched: 1, imported: { count: 0, amount: 0 }, reversals: { count: 0, amount: 0 }, month_not_recorded: 0,
        issues: [{ ticket: "FP-2026-000016", claim_id: "c1", ledger: 0, claim: 7600, problem: "Paid ticket with no ledger row" }], balanced: false },
    }))
    renderWithProviders(<Statements />)
    expect(await screen.findByText(/1 line needs explaining before this month is signed/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "FP-2026-000016" })).toHaveAttribute("href", "/papers/c1")
  })
})

// The super admin's reading of the same page: the reconciliation says where to fix it.
const ADMIN: Me = { ...FINANCE, id: "u-a", role: "SUPER_ADMIN", name: "Admin" }

const adminStatement = (balanced: boolean) =>
  statement({
    label: "Sep 2026",
    count: 80,
    people: 60,
    total: 237690,
    ledger_total: 237690,
    by_department: [{ department: "ECE", amount: 237690, count: 80 }],
    rows: [
      { source: "app", ledger_id: "l1", claim_id: "c1", ticket: "ERP-PROCESSED-120", staff_id: null, name: "Asha Rao", department: "ECE", paper_title: "", journal: "J", voucher: null, amount: 27169, authorised_on: null, paid_on: null },
    ],
    reconciliation: {
      app_tickets: 80, matched: balanced ? 80 : 79, imported: { count: 0, amount: 0 }, reversals: { count: 0, amount: 0 }, month_not_recorded: 0,
      issues: balanced ? [] : [{ ticket: "ERP-PROCESSED-120", claim_id: "c1", ledger: 0, claim: 5000, problem: "Paid, no ledger row" }],
      balanced,
    },
  })

describe("monthly statements, as a super admin", () => {
  it("says the statement agrees with the ledger, in words", async () => {
    load(ADMIN, adminStatement(true))
    renderWithProviders(<Statements />, { route: "/statements" })
    expect((await screen.findAllByText("₹2,37,690")).length).toBeGreaterThan(0)
    expect(screen.getByText("agrees with the ledger")).toBeTruthy()
    // A missing title and voucher say so.
    expect(screen.getAllByText("Title not recorded").length).toBeGreaterThan(0)
  })

  it("counts the lines to explain before signing, and links a super admin to the ledger checks", async () => {
    load(ADMIN, adminStatement(false))
    renderWithProviders(<Statements />, { route: "/statements" })
    expect(await screen.findByText("1 line to explain")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Open the ledger checks" }).getAttribute("href")).toBe("/ledger?problem=no-ledger")
  })

  it("does not send Finance to the ledger checks, which only a super admin can act on", async () => {
    load(FINANCE, adminStatement(false))
    renderWithProviders(<Statements />, { route: "/statements" })
    expect(await screen.findByText("1 line to explain")).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Open the ledger checks" })).toBeNull()
  })
})
