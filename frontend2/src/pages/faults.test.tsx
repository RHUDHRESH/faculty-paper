import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Faults } from "@/pages/faults"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const fault = (key: string, count: number, severity: string, extra: object = {}) => ({
  key,
  title: `Title of ${key}`,
  detail: `Detail of ${key}`,
  count,
  severity,
  to: null,
  sample: [],
  ...extra,
})

const PAYLOAD = {
  total: 1234,
  urgent: 1000,
  checked_at: new Date().toISOString(),
  groups: [
    {
      key: "money",
      title: "Money",
      blurb: "",
      faults: [
        fault("paid_zero", 1000, "critical", { to: "/data/fixes?kind=amount", sample: ["ERP-PROCESSED-1"] }),
        fault("voided", 234, "info"),
        fault("no_ledger", 0, "critical"),
      ],
    },
  ],
}

describe("Faults", () => {
  it("shows real counts, never a capped number, and one button that says what it does", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => ADMIN, "/api/admin/faults": () => PAYLOAD }))
    renderWithProviders(<Faults />)
    expect((await screen.findAllByText("1,000")).length).toBeGreaterThan(0)
    expect(screen.queryByText(/99\+/)).toBeNull()
    expect(screen.getByRole("link", { name: "Fix 1,000 amounts" }).getAttribute("href")).toBe("/data/fixes?kind=amount")
    // A number from the old ERP explains itself once, in words.
    expect(screen.getByText(/start with ERP- were brought across/)).toBeTruthy()
    // A check that found nothing is one line at the foot, not a row of zeros.
    expect(screen.getByRole("button", { name: /Show the checks that found nothing\s*\(1\)/ })).toBeTruthy()
  })

  it("lists every claim behind a count, not a sample", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/admin/faults/paid_zero": () => ({
          key: "paid_zero",
          kind: "claims",
          total: 2,
          items: [
            { id: "c1", ticket_number: "ERP-PROCESSED-1", title: "-", journal: null, owner: { user_id: "u1", name: "Asha Rao" }, status: "PAID", amount: null, waiting_days: null, month_paid: null },
            { id: "c2", ticket_number: "ERP-PROCESSED-2", title: "Real paper", journal: null, owner: { user_id: "u2", name: "Ravi Kumar" }, status: "PAID", amount: 0, waiting_days: null, month_paid: null },
          ],
        }),
        "/api/admin/faults": () => PAYLOAD,
      })
    )
    renderWithProviders(<Faults />)
    await userEvent.click((await screen.findAllByRole("button", { name: /Show the whole list/ }))[0])
    expect((await screen.findAllByText("Asha Rao")).length).toBeGreaterThan(0)
    // A missing amount says so; it is not a blank cell or a dash.
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThan(0)
  })
})
