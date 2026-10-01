import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Data } from "@/pages/data"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }
const t = (name: string, label: string, rows: number, editable = false) => ({
  name, label, about: `About ${label}`, group: "The scheme", rows, columns: 5, editable,
})

describe("the data index", () => {
  it("says how much is here, and finds a table by typing", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/admin/data/tables": () => ({
          note: "Editing is limited to reference data.",
          tables: [t("Claim", "Claims", 1200), t("PaidLedger", "Payment ledger", 3043), t("Budget", "Budgets", 4, true)],
        }),
      })
    )
    renderWithProviders(<Data />, { route: "/data" })
    expect(await screen.findByText(/3 tables holding 4,247 rows/)).toBeTruthy()
    expect(screen.getByText(/1 can be corrected here/)).toBeTruthy()
    await userEvent.type(screen.getByLabelText("Find a table"), "ledger")
    expect(screen.getByText("Payment ledger")).toBeTruthy()
    expect(screen.queryByText("Claims")).toBeNull()
  })
})
