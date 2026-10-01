import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { ApiError, api } from "@/lib/api"
import { Calculator } from "@/pages/calculator"
import { fakeApi, HOD, FACULTY, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }
const FIN: Me = { id: "u-f", email: "f@x.edu", name: "Fin", role: "FINANCE", department: null }

const OPTIONS = {
  policies: [
    { id: "p2", name: "Policy v2", version: 2, label: "Policy v2", in_force: true, effective_from: null },
    { id: "p1", name: "Policy v1", version: 1, label: "Policy v1", in_force: false, effective_from: "2025-06-01" },
  ],
  in_force: { id: "p2", name: "Policy v2", version: 2, label: "Policy v2", in_force: true, effective_from: null },
  publication_types: ["Journal", "Conference Proceeding"],
  quartiles: ["Q1", "Q2", "Q3", "Q4"],
  limits: { max_authors: 9, min_sec_references: 2, student_project_amount: 15000 },
}

const PRICE = {
  ok: true,
  policy: OPTIONS.in_force,
  amount: 52750,
  full: 52750,
  paper_value: 105500,
  category: "I",
  category_label: "Category I: Scopus indexed, with SNIP",
  problem: null,
  sentence: "For author 1 of 2, under Policy v2, the policy in force now.",
  zero_reason: null,
  working: [
    { key: "rate", label: "Which rate applies", text: "Category I: Scopus indexed, with SNIP", amount: null },
    { key: "snip", label: "SNIP part", text: "SNIP 1 x ₹55,000 for each point of SNIP.", amount: 55000 },
    { key: "value", label: "Value of the whole paper", text: "Before it is shared between the authors.", amount: 105500 },
  ],
  authors: [],
  college_total: null,
  threshold: null,
  cautions: [],
}

function priceCalls() {
  return vi.mocked(api).mock.calls.filter((c) => c[0] === "/api/calculator/price")
}

function serve(me: Me, extra: Record<string, (p: string) => unknown> = {}, price: unknown = PRICE) {
  const table = fakeApi({
    "/api/auth/me": () => me,
    "/api/calculator/options": () => OPTIONS,
    ...extra,
  })
  vi.mocked(api).mockImplementation(((path: string, opts?: { method?: string }) => {
    if (path === "/api/calculator/price" && opts?.method === "POST") return Promise.resolve(price)
    return table(path)
  }) as never)
}

