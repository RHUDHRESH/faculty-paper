import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Flags } from "@/pages/flags"
import { FINANCE, fakeApi, failing, renderWithProviders } from "@/test/harness"

/**
 * The flagged queue. Two things are pinned here: a failed load is not drawn
 * as "no open flags" (the one sentence that would tell a super admin the
 * books are clean), and resolving a flag sends the note the server needs.
 */

const ADMIN: Me = {
  id: "u-admin",
  email: "admin@example.edu",
  name: "S Rao",
  role: "SUPER_ADMIN",
  department: null,
}

const FLAG = {
  id: "flag-1",
  claim_id: "claim-1",
  kind: "CONTENT_MISMATCH",
  kind_label: "The file does not match the claim",
  source: "AUTO",
  note: "The published paper “paper.pdf” has no text to read — it is probably a scanned copy.",
  open: true,
  raised_by_name: null,
  raised_at: "2026-09-20T10:00:00Z",
  resolved_by_name: null,
  resolved_at: null,
  resolution_note: null,
  claim: {
    id: "claim-1",
    ticket_number: "ERP-000123",
    paper_title: "Crop yield prediction in coastal districts",
    owner_name: "Dr Asha Menon",
    owner_department: "CSE",
    status: "PAID",
    remuneration: 41000,
    paid_at: "2025-03-01T00:00:00Z",
  },
}

function page(results: (typeof FLAG)[]) {
  return {
    total: results.length,
    limit: 25,
    offset: 0,
    results,
    summary: { open: results.length, resolved: 4, open_on_paid: 1 },
  }
}

describe("the flagged queue", () => {
  it("lists what is open, says who raised it, and marks money already paid", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => ADMIN, "/api/flags": () => page([FLAG]) })
    )
    renderWithProviders(<Flags />)

    expect(await screen.findByText("Crop yield prediction in coastal districts")).toBeInTheDocument()
    expect(screen.getByText(/Raised by the file check/)).toBeInTheDocument()
    expect(screen.getByText(/Paid on/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Crop yield prediction/ })).toHaveAttribute("href", "/papers/claim-1")
  })

  it("shows the failure, not an empty queue, when the request fails", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => ADMIN, "/api/flags": failing(500) })
    )
    renderWithProviders(<Flags />)

    expect(await screen.findByText("Could not load the flags")).toBeInTheDocument()
    expect(screen.queryByText("No open flags")).toBeNull()
  })

  it("says so when nothing is open", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => ADMIN, "/api/flags": () => page([]) })
    )
    renderWithProviders(<Flags />)
    expect(await screen.findByText("No open flags")).toBeInTheDocument()
  })

  it("is closed to Finance without asking the server", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => FINANCE }))
    renderWithProviders(<Flags />)
    expect(await screen.findByText("Not open to this account")).toBeInTheDocument()
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).startsWith("/api/flags"))).toBe(false)
  })

  it("resolves a flag with the note the next reader will need", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/flags/flag-1/resolve": () => ({ ...FLAG, open: false }),
        "/api/flags": () => page([FLAG]),
      })
    )
    const user = userEvent.setup()
    renderWithProviders(<Flags />)

    await user.click(await screen.findByRole("button", { name: "Resolve" }))
    const confirm = screen.getByRole("button", { name: "Resolve this flag" })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText("What was found"), "Opened the scan: it is the right paper")
    await user.click(confirm)

    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([path]) => path === "/api/flags/flag-1/resolve")
      expect(call?.[1]).toMatchObject({
        method: "POST",
        json: { note: "Opened the scan: it is the right paper" },
      })
    })
  })
})
