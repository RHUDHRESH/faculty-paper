import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})
vi.mock("@/lib/table-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/table-export")>()
  return { ...actual, exportTable: vi.fn(async () => "file") }
})

import { api } from "@/lib/api"
import { exportTable } from "@/lib/table-export"
import { snipText, registerTotals } from "@/pages/paper-columns"
import { PaymentsDone } from "@/pages/payments-done"
import { Statements } from "@/pages/statements"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

/**
 * The paper's figures in the Paid register and the monthly statement: the
 * owner's list is what opens, the rest is one click away, an unknown figure is
 * a quiet dash on screen and an empty cell in a file, and a file ends with a
 * Total and an Average.
 */

const FIGURES = {
  issn: "2348-8549", category: "Non-engineering", quartile: "Q3", snip: 0.475, total_authors: 4, author_position: 2,
  doi: "10.1/abc", document_type: "Journal", indexing: "Indexed", remark: "Student publication", academic_year: "2025-26",
  journal: "Sensors",
}
const NOTHING = {
  issn: null, category: null, quartile: null, snip: null, total_authors: null, author_position: null, doi: null,
  document_type: null, indexing: null, remark: null, academic_year: null, journal: null,
}

const PAID = (id: string, over: Record<string, unknown> = {}) => ({
  id, ticket_number: `FP-2026-0000${id.slice(-1)}`, paper_title: `Paper ${id}`, journal_title: "Sensors",
  owner_name: "Dr Senthil Sundaram", owner_department: "IT", staff_id: "SEC1105", remuneration: 20_000,
  calc_error: null, voucher_number: "PV-1", payout_month: "2026-08", paid_at: "2026-08-06T11:00:00Z",
  ledger_paid: 20_000, ledger_rows: 1, figures: FIGURES, ...over,
})

function loadRegister(rows: unknown[]) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FINANCE,
      "/api/admin/payouts": () => ({
        total: rows.length, limit: 50, offset: 0, totals: { count: rows.length, amount: 20_000 }, results: rows,
      }),
      "/api/payouts/months": () => ({ months: [{ month: "2026-08", label: "Aug 2026", amount: 2_15_655, count: 9 }] }),
      "/api/payouts/financial-year": () => ({ financial_year: "2026-27", allocation: null, paid: 3_036_114, committed: 0, months: [] }),
    })
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(exportTable).mockClear()
})

describe("the figures helpers", () => {
  it("writes SNIP without trailing zeros and totals a register", () => {
    expect(snipText(0.475)).toBe("0.475")
    expect(snipText(2)).toBe("2")
    expect(snipText(null)).toBeNull()
    const rows = [{ a: 100, s: 1 }, { a: 300, s: null }]
    expect(registerTotals(rows, (r) => r.a, (r) => r.s)).toEqual([
      { "*": "Total of 2 payments", amount: 400, snip: 1 },
      { "*": "Average", amount: 200, snip: 1 },
    ])
  })
})

