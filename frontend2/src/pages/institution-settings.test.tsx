import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { InstitutionSettings } from "@/pages/institution-settings"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

describe("institution settings", () => {
  it("shows how the sign-in screen will read as the name is typed", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/admin/settings": () => ({ college_name: "Saveetha Engineering College", sign_in_note: "", support_email: "" }),
      })
    )
    renderWithProviders(<InstitutionSettings />, { route: "/settings" })
    const name = await screen.findByLabelText("College name")
    await userEvent.clear(name)
    await userEvent.type(name, "Riverside College")
    expect(screen.getByText("Riverside College", { selector: "p" })).toBeTruthy()
    expect(screen.getByText("No support email is set.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
  })
})
