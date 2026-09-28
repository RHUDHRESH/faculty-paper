import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Policy } from "@/pages/policy"
import { fakeApi, FINANCE, renderWithProviders } from "@/test/harness"

/**
 * The filing cutoff is a policy setting: the day of the month filing closes
 * for that month's payment run. The deadline reminder is only ever sent once
 * the college has set one.
 */

const FORMULA = {
  id: "f1",
  name: "Policy v3",
  version: 3,
  snip_multiplier: 10000,
  snip_cap: 50000,
  qf_q1: 10000,
  qf_q2: 7500,
  qf_q3: 5000,
  qf_q4: 2500,
  qf_no_snip: 0,
  qf_snip_only: 0,
  qf_others: 0,
  author_point_json: JSON.stringify({ "1": [1], "2": [0.6, 0.4] }),
  publication_type_multipliers_json: JSON.stringify({ Journal: 1 }),
  student_remuneration_zero: false,
  qf_only_for_no_snip: false,
  high_value_threshold: 0,
  fixed_journal_no_snip: 3000,
  fixed_other_no_snip: 2000,
  fixed_web_of_science: 5000,
  max_authors: 9,
  min_sec_references: 2,
  filing_cutoff_day: null,
  notes: "",
}

describe("the filing cutoff on the policy page", () => {
  it("says when none is set, and publishes the day that is chosen", async () => {
    vi.mocked(api).mockReset()
    const fake = fakeApi({
      "/api/auth/me": () => FINANCE,
      "/api/admin/formula": () => ({ ...FORMULA, version: 4, name: "Policy v4" }),
      "/api/calculate": () => ({}),
    })
    vi.mocked(api).mockImplementation(((path: string, options?: { method?: string }) =>
      options?.method === "PUT" ? fake(path) : path === "/api/admin/formula" ? Promise.resolve(FORMULA) : fake(path)) as typeof api)
    renderWithProviders(<Policy />, { route: "/policy" })
    expect(await screen.findByText("No cutoff set; nobody is reminded")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Publish a new version/ }))
    const dialog = await screen.findByRole("dialog")
    const cutoff = within(dialog).getByLabelText(/Filing cutoff day/)
    await userEvent.clear(cutoff)
    await userEvent.type(cutoff, "25")
    expect(within(dialog).getByText(/Publishing makes v4 active/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: /^Publish…$/ }))
    const confirm = await screen.findByRole("dialog", { name: /Make v4 the active policy/ })
    await userEvent.type(within(confirm).getByRole("textbox"), "v4")
    await userEvent.click(within(confirm).getByRole("button", { name: "Publish v4" }))
    await waitFor(() => {
      const put = vi.mocked(api).mock.calls.find(([, o]) => (o as { method?: string })?.method === "PUT")
      expect(put?.[1]).toMatchObject({ json: { filing_cutoff_day: 25 } })
    })
  })
})
