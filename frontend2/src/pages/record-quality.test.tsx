import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { RecordQuality } from "@/pages/record-quality"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const side = (id: string, claims: number) => ({
  id, title: "A paper recorded twice", year: 2024, doi: null, venue: "Journal", citations: 3,
  source: "SCOPUS", authors: 4, claims, preprint: false,
})
const pair = (n: number) => ({
  key: `p${n}`, reason: "DOI", reason_label: "Same DOI", keep: side(`k${n}`, 0), drop: side(`d${n}`, 1),
  people: [{ user_id: "u1", name: "Asha Rao" }],
})

describe("record quality", () => {
  it("counts each kind of problem above the list, and confirms a merge with what moves", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/admin/record/duplicates": () => ({
          summary: { pairs: 25, by_reason: { DOI: 25 }, people_affected: 1 },
          reasons: { DOI: "Same DOI" },
          pairs: Array.from({ length: 25 }, (_, i) => pair(i)),
        }),
        "/api/admin/record/merges": () => ({ merges: [] }),
        "/api/admin/record/roster-names": () => ({ suggestions: [] }),
        "/api/admin/record/anomalies": () => ({ anomalies: { placeholder_title: { count: 3, rows: [] } } }),
      })
    )
    renderWithProviders(<RecordQuality />, { route: "/data/record" })
    expect(await screen.findByText("Papers recorded twice")).toBeTruthy()
    expect(await screen.findByText("Every name agrees")).toBeTruthy()
    // A long list is shown ten at a time, with how many are left.
    expect(screen.getByRole("button", { name: /Show 10 more \(15 left\)/ })).toBeTruthy()
    await userEvent.click(screen.getAllByRole("button", { name: "Merge into the fuller record" })[0])
    expect(await screen.findByText(/4 authors, 1 filed claim and 3 citations move to the record you keep/)).toBeTruthy()
  })
})