describe("the incentive calculator", () => {
  it("is not open to a head of department or a faculty member", async () => {
    for (const me of [HOD, FACULTY]) {
      serve(me)
      const { unmount } = renderWithProviders(<Calculator />, { route: "/calculator" })
      expect(await screen.findByText("Not open to this account")).toBeTruthy()
      expect(screen.queryByRole("tab", { name: "Price a paper" })).toBeNull()
      expect(vi.mocked(api).mock.calls.some((c) => String(c[0]).startsWith("/api/calculator"))).toBe(false)
      unmount()
    }
  })

  describe("price a paper", () => {
    it("shows the server's amount in large type with the working, and posts the form's inputs", async () => {
      serve(ADMIN)
      renderWithProviders(<Calculator />, { route: "/calculator" })
      const amount = await screen.findByTestId("calc-amount")
      expect(amount.textContent).toBe("₹52,750")
      expect(screen.getByTestId("calc-sentence").textContent).toContain("under Policy v2")
      expect(screen.getByText("SNIP part")).toBeTruthy()
      expect(screen.getByText("₹1,05,500")).toBeTruthy()
      await waitFor(() => expect(priceCalls().length).toBeGreaterThan(0))
      const body = (priceCalls()[0][1] as { json: Record<string, unknown> }).json
      expect(body).toMatchObject({ publication_type: "Journal", total_authors: 1, positions: [1], student_project: false })
    })

    it("sends a change of inputs to the server instead of working it out itself", async () => {
      serve(ADMIN)
      renderWithProviders(<Calculator />, { route: "/calculator" })
      await screen.findByTestId("calc-amount")
      await userEvent.type(screen.getByLabelText("SNIP"), "1.85")
      await userEvent.clear(screen.getByLabelText("Total authors"))
      await userEvent.type(screen.getByLabelText("Total authors"), "3")
      await userEvent.click(screen.getByRole("button", { name: "Author 2" }))
      await userEvent.click(screen.getByLabelText(/Final-year student project/))
      await waitFor(() => {
        const last = priceCalls().at(-1)?.[1] as { json: Record<string, unknown> } | undefined
        expect(last?.json).toMatchObject({ snip: 1.85, total_authors: 3, positions: [1, 2], student_project: true })
      })
    })

    it("offers every policy version and posts the chosen one", async () => {
      serve(ADMIN)
      renderWithProviders(<Calculator />, { route: "/calculator" })
      await screen.findByTestId("calc-amount")
      const select = screen.getByLabelText("Policy version")
      expect(within(select).getByText("Policy v2, in force now")).toBeTruthy()
      await userEvent.selectOptions(select, "p1")
      await waitFor(() => {
        const last = priceCalls().at(-1)?.[1] as { json: Record<string, unknown> }
        expect(last.json.policy_id).toBe("p1")
      })
    })

    it("says why a paper pays nothing where the amount would be", async () => {
      serve(ADMIN, {}, {
        ...PRICE,
        amount: 0,
        zero_reason: "Only 1 SEC-affiliated reference cited; the policy requires 2.",
        sentence: "Only 1 SEC-affiliated reference cited; the policy requires 2.",
        working: [],
      })
      renderWithProviders(<Calculator />, { route: "/calculator" })
      expect((await screen.findByTestId("calc-amount")).textContent).toBe("₹0")
      expect(screen.getByTestId("calc-sentence").textContent).toContain("requires 2")
    })

    it("lists each college author's share with a total", async () => {
      serve(ADMIN, {}, {
        ...PRICE,
        authors: [
          { position: 1, point: 0.4, incentive: 42200, problem: null },
          { position: 3, point: 0.2, incentive: 21100, problem: null },
        ],
        college_total: 63300,
      })
      renderWithProviders(<Calculator />, { route: "/calculator" })
      await screen.findByTestId("calc-amount")
      expect(await screen.findByText("Author 3")).toBeTruthy()
      expect(screen.getByText("₹63,300")).toBeTruthy()
    })

    it("never blocks on a prefill that fails", async () => {
      serve(ADMIN, { "/api/calculator/prefill": () => { throw new ApiError(502, "Scopus down") } })
      renderWithProviders(<Calculator />, { route: "/calculator" })
      await screen.findByTestId("calc-amount")
      await userEvent.type(screen.getByLabelText(/Start from a claim no/), "10.1000/x")
      await userEvent.click(screen.getByRole("button", { name: "Fill the form" }))
      expect(await screen.findByText(/Enter the figures by hand/)).toBeTruthy()
      expect(screen.getByTestId("calc-amount").textContent).toBe("₹52,750")
    })

    it("fills the form from a claim's stored inputs", async () => {
      serve(ADMIN, {
        "/api/calculator/prefill": () => ({
          kind: "claim",
          message: "Filled from claim FP-2026-000001.",
          inputs: {
            publication_type: "Conference Proceeding", indexing_level: "SCI, Scopus", quartile: "Q3", snip: 0.4,
            engineering_class: "Engineering", total_authors: 5, author_position: 3, student_project: false, counted_only: false,
          },
        }),
      })
      renderWithProviders(<Calculator />, { route: "/calculator" })
      await screen.findByTestId("calc-amount")
      await userEvent.type(screen.getByLabelText(/Start from a claim no/), "fp 2026 1")
      await userEvent.click(screen.getByRole("button", { name: "Fill the form" }))
      await waitFor(() => {
        const last = priceCalls().at(-1)?.[1] as { json: Record<string, unknown> }
        expect(last.json).toMatchObject({
          publication_type: "Conference Proceeding", indexing_level: "Scopus, SCIE", quartile: "Q3", snip: 0.4,
          total_authors: 5, positions: [3],
        })
      })
    })
  })

  describe("check a claim", () => {
    const CHECK = {
      claim: {
        id: "c1", ticket_number: "FP-2026-000123", imported: false, title: "A paper", journal: "J", status: "Paid",
        month: "2026-09", user_id: "u9", name: "Asha Rao", department: "ECE",
      },
      inputs: {
        publication_type: "Journal", indexing_level: "Scopus", quartile: "Q1", snip: 1, engineering_class: "Engineering",
        total_authors: 2, author_position: 1, student_project: false, counted_only: false, sec_references: 2,
        priced_category: "Category I: Scopus indexed, with SNIP",
      },
      recorded: { amount: 40000, absorbed: 0, policy_amount: 40000, note: null },
      under_snapshot: { policy: "Policy v1", in_force: false, amount: 42200, paper_value: 84400, category: "Category I", note: null, problem: null },
      under_today: { policy: "Policy v2", in_force: true, amount: 45000, paper_value: 90000, category: "Category I", note: null, problem: null, payable: 45000 },
      ledger: { total: 40000, rows: [{ month: "2026-09", voucher: "V-1", amount: 40000 }] },
      differences: [
        {
          key: "recorded", cause: "manual_override", cause_label: "Amount entered by hand", expected: false,
          compare: "Recorded ₹40,000 against ₹42,200 under Policy v1", delta: -2200,
          text: "Admin entered this amount by hand on 2026-09-02 (From voucher 77), so it is no longer the formula's figure.",
        },
        {
          key: "policy", cause: "policy_changed", cause_label: "The policy has changed since", expected: true,
          compare: "₹42,200 under Policy v1, ₹45,000 under Policy v2", delta: 2800,
          text: "It agrees with the policy it was priced under.",
        },
      ],
      agrees: false,
      headline: "The recorded amount is ₹2,200 less than the policy gives.",
      delta: -2200,
    }

    it("asks the server for the claim and shows the four figures side by side", async () => {
      serve(ADMIN, { "/api/calculator/claim": () => CHECK })
      renderWithProviders(<Calculator />, { route: "/calculator?tab=claim&q=fp%202026%20123" })
      expect((await screen.findByTestId("check-headline")).textContent).toContain("₹2,200 less")
      const call = vi.mocked(api).mock.calls.find((c) => String(c[0]).startsWith("/api/calculator/claim"))
      expect(String(call?.[0])).toContain("q=fp%202026%20123")
      const group = screen.getByRole("group", { name: "At a glance" })
      for (const t of ["₹40,000", "₹42,200", "₹45,000"]) expect(within(group).getAllByText(t).length).toBeGreaterThan(0)
      expect(within(group).getAllByText(/Formula under Policy v1/).length).toBeGreaterThan(0)
      expect(within(group).getAllByText(/Formula under Policy v2, in force now/).length).toBeGreaterThan(0)
    })

    it("names each difference by its cause and says which are expected", async () => {
      serve(ADMIN, { "/api/calculator/claim": () => CHECK })
      renderWithProviders(<Calculator />, { route: "/calculator?tab=claim&q=FP-2026-000123" })
      expect(await screen.findByText("Amount entered by hand")).toBeTruthy()
      expect(screen.getByText("Needs a look")).toBeTruthy()
      expect(screen.getByText("The policy has changed since")).toBeTruthy()
      expect(screen.getByText("Expected")).toBeTruthy()
      expect(screen.getByText(/From voucher 77/)).toBeTruthy()
      // Links, never a change: the calculator only reads.
      expect(screen.getByRole("link", { name: "Why this amount" }).getAttribute("href")).toBe("/track?why=c1")
      expect(screen.getByRole("link", { name: "Fix it on the claim" }).getAttribute("href")).toBe("/review/c1")
      expect(screen.queryByRole("button", { name: /save|apply/i })).toBeNull()
    })

    it("sends imported claims with no amount to the fix queue, and only a super admin sees the fix", async () => {
      const erp = {
        ...CHECK,
        under_snapshot: null,
        differences: [{ ...CHECK.differences[0], cause: "imported_no_amount", cause_label: "Imported with no amount" }],
      }
      serve(ADMIN, { "/api/calculator/claim": () => erp })
      const first = renderWithProviders(<Calculator />, { route: "/calculator?tab=claim&q=ERP-PROCESSED-9" })
      expect(await screen.findByRole("link", { name: "Fix it in the imported-claims queue" })).toBeTruthy()
      expect(screen.getAllByText(/keeps no record of it/).length).toBeGreaterThan(0)
      first.unmount()
      serve(FIN, { "/api/calculator/claim": () => erp })
      renderWithProviders(<Calculator />, { route: "/calculator?tab=claim&q=ERP-PROCESSED-9" })
      expect(await screen.findByTestId("check-headline")).toBeTruthy()
      expect(screen.queryByRole("link", { name: /Fix it/ })).toBeNull()
    })

    it("says so when no claim has the number", async () => {
      serve(ADMIN, { "/api/calculator/claim": () => { throw new ApiError(404, "No claim has that number.") } })
      renderWithProviders(<Calculator />, { route: "/calculator?tab=claim&q=FP-2026-999999" })
      expect(await screen.findByText("No claim has that number")).toBeTruthy()
    })
  })

  describe("check many", () => {
    const ROW = {
      id: "c1", ticket_number: "ERP-PROCESSED-510", imported: true, user_id: "u9", name: "Asha Rao", department: "IT",
      title: "A deep paper", status: "Paid", month: "2026-09", recorded: 0, policy_amount: 0, formula: 145480,
      difference: -145480, policy: "Policy v1", cause: "imported_no_amount", cause_label: "Imported with no amount",
      cause_text: "The old ERP's workbook marked this paid but carried no amount.", fix: "data",
    }
    const MANY = {
      stages: ["approved", "authorised", "paid"],
      policy: "Policy v1",
      totals: {
        checked: 81, agree: 17, differ: 53, over: 0, under: 911718.39, net: -911718.39, left_out: 11,
        threshold_claims: 0, threshold_total: 0, policy_moved: 0, ledger_differs: 0,
      },
      causes: [{ cause: "imported_no_amount", label: "Imported with no amount", count: 53, over: 0, under: 911718.39 }],
      rows: [ROW],
      row_total: 53,
      listed: { count: 53, recorded: 0, formula: 911718.39, difference: -911718.39 },
      departments: ["IT", "ECE"],
      months: ["2026-09"],
      limit: 100,
      offset: 0,
    }

    it("answers first: how many differ, and by how much each way", async () => {
      serve(ADMIN, { "/api/calculator/many": () => MANY })
      renderWithProviders(<Calculator />, { route: "/calculator?tab=many" })
      const group = await screen.findByRole("group", { name: "At a glance" })
      expect(within(group).getByText("81")).toBeTruthy()
      expect(within(group).getByText("53")).toBeTruthy()
      expect(within(group).getByText("₹9,11,718.39")).toBeTruthy()
      expect(screen.getByTestId("many-note").textContent).toContain("53 of 81 claims")
      expect(screen.getByTestId("many-note").textContent).toContain("below the formula")
    })

    it("lists each claim with its cause, a link to the fix queue and a total", async () => {
      serve(ADMIN, { "/api/calculator/many": () => MANY })
      renderWithProviders(<Calculator />, { route: "/calculator?tab=many" })
      const table = await screen.findByRole("table", { name: /differs from the formula/ })
      expect(within(table).getByText("Imported with no amount")).toBeTruthy()
      expect(within(table).getByRole("link", { name: "Fix imported claims" }).getAttribute("href")).toBe(
        "/data/fixes?kind=paid_no_amount"
      )
      expect(within(table).getByText("₹1,45,480 less")).toBeTruthy()
      expect(within(table).getByText(/Total, 53 claims/)).toBeTruthy()
      expect(screen.getByRole("link", { name: /Download 53 rows/ }).getAttribute("href")).toContain("/api/calculator/many.csv?")
    })

    it("sends the filters to the server and shows the departments it returned", async () => {
      serve(ADMIN, { "/api/calculator/many": () => MANY })
      renderWithProviders(<Calculator />, { route: "/calculator?tab=many" })
      await screen.findByRole("table", { name: /differs/ })
      await userEvent.selectOptions(screen.getByLabelText("Department"), "IT")
      await userEvent.selectOptions(screen.getByLabelText("Month"), "2026-09")
      await userEvent.click(screen.getByLabelText("Include claims still being checked"))
      await waitFor(() => {
        const last = vi.mocked(api).mock.calls.filter((c) => String(c[0]).startsWith("/api/calculator/many")).at(-1)
        const url = String(last?.[0])
        expect(url).toContain("department=IT")
        expect(url).toContain("month=2026-09")
        expect(url).toContain("submitted=true")
      })
    })

    it("says every claim agrees when none differs", async () => {
      serve(ADMIN, {
        "/api/calculator/many": () => ({
          ...MANY,
          totals: { ...MANY.totals, differ: 0, under: 0, net: 0, agree: 81 },
          causes: [],
          rows: [],
          row_total: 0,
          listed: { count: 0, recorded: 0, formula: 0, difference: 0 },
        }),
      })
      renderWithProviders(<Calculator />, { route: "/calculator?tab=many" })
      expect(await screen.findAllByText("Every claim agrees with its price")).toBeTruthy()
    })

    it("names the failure and offers a retry when the check cannot load", async () => {
      serve(ADMIN, { "/api/calculator/many": () => { throw new ApiError(500, "boom") } })
      renderWithProviders(<Calculator />, { route: "/calculator?tab=many" })
      expect(await screen.findByText("Could not load the check")).toBeTruthy()
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
    })
  })
})
