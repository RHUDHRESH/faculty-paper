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
  rule: "file",
  headline: "The file does not match the claim",
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
    origin: "Imported from the ERP, Processed sheet",
    paper_title: "Crop yield prediction in coastal districts",
    owner_name: "Dr Asha Menon",
    owner_department: "CSE",
    status: "PAID",
    remuneration: 41000,
    paid_at: "2025-03-01T00:00:00Z",
  },
}

function page(results: Record<string, unknown>[]) {
  return {
    total: results.length,
    limit: 25,
    offset: 0,
    results,
    summary: {
      open: results.length,
      resolved: 4,
      open_on_paid: 1,
      groups: results.length
        ? [{ rule: "file", headline: "The file does not match the claim", open: results.length, open_on_paid: 1 }]
        : [],
    },
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
    expect(screen.getByText(/41,000 paid/)).toBeInTheDocument()
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

    await user.click(await screen.findByRole("button", { name: /^Resolve the flag on ERP-000123/ }))
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

  it("leads with what the open flags are about, and how many are on paid claims", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => ADMIN, "/api/flags": () => page([FLAG]) })
    )
    renderWithProviders(<Flags />)
    const groups = (await screen.findByText("What the open flags are about")).closest("section")!
    expect(groups).toHaveTextContent("The file does not match the claim")
    expect(screen.getByRole("link", { name: "1 Open on claims already paid" })).toHaveAttribute("href", "/flags?paid=yes")
    expect(screen.getByText(/were brought across from the old ERP workbook/)).toBeInTheDocument()
  })

  it("gives one answer to several flags and says how many", async () => {
    const second = { ...FLAG, id: "flag-2", claim_id: "claim-2", claim: { ...FLAG.claim, id: "claim-2", ticket_number: "ERP-000124" } }
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/flags/resolve-many": () => ({ resolved: 2, skipped: [] }),
        "/api/flags": () => page([FLAG, second]),
      })
    )
    const user = userEvent.setup()
    renderWithProviders(<Flags />)
    await user.click(await screen.findByLabelText("Choose all 2 shown"))
    await user.click(screen.getByRole("button", { name: "Resolve 2 flags" }))
    // The dialog names the batch before anything is sent.
    expect(await screen.findByText("Resolve 2 flags?")).toBeInTheDocument()
    const confirm = screen.getAllByRole("button", { name: "Resolve 2 flags" }).at(-1)!
    expect(confirm).toBeDisabled()
    await user.click(screen.getByRole("button", { name: /Opened the file by eye/ }))
    await user.click(confirm)
    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([path]) => path === "/api/flags/resolve-many")
      expect(call?.[1]).toMatchObject({
        method: "POST",
        json: { flag_ids: ["flag-1", "flag-2"], note: "Opened the file by eye: it is the right paper" },
      })
    })
  })

  it("shows an answered flag with who answered it and why", async () => {
    const answered = {
      ...FLAG,
      open: false,
      resolved_by_name: "Ravi Cell",
      resolved_at: "2026-09-25T10:00:00Z",
      resolution_note: "Opened the scan: it is the right paper",
    }
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => ADMIN, "/api/flags": () => page([answered]) })
    )
    renderWithProviders(<Flags />)
    expect(await screen.findByText(/Resolved by Ravi Cell/)).toBeInTheDocument()
    expect(screen.getByText("Opened the scan: it is the right paper")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Resolve the flag/ })).toBeNull()
  })

  it("opens the resolve dialog on r for the selected flag", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => ADMIN, "/api/flags": () => page([FLAG]) })
    )
    const user = userEvent.setup()
    renderWithProviders(<Flags />)
    await screen.findByText("Crop yield prediction in coastal districts")
    await user.keyboard("r")
    expect(await screen.findByRole("button", { name: "Resolve this flag" })).toBeInTheDocument()
  })
})