describe("the paid register's figures", () => {
  it("opens with the owner's list, in the owner's order, and the rest in the Columns menu", async () => {
    loadRegister([PAID("claim-1")])
    renderWithProviders(<PaymentsDone />)
    expect(await screen.findByText("Dr Senthil Sundaram")).toBeInTheDocument()
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim())
    const wanted = [
      "Title", "Journal name", "ISSN", "Category (Engineering / Non-engineering)", "Quartile", "SNIP",
      "Total number of authors", "Author position", "Amount paid",
    ]
    expect(headers.filter((h) => wanted.includes(h ?? ""))).toEqual(wanted)
    for (const hidden of ["DOI", "Document type", "Indexing (Scopus)", "Remark", "Academic year", "Claim number"]) {
      expect(headers).not.toContain(hidden)
    }
    const row = screen.getAllByRole("row")[1]
    for (const text of ["2348-8549", "Non-engineering", "Q3", "0.475", "4", "2"]) {
      expect(within(row).getAllByText(text).length).toBeGreaterThan(0)
    }
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }))
    for (const name of ["DOI", "Document type", "Indexing (Scopus)", "Remark", "Academic year", "Staff ID", "Department", "Month paid", "Claim number", "Status"]) {
      expect(screen.getByRole("menuitemcheckbox", { name })).toBeInTheDocument()
    }
  })

  it("shows a quiet dash for a figure no source has, never Not recorded", async () => {
    loadRegister([PAID("claim-2", { figures: NOTHING, journal_title: null })])
    renderWithProviders(<PaymentsDone />)
    expect(await screen.findByText("Dr Senthil Sundaram")).toBeInTheDocument()
    const row = screen.getAllByRole("row")[1]
    expect(within(row).getAllByText("–").length).toBeGreaterThanOrEqual(7)
    expect(within(row).queryByText("Not recorded")).toBeNull()
  })

  it("exports the figures, empty when unknown, and ends with a Total and an Average", async () => {
    const user = userEvent.setup()
    loadRegister([PAID("claim-1"), PAID("claim-2", { figures: NOTHING, remuneration: 10_000, ledger_paid: 10_000 })])
    renderWithProviders(<PaymentsDone />)
    expect(await screen.findAllByText("Dr Senthil Sundaram")).not.toHaveLength(0)
    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByRole("menuitem", { name: "CSV" }))
    await waitFor(() => expect(exportTable).toHaveBeenCalled())
    const payload = vi.mocked(exportTable).mock.calls[0][0]
    const labels = payload.columns.map((c) => c.label)
    expect(labels.slice(0, 10)).toEqual([
      "Faculty", "Title", "Journal name", "ISSN", "Category (Engineering / Non-engineering)", "Quartile", "SNIP",
      "Total number of authors", "Author position", "Amount paid",
    ])
    const col = (name: string) => labels.indexOf(name)
    expect(payload.rows[0][col("ISSN")]).toBe("2348-8549")
    expect(payload.rows[0][col("SNIP")]).toBe(0.475)
    expect(payload.rows[1][col("Quartile")]).toBeNull()
    expect(payload.rows[1][col("SNIP")]).toBeNull()
    const [total, average] = payload.rows.slice(-2)
    expect(total[0]).toBe("Total of 2 payments")
    expect(total[col("Amount paid")]).toBe(30_000)
    expect(total[col("SNIP")]).toBe(0.475)
    expect(average[0]).toBe("Average")
    expect(average[col("Amount paid")]).toBe(15_000)
  })
})

describe("the monthly statement's figures", () => {
  it("lists them and exports them", async () => {
    const row = {
      source: "app", ledger_id: "l1", claim_id: "c1", ticket: "FP-2026-000016", staff_id: "S1", name: "Dr Revathi",
      department: "AIDS", paper_title: "A study of SRAM", journal: "Sensors", voucher: "PV-1", amount: 7600,
      authorised_on: "2026-08-30", paid_on: "2026-09-02", held_back: 0, figures: FIGURES,
    }
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/payouts/months": () => ({ months: [{ month: "2026-09", label: "September 2026", amount: 7600, count: 1 }] }),
        "/api/payouts/statement": () => ({
          month: "2026-09", label: "September 2026", college: "College", count: 1, people: 1, total: 7600,
          ledger_total: 7600, total_in_words: "Rupees Seven Thousand Six Hundred only",
          by_department: [{ department: "AIDS", amount: 7600, count: 1 }], rows: [row],
          reconciliation: { app_tickets: 1, matched: 1, imported: { count: 0, amount: 0 }, reversals: { count: 0, amount: 0 }, month_not_recorded: 0, issues: [], balanced: true },
        }),
        "/api/payouts/bank-exports": () => ({ month: "2026-09", exports: [], new_count: 1, new_total: 7600, all_count: 1, all_total: 7600 }),
        "/api/payouts/financial-year": () => ({ financial_year: "2026-27", allocation: 2_000_000, paid: 7600, committed: 0, months: [] }),
      })
    )
    const user = userEvent.setup()
    renderWithProviders(<Statements />)
    expect(await screen.findByText("Dr Revathi")).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Category (Engineering / Non-engineering)" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Amount paid" })).toBeInTheDocument()
    expect(screen.getAllByText("Non-engineering").length).toBeGreaterThan(0)
    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByRole("menuitem", { name: "CSV" }))
    await waitFor(() => expect(exportTable).toHaveBeenCalled())
    const payload = vi.mocked(exportTable).mock.calls[0][0]
    const labels = payload.columns.map((c) => c.label)
    expect(labels).toEqual(expect.arrayContaining(["Title", "Journal name", "ISSN", "Quartile", "SNIP", "Total number of authors", "Author position", "Amount paid"]))
    const total = payload.rows[payload.rows.length - 2]
    expect(total[0]).toBe("Total of 1 payment")
    expect(total[labels.indexOf("Amount paid")]).toBe(7600)
  })
})
