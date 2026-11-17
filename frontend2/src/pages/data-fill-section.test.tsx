import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { DataFillSection } from "@/pages/data-fill-section"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const last = (rows: number, extra: object = {}) => ({
  gap_rows: rows + 2,
  rows,
  unresolved: 2,
  conflict_count: 0,
  conflicts: [],
  reasons: {},
  applied: false,
  checked_at: new Date().toISOString(),
  ...extra,
})

const TABLE = {
  checked_at: new Date().toISOString(),
  after_deploy: null,
  fixes: [
    { key: "user_department", label: "Department on accounts, from the faculty list", help: "h", kind: "write", safe: true,
      last: last(1240, { conflict_count: 1, conflicts: [{ row: "Dr A (S1)", id: "u1", field: "department", current: "CSE", incoming: "AI&DS" }] }) },
    { key: "ledger_journal_title", label: "Journal on payment rows", help: "h", kind: "write", safe: true, last: last(380) },
    { key: "issn_form", label: "Write ISSNs the standard way", help: "h", kind: "write", safe: true, last: null },
    { key: "authorship_department", label: "Department of authors with no account", help: "h", kind: "derived", safe: true, last: last(50) },
  ],
}

function mount(calls: string[] = []) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(((path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path}`)
    return fakeApi({
      "/api/auth/me": () => ADMIN,
      "/api/admin/data-fill/apply": () => ({ ok: true, queued: true, job_id: "j1" }),
      "/api/admin/data-fill/check": () => TABLE,
      "/api/admin/data-fill": () => TABLE,
      "/api/admin/jobs/": () => ({ status: "done", result: { text: "Filled: 1,240 departments" } }),
    })(path)
  }) as never)
  renderWithProviders(<DataFillSection />)
  return userEvent.setup()
}

describe("Data health: fill the gaps", () => {
  it("shows each fix with how many rows it would fill, what is left, and a button only where one can apply", { timeout: 30000 }, async () => {
    mount()
    const row = (await screen.findByText("Department on accounts, from the faculty list")).closest("tr") as HTMLElement
    expect(within(row).getByText("1,240")).toBeInTheDocument()
    expect(within(row).getByRole("button", { name: "Apply" })).toBeEnabled()
    const never = screen.getByText("Write ISSNs the standard way").closest("tr") as HTMLElement
    expect(within(never).getByText("Not checked")).toBeInTheDocument()
    expect(within(never).getByRole("button", { name: "Apply" })).toBeDisabled()
    const derived = screen.getByText("Department of authors with no account").closest("tr") as HTMLElement
    expect(within(derived).queryByRole("button", { name: "Apply" })).toBeNull()
    expect(within(derived).getByText("Used in reports as they are made")).toBeInTheDocument()
  })

  it("lists where the files differ from the record, as left alone", async () => {
    const user = mount()
    await screen.findByText("Department on accounts, from the faculty list")
    await user.click(screen.getByRole("button", { name: /where the files differ from the record/i }))
    expect(await screen.findByText(/department is CSE, the files say AI&DS/)).toBeInTheDocument()
  })

  it("asks first, then queues one fix and follows the job", async () => {
    const calls: string[] = []
    const user = mount(calls)
    const row = (await screen.findByText("Journal on payment rows")).closest("tr") as HTMLElement
    await user.click(within(row).getByRole("button", { name: "Apply" }))
    expect(await screen.findByText(/This fills 380 records that are blank today/)).toBeInTheDocument()
    expect(calls.some((c) => c.startsWith("POST /api/admin/data-fill/apply"))).toBe(false)
    await user.click(screen.getByRole("button", { name: "Apply" }))
    await vi.waitFor(() => expect(calls).toContain("POST /api/admin/data-fill/apply?key=ledger_journal_title"), { timeout: 2000 })
  })

  it("has an Apply all safe fixes button that counts only what can be applied", async () => {
    const user = mount()
    await screen.findByText("Journal on payment rows")
    await user.click(screen.getByRole("button", { name: "Apply all safe fixes" }))
    expect(await screen.findByText(/This fills 1,620 records that are blank today/)).toBeInTheDocument()
  })
})
