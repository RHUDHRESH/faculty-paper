import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Requests } from "@/pages/requests"
import { fakeApi, renderWithProviders } from "@/test/harness"

/**
 * The super admin's queue: a role or research-standing request reads as the
 * person would say it, and approving sends the decision the server applies.
 */

const SUPER_ADMIN: Me = {
  id: "u-admin",
  email: "admin@example.edu",
  name: "Office Admin",
  role: "SUPER_ADMIN",
  department: null,
}

function request(over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    field: "role",
    label: "Role",
    current_value: "FACULTY",
    proposed_value: "HOD",
    value_now: "FACULTY",
    note: "Appointed head from June",
    status: "PENDING",
    identity: true,
    requested_by: {
      id: "u-2",
      name: "Dr Asha Menon",
      email: "asha@example.edu",
      department: "CSE",
      staff_id: "STF-2",
    },
    decided_by: null,
    decided_at: null,
    decision_note: "",
    created_at: "2026-03-05T10:00:00+05:30",
    ...over,
  }
}

function mount(rows = [request()]) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => SUPER_ADMIN,
      "/api/admin/profile-requests?": () => ({ results: rows, pending: rows.length }),
      "/api/admin/profile-requests/r-1": () => ({ ok: true, request: { ...rows[0], status: "APPROVED" } }),
    })
  )
  renderWithProviders(<Requests />, { route: "/admin/profile-requests" })
  return userEvent.setup()
}

describe("Requests — account requests", () => {
  it("names a role the way a person would, not by its code", async () => {
    mount()
    const item = (await screen.findByText("Role")).closest("li") as HTMLElement
    expect(within(item).getByText("Faculty")).toBeInTheDocument()
    expect(within(item).getByText("Head of department")).toBeInTheDocument()
    expect(within(item).queryByText("HOD")).toBeNull()
    expect(within(item).getByText("Super admin only")).toBeInTheDocument()
  })

  it("reads a quota as papers a year", async () => {
    mount([
      request({
        field: "research_quota",
        label: "Research quota",
        current_value: "4",
        proposed_value: "2",
        value_now: "4",
      }),
    ])
    const item = (await screen.findByText("Research quota")).closest("li") as HTMLElement
    expect(within(item).getByText("4 papers a year")).toBeInTheDocument()
    expect(within(item).getByText("2 papers a year")).toBeInTheDocument()
  })

  it("approves by sending the decision the server applies", async () => {
    const user = mount()
    await user.click(await screen.findByRole("button", { name: "Approve" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("Head of department")
    await user.click(within(dialog).getByRole("button", { name: "Approve" }))
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/admin/profile-requests/r-1", {
        method: "POST",
        json: { approve: true },
      })
    )
  })
})
