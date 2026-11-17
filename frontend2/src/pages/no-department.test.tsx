import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { NoDepartment } from "@/pages/no-department"
import { failing, fakeApi, renderWithProviders } from "@/test/harness"

const PRINCIPAL: Me = { id: "u-p", email: "p@x.edu", name: "Principal", role: "PRINCIPAL", department: null }
const ROWS = [
  { id: "u1", name: "Dr. Asha", email: "asha@x.edu", role: "FACULTY", staff_id: "S1", designation: "" },
  { id: "u2", name: "Mr. Ravi", email: "ravi@x.edu", role: "FACULTY", staff_id: "", designation: "Professor" },
]

describe("Accounts with no department", () => {
  it("lists the accounts, with a quiet dash where a value is unknown, and no fix button for a reader", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => PRINCIPAL, "/api/admin/data-fill/accounts": () => ({ total: 2, rows: ROWS, can_fix: false }) })
    )
    renderWithProviders(<NoDepartment />)
    expect(await screen.findByRole("link", { name: "Dr. Asha" })).toHaveAttribute("href", "/faculty/u1")
    expect(screen.getByText(/2 accounts have no department/)).toBeInTheDocument()
    expect(screen.getAllByText("–").length).toBeGreaterThan(0)
    expect(screen.queryByRole("link", { name: "Fill from the faculty list" })).toBeNull()
  })

  it("shows the calm not-open gate when the API says 403", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => PRINCIPAL, "/api/admin/data-fill/accounts": failing(403, "Forbidden") }))
    renderWithProviders(<NoDepartment />)
    expect(await screen.findByRole("heading", { name: "Not open to this account" })).toBeInTheDocument()
  })
})
