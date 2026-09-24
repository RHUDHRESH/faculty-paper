import { screen, within } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { PaperDetail } from "@/pages/paper-detail"
import { fakeApi, renderWithProviders } from "@/test/harness"

/**
 * An imported ticket carries the import's moment as its filing and payment
 * time. The page used to print "You filed it yesterday" and "Paid on 23 Sept
 * 2026" for a paper paid long before; it now says what the record knows.
 */
const OWNER: Me = { id: "u-1", email: "o@x.edu", name: "Dr Owner", role: "FACULTY", department: "CSE" }
const ADMIN: Me = { id: "u-9", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }
const IMPORT_MOMENT = "2026-09-23T07:05:30+00:00"

function claim(record: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    owner_id: "u-1",
    owner_name: "Dr Owner",
    status: "PAID",
    ticket_number: "ERP-PROCESSED-650",
    paper_title: "An imported paper",
    journal_title: "A journal",
    remuneration: 0,
    submitted_at: IMPORT_MOMENT,
    paid_at: IMPORT_MOMENT,
    created_at: IMPORT_MOMENT,
    actions: [],
    attachments: [],
    record,
    ...over,
  }
}

const PROCESSED = {
  imported: true,
  source: "Processed",
  imported_at: IMPORT_MOMENT,
  filed_at: null,
  paid_month: null,
  erp_status: "Processed for Remuneration",
}

function mount(me: Me, body: unknown) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/claims/c1/notes": () => [],
      "/api/claims/c1/review": () => ({ flags: [], file_checks: [], summary: {} }),
      "/api/claims/c1": () => body,
    })
  )
  renderWithProviders(
    <Routes>
      <Route path="/papers/:id" element={<PaperDetail />} />
    </Routes>,
    { route: "/papers/c1" }
  )
}

function historySection() {
  return screen.getByRole("heading", { name: "History" }).closest("section")!
}

describe("PaperDetail — an imported ticket's history", () => {
  it("never tells the claimant they filed or were paid on the day of the import", async () => {
    mount(OWNER, claim(PROCESSED))
    await screen.findByText("An imported paper")
    const history = within(historySection())
    expect(history.queryByText(/You filed it/)).toBeNull()
    expect(history.getByText(/Brought across from the college's records/)).toBeInTheDocument()
    expect(history.getByText(/the college's records do not say when/)).toBeInTheDocument()
    expect(screen.queryByText(/Paid on 23 Sept 2026/)).toBeNull()
  })

  it("keeps the Google Form's own filing time", async () => {
    mount(
      OWNER,
      claim(
        { ...PROCESSED, source: "Raw_Data", filed_at: "2026-07-13T10:00:00+00:00", erp_status: null },
        { status: "SUBMITTED", ticket_number: "ERP-RAW-65", paid_at: null }
      )
    )
    await screen.findByText("An imported paper")
    expect(within(historySection()).getByText(/You filed it on the college's Google Form/)).toBeInTheDocument()
  })

  it("shows the office the sheet it came from and what the workbook said", async () => {
    mount(ADMIN, claim(PROCESSED))
    await screen.findByText("An imported paper")
    const history = within(historySection())
    expect(history.getByText(/Brought across from the ERP workbook \(Processed sheet\)/)).toBeInTheDocument()
    expect(history.getByText(/Processed for Remuneration/)).toBeInTheDocument()
    expect(history.queryByText(/^Paid$/)).toBeNull()
  })

  it("names the payout month when one was recorded", async () => {
    mount(OWNER, claim({ ...PROCESSED, paid_month: "2025-03" }))
    await screen.findByText("An imported paper")
    expect(within(historySection()).getByText(/Paid in March 2025/)).toBeInTheDocument()
  })
})
