import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Audit, collapseRuns } from "@/pages/audit"
import { fakeApi, renderWithProviders } from "@/test/harness"

/**
 * The log's first screen was fifty-three identical "claim flag raise" rows and
 * nothing about the import that built the record.
 */
const ADMIN: Me = { id: "a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const flag = (id: string, at: string) => ({
  id,
  action: "CLAIM_FLAG_RAISE",
  entity: "ClaimFlag",
  entity_id: null,
  actor: null,
  detail_json: null,
  created_at: at,
})

describe("collapseRuns", () => {
  it("folds a run of the same automatic entry in the same minute into one row", () => {
    const rows = [
      flag("1", "2026-09-24T00:34:58.8Z"),
      flag("2", "2026-09-24T00:34:58.7Z"),
      flag("3", "2026-09-24T00:34:10.0Z"),
      { ...flag("4", "2026-09-24T00:34:05.0Z"), actor: "someone@x.edu" },
    ]
    const out = collapseRuns(rows)
    expect(out.map((r) => [r.id, r.repeat])).toEqual([
      ["1", 3],
      ["4", 1],
    ])
  })
})

describe("Audit — the first screen", () => {
  it("says where the record came from before the list", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/admin/audit/origins": () => ({
          events: [
            {
              at: "2026-09-23T07:05:28Z",
              title: "Claims brought across from the ERP workbook",
              detail: "81 from the Processed sheet, 13 from Raw_Data (the Google Form's sheet)",
              by: null,
            },
          ],
        }),
        "/api/admin/audit?": () => ({
          total: 2,
          limit: 50,
          offset: 0,
          results: [flag("1", "2026-09-24T00:34:58Z"), flag("2", "2026-09-24T00:34:58Z")],
        }),
      })
    )
    renderWithProviders(<Audit />, { route: "/audit" })
    // Where the record came from is one step away, with how many entries are behind it.
    await userEvent.click(await screen.findByRole("button", { name: /where the record came from/i }))
    expect(screen.getByText(/81 from the Processed sheet/)).toBeInTheDocument()
    expect((await screen.findAllByText(/× 2/)).length).toBeGreaterThan(0)
  })

  it("tells each entry in words: who, what, from what to what", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/admin/audit/origins": () => ({ events: [] }),
        "/api/admin/audit/actions": () => ({ actions: [{ value: "CLAIM_DATA_FIX", label: "Corrected the record" }] }),
        "/api/admin/audit?": () => ({
          total: 1,
          limit: 50,
          offset: 0,
          summary: { last_week: 1, by_people: 1, by_system: 0 },
          results: [
            {
              id: "e1",
              action: "CLAIM_DATA_FIX",
              entity: "Claim",
              entity_id: "c1",
              actor: "a@x.edu",
              detail_json: null,
              created_at: "2026-09-24T00:34:58Z",
              who: { user_id: "u1", name: "Ravi Kumar" },
              what: "corrected the record",
              changes: [{ label: "Amount", from: "₹0", to: "₹18,500" }],
              reason: "From the register",
              record: { kind: "Claim", id: "c1", label: "Claim ERP-PROCESSED-9" },
            },
          ],
        }),
      })
    )
    renderWithProviders(<Audit />, { route: "/audit" })
    expect(await screen.findByText("Ravi Kumar")).toBeInTheDocument()
    expect(screen.getByText("corrected the record")).toBeInTheDocument()
    expect(screen.getByText("₹18,500")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Claim ERP-PROCESSED-9" }).getAttribute("href")).toBe("/papers/c1")
    // No raw code is shown on the row.
    expect(screen.queryByText("CLAIM_DATA_FIX")).toBeNull()
  })
})
