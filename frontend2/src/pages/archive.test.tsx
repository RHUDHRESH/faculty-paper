import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { PastClaims, archiveCsv } from "@/pages/archive"
import { HOD, fakeApi, failing, renderWithProviders } from "@/test/harness"

/**
 * Looking into the past: every filed claim, paid and imported ones included,
 * with the open flags on each. Pinned: a paid claim is listed and says how
 * many flags it carries; the "with open flags" filter reaches the server; a
 * failed load is not drawn as an empty history.
 */

const PRINCIPAL: Me = {
  id: "u-principal",
  email: "principal@example.edu",
  name: "K Nair",
  role: "PRINCIPAL",
  department: null,
}

const ROW = {
  id: "claim-9",
  ticket_number: "ERP-000123",
  paper_title: "Lattice struts under cyclic load",
  journal_title: "Journal of Materials",
  publication_year: 2023,
  status: "PAID",
  status_note: "Accounts",
  owner_name: "Dr Asha Menon",
  owner_department: "Mechanical Engineering",
  remuneration: 0,
  paid_at: "2024-03-01T00:00:00Z",
  file_count: 2,
  open_flags: 1,
}

function page(results: (typeof ROW)[]) {
  return { total: results.length, limit: 25, offset: 0, results }
}

function table(results: (typeof ROW)[]) {
  return {
    "/api/auth/me": () => PRINCIPAL,
    "/api/meta/departments": () => ["Mechanical Engineering"],
    "/api/archive/claims": () => page(results),
  }
}

describe("past claims", () => {
  it("lists a paid claim from the old records with its open flags", async () => {
    vi.mocked(api).mockImplementation(fakeApi(table([ROW])))
    renderWithProviders(<PastClaims />)

    expect((await screen.findAllByText("Lattice struts under cyclic load")).length).toBeGreaterThan(0)
    expect(screen.getAllByText("1 open flag").length).toBeGreaterThan(0)
    const links = screen.getAllByRole("link", { name: /Lattice struts/ })
    expect(links[0]).toHaveAttribute("href", "/papers/claim-9")
  })

  it("asks the server for flagged claims only when told to", async () => {
    vi.mocked(api).mockImplementation(fakeApi(table([ROW])))
    renderWithProviders(<PastClaims />, { route: "/?flagged=open" })
    await screen.findAllByText("Lattice struts under cyclic load")
    const asked = vi.mocked(api).mock.calls.map(([path]) => String(path))
    expect(asked.some((p) => p.startsWith("/api/archive/claims") && p.includes("flagged=open"))).toBe(true)
  })

  it("says an imported claim came from the ERP, not that it was sent back", async () => {
    const imported = {
      ...ROW,
      status: "SUBMITTED",
      status_note: "Imported from Raw_Data",
      origin: "Imported from the ERP, Raw data sheet",
    }
    vi.mocked(api).mockImplementation(fakeApi(table([imported])))
    renderWithProviders(<PastClaims />)
    expect(await screen.findByText(/Imported from the ERP, Raw data sheet/)).toBeInTheDocument()
    expect(screen.queryByText(/Sent back/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Raw_Data/)).not.toBeInTheDocument()
  })

  it("opens a flag with a reason from the row", async () => {
    vi.mocked(api).mockImplementation(fakeApi(table([ROW])))
    const user = userEvent.setup()
    renderWithProviders(<PastClaims />)
    await screen.findAllByText("Lattice struts under cyclic load")
    await user.click(screen.getByRole("button", { name: /Raise a flag on Lattice struts/ }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("writes what is filtered as CSV, quoting commas", () => {
    const csv = archiveCsv([{ ...ROW, paper_title: "Struts, lattices", origin: "Imported from the ERP" }])
    const [head, line] = csv.split("\r\n")
    expect(head.startsWith("Claim no.,Title")).toBe(true)
    expect(line).toContain('"Struts, lattices"')
    expect(line).toContain("Paid")
    expect(line).toContain("Imported from the ERP")
  })

  it("keeps both a search and a year typed in quick succession", async () => {
    vi.mocked(api).mockImplementation(fakeApi(table([ROW])))
    const user = userEvent.setup()
    renderWithProviders(<PastClaims />)
    await screen.findAllByText("Lattice struts under cyclic load")

    await user.type(screen.getByLabelText("Search past claims"), "lattice")
    await user.type(screen.getByLabelText("Publication year"), "2023")
    await waitFor(() => {
      const asked = vi.mocked(api).mock.calls.map(([path]) => String(path))
      const last = asked.filter((p) => p.startsWith("/api/archive/claims")).at(-1) ?? ""
      expect(last).toContain("q=lattice")
      expect(last).toContain("year=2023")
    })
  })

  it("shows the failure, not an empty history", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ ...table([]), "/api/archive/claims": failing(500) })
    )
    renderWithProviders(<PastClaims />)
    expect(await screen.findByText("Could not load past claims")).toBeInTheDocument()
  })

  it("is closed to a head of department without asking the server", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => HOD }))
    renderWithProviders(<PastClaims />)
    expect(await screen.findByText("Not open to this account")).toBeInTheDocument()
    expect(vi.mocked(api).mock.calls.some(([p]) => String(p).startsWith("/api/archive"))).toBe(false)
  })
})
