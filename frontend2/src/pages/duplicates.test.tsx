import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Duplicates } from "@/pages/duplicates"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

const CELL: Me = {
  id: "u-cell",
  email: "cell@example.edu",
  name: "R Cell",
  role: "RESEARCH_CELL",
  department: null,
}

const FINDING = {
  id: "dup-1",
  kind: "SAME_PERSON",
  status: "OPEN",
  matched_on: "doi",
  paper_title: "Crop yield prediction",
  faculty_name: "Dr Asha Menon",
  faculty_photo_url: null,
  payment_count: 2,
  total_amount: 20000,
  extra_amount: 10000,
  rows: [
    { source: "prior", id: "p1", reference: "V-1", title: "Crop yield prediction", doi: "10.1/x", amount: 10000, when: "2021-04", person: "Dr Asha Menon", department: null },
    { source: "prior", id: "p2", reference: "V-2", title: "Crop yield prediction", doi: "10.1/x", amount: 10000, when: "2022-06", person: "Dr Asha Menon", department: null },
  ],
  note: null,
  recovered_amount: null,
  reviewed_by_name: null,
  reviewed_at: null,
}

const PAYLOAD = {
  total: 1,
  limit: 25,
  offset: 0,
  results: [FINDING],
  summary: { open: 1, confirmed: 0, dismissed: 0, recovered: 0, at_issue: 10000, recovered_amount: 0 },
}

describe("the duplicates queue", () => {
  it("compares the payments side by side and marks what differs", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => CELL, "/api/admin/duplicate-findings": () => PAYLOAD })
    )
    renderWithProviders(<Duplicates />)
    const table = await screen.findByRole("table")
    const voucherRow = within(table).getByRole("row", { name: /Voucher/ })
    expect(within(voucherRow).getByText(/differs from payment 1/)).toBeInTheDocument()
    const amountRow = within(table).getByRole("row", { name: /Amount/ })
    expect(within(amountRow).queryByText(/differs/)).toBeNull()
  })

  it("rules out on r with a reason, confirming with the same verb", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => CELL,
        "/api/admin/duplicate-findings/dup-1": () => ({ ok: true, status: "DISMISSED" }),
        "/api/admin/duplicate-findings": () => PAYLOAD,
      })
    )
    const user = userEvent.setup()
    renderWithProviders(<Duplicates />)
    await screen.findByRole("table")
    await user.keyboard("r")
    const dialog = await screen.findByRole("dialog")
    const confirm = within(dialog).getByRole("button", { name: "Not a duplicate" })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByRole("textbox"), "Two different papers")
    await user.click(confirm)
    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([p]) => p === "/api/admin/duplicate-findings/dup-1")
      expect(call?.[1]).toMatchObject({
        method: "POST",
        json: { status: "DISMISSED", note: "Two different papers" },
      })
    })
  })

  it("is closed to Finance without asking the server", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => FINANCE }))
    renderWithProviders(<Duplicates />)
    expect(await screen.findByText("Not open to this account")).toBeInTheDocument()
    expect(
      vi.mocked(api).mock.calls.some(([p]) => String(p).includes("duplicate-findings"))
    ).toBe(false)
  })
})
