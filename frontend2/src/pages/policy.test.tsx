import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Policy } from "@/pages/policy"
import { fakeApi, renderWithProviders } from "@/test/harness"
import type { Me } from "@/app/auth"

/**
 * The final-year project scheme's amount is a policy number like the others:
 * read on the policy sheet, and changed only by publishing a new version.
 */

const SUPER: Me = {
  id: "u-super",
  email: "super@example.edu",
  name: "S Admin",
  role: "SUPER_ADMIN",
  department: null,
}

const FORMULA = {
  id: "f1",
  name: "Policy v1",
  version: 1,
  effective_from: "2026-01-01",
  effective_to: null,
  snip_multiplier: 55000,
  snip_cap: 30,
  qf_q1: 50000,
  qf_q2: 30000,
  qf_q3: 15000,
  qf_q4: 7000,
  qf_no_snip: 0,
  qf_snip_only: 0,
  qf_others: 0,
  author_point_json: JSON.stringify({ "1": [1], "2": [0.6, 0.4] }),
  publication_type_multipliers_json: JSON.stringify({ Journal: 1, "Conference Proceeding": 1 }),
  student_remuneration_zero: true,
  qf_only_for_no_snip: true,
  high_value_threshold: 0,
  fixed_journal_no_snip: 5000,
  fixed_other_no_snip: 4000,
  fixed_web_of_science: 5000,
  max_authors: 9,
  min_sec_references: 2,
  student_project_amount: 15000,
  notes: null,
}

function mount() {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => SUPER,
      "/api/admin/formula": () => FORMULA,
      "/api/calculate": () => ({
        base: 5000, point: 1, remuneration: 5000, qf: 0, error: null, note: null,
      }),
    })
  )
  return renderWithProviders(<Policy />, { route: "/policy" })
}

describe("the quartile amounts", () => {
  // FORMULA carries qf_only_for_no_snip: true, the dead flag that made this
  // page say quartile amounts replace the SNIP amount. The calculator adds them.
  it("says they are added to the SNIP amount, as the calculator pays them", async () => {
    mount()
    expect(await screen.findByText(/Added on top of the SNIP amount/)).toBeInTheDocument()
    expect(screen.queryByText(/Used only when no SNIP is held/)).toBeNull()
  })

  it("no longer offers the switch the calculator never read", async () => {
    const user = userEvent.setup({ delay: null })
    mount()
    await user.click(await screen.findByRole("button", { name: "Publish a new version" }))
    await screen.findByRole("dialog")
    expect(screen.queryByRole("checkbox", { name: /apply only when no SNIP/ })).toBeNull()
  })
})

describe("the final-year project scheme on the policy sheet", () => {
  it("shows the fixed amount per team per conference paper", async () => {
    mount()
    const section = (await screen.findByText("Final-year project scheme")).closest("section")
    expect(section).not.toBeNull()
    expect(within(section as HTMLElement).getByText("₹15,000")).toBeInTheDocument()
  })

  // The editor is the largest dialog in the app, and this walks it end to end
  // -- open, edit, publish, type the version, confirm. Alone it takes about a
  // second; beside sixteen other files in parallel it passed the default five.
  it("publishes a changed amount with the new version", { timeout: 20_000 }, async () => {
    const user = userEvent.setup({ delay: null })
    mount()
    await user.click(await screen.findByRole("button", { name: /publish a new version/i }))
    const field = await screen.findByLabelText(/per team, per conference paper/i)
    await user.clear(field)
    await user.type(field, "18000")
    await user.click(screen.getByRole("button", { name: /^publish…$/i }))
    await user.type(await screen.findByRole("textbox", { name: /type v2 to confirm/i }), "v2")
    await user.click(screen.getByRole("button", { name: "Publish v2" }))

    await waitFor(() => {
      const put = vi
        .mocked(api)
        .mock.calls.find(
          ([p, o]) => p === "/api/admin/formula" && (o as { method?: string })?.method === "PUT"
        )
      expect(put).toBeDefined()
      expect((put![1] as { json: Record<string, unknown> }).json.student_project_amount).toBe(18000)
    })
  })
})
