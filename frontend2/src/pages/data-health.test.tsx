import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { DataHealth } from "@/pages/data-health"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }
const finding = (key: string, count: number, extra: object = {}) => ({
  key,
  group: "Publications",
  title: `Title of ${key}`,
  severity: "warning",
  count,
  rows: [],
  fix: null,
  help: `Help for ${key}`,
  ...extra,
})

const HEALTH = {
  report: {
    ran_at: new Date().toISOString(),
    seconds: 4.7,
    problems: { error: 0, warning: 1250, info: 0 },
    findings: [
      finding("pub_venue_is_url", 1250, { fix: "clear_url_venues" }),
      finding("ledger_negative", 0),
      finding("orphan_files", 0),
    ],
  },
  fixes: { clear_url_venues: "Move web addresses out of journal names" },
  backups: [],
}

describe("Data health", () => {
  it("lists only what found something, with real counts, and warns when there is no backup", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => ADMIN, "/api/admin/data-health": () => HEALTH }))
    renderWithProviders(<DataHealth />)
    expect((await screen.findAllByText("1,250")).length).toBeGreaterThan(0)
    expect(screen.getByText("Title of pub_venue_is_url")).toBeTruthy()
    // Clean checks are behind one line, not a row each.
    expect(screen.queryByText("Title of ledger_negative")).toBeNull()
    expect(screen.getByRole("button", { name: /Show the checks that found nothing\s*\(2\)/ })).toBeTruthy()
    // No backup is a figure and an empty state, not a blank.
    expect(screen.getAllByText("No backup is stored").length).toBeGreaterThan(0)
  })

  it("asks before a fix and says how many records it changes", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => ADMIN, "/api/admin/data-health": () => HEALTH }))
    renderWithProviders(<DataHealth />)
    await userEvent.click(await screen.findByRole("button", { name: "Move web addresses out of journal names" }))
    expect(await screen.findByText(/This changes 1,250 stored records/)).toBeTruthy()
  })
})
