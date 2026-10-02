import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Safeguards } from "@/pages/safeguards"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const check = (key: string, count: number, extra: object = {}) => ({
  key,
  group: "Paying twice",
  title: `Title of ${key}`,
  severity: "error",
  scope: "money",
  count,
  rows: [],
  help: `Help for ${key}`,
  fix_to: "",
  fix_label: "",
  status: count ? "problem" : "ok",
  ...extra,
})

const report = (checks: ReturnType<typeof check>[], problems = { error: 0, warning: 0, info: 0 }) => ({
  ran_at: new Date().toISOString(),
  seconds: 0.4,
  by: "The nightly check",
  problems,
  checks,
  history: [],
})

describe("Safeguards", () => {
  it("answers in one sentence, lists only what failed with its items and fix, and folds the clean checks", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/safeguards": () => ({
          scope: "all",
          can_run: true,
          report: report(
            [
              check("paid_no_ledger", 2, {
                fix_to: "/ledger?problem=no-ledger",
                fix_label: "Fix on the ledger",
                rows: [{ id: "c1", label: "FP-2026-000001 A paper (Asha)", href: "/papers/c1" }],
              }),
              check("dup_payment", 0),
              check("bank_reexport", 0, { severity: "info" }),
            ],
            { error: 1, warning: 0, info: 0 }
          ),
        }),
      })
    )
    renderWithProviders(<Safeguards />)
    expect(await screen.findByRole("status")).toHaveTextContent("1 check found a problem")
    expect(screen.getByText("Title of paid_no_ledger")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Fix on the ledger" })).toHaveAttribute("href", "/ledger?problem=no-ledger")
    // Items are one step away, with a count that says what is behind the door.
    await userEvent.click(screen.getByRole("button", { name: /Show the items\s*\(2\)/ }))
    expect(screen.getByRole("link", { name: /FP-2026-000001/ })).toHaveAttribute("href", "/papers/c1")
    // The clean ones are one line, not a row each.
    expect(screen.queryByText("Title of dup_payment")).toBeNull()
    expect(screen.getByRole("button", { name: /Show the checks that found nothing\s*\(2\)/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument()
  })

  it("says every rule held when nothing was found", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/safeguards": () => ({ scope: "all", can_run: true, report: report([check("dup_payment", 0)]) }),
      })
    )
    renderWithProviders(<Safeguards />)
    expect(await screen.findByRole("status")).toHaveTextContent("Every payment rule held")
    expect(screen.getByText(/No payment was doubled/)).toBeInTheDocument()
  })

  it("gives Finance the payment view: no Check now, and nothing about doubts over papers", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/safeguards": () => ({
          scope: "money",
          can_run: false,
          report: report([check("paid_no_ledger", 1)], { error: 1, warning: 0, info: 0 }),
        }),
      })
    )
    renderWithProviders(<Safeguards />)
    expect(await screen.findByRole("status")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull()
    expect(screen.getByText(/stop money going out twice/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/flag|warning set aside|co-author/i)
  })

  it("says so plainly before the first run, and offers the run to a super admin", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => ADMIN, "/api/safeguards": () => ({ scope: "all", can_run: true, report: null }) })
    )
    renderWithProviders(<Safeguards />)
    const said = await screen.findByRole("status")
    expect(within(said).getByText("have not run")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument()
  })
})
