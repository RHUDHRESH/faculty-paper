import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { OfficeHome, PrincipalHome } from "@/pages/home-staff"
import { OwnPapersNote } from "@/ui/own-papers"
import { fakeApi, ledgerOf, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * An officer who is also an academic (the owner's rule: "do their own
 * research as well as track others'"). Their home keeps the office work
 * first and gains a compact "Your papers" section below it -- the same pieces
 * a faculty member's home is built from, over `/api/claims?mine=1`, which is
 * their own papers and nobody else's even though they can see the college's.
 */

const PRINCIPAL: Me = {
  id: "u-principal",
  email: "principal@example.edu",
  name: "Dr Lakshmi Rao",
  role: "PRINCIPAL",
  department: null,
}

const SUPER_ADMIN: Me = {
  id: "u-admin",
  email: "admin@example.edu",
  name: "Suresh Admin",
  role: "SUPER_ADMIN",
  department: null,
}

function claim(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    owner_id: PRINCIPAL.id,
    ticket_number: "FP-2026-000701",
    paper_title: "Grain boundaries in thin copper films",
    journal_title: "Acta Materialia",
    status: "CLEARED",
    faculty_stage: "Under review",
    remuneration: 31_500,
    remuneration_is_estimate: false,
    calc_error: null,
    waiting_days: null,
    days_waiting: 4,
    publication_year: 2026,
    updated_at: "2026-09-01T00:00:00Z",
    paid_at: null,
    ...over,
  }
}

/** Somebody else's paper, which a Principal sees on `/api/claims` without `mine`. */
const COLLEAGUE = claim({
  id: "c9",
  owner_id: "u-someone",
  ticket_number: "FP-2026-000999",
  paper_title: "A colleague's paper on lattice struts",
})

const requested: string[] = []

function mount(me: Me, ui: React.ReactElement, extra: ApiTable = {}) {
  const own = [claim()]
  requested.length = 0
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((path: string, ...rest: unknown[]) => {
    requested.push(path)
    return fakeApi({
      "/api/auth/me": () => me,
      "/api/principal/queue": () => ({ total: 0, limit: 8, offset: 0, results: [], totals: { count: 0, amount: 0, longest_wait_days: null } }),
      "/api/dashboard": () => ({ recent: [], ledger_total: 0, ledger_since: null }),
      "/api/claims/counts": () => ({ counts: { filed: 0, sent_back: 0 } }),
      "/api/admin/faults": () => ({ total: 0 }),
      "/api/admin/profile-requests": () => ({ total: 0, results: [] }),
      "/api/admin/duplicate-findings": () => ({ total: 0, results: [], summary: { open: 0 } }),
      // Without `mine` the college's papers come back, the colleague's with them.
      "/api/claims": (p) => {
        const rows = p.includes("mine=1") ? own : [...own, COLLEAGUE]
        return { results: rows, total: rows.length }
      },
      "/api/me/payments": () => ledgerOf(own),
      ...extra,
    })(path, ...(rest as []))
  })
  renderWithProviders(ui)
}

describe("an officer's home", () => {
  it("keeps the Principal's desk and adds their own papers below it", async () => {
    mount(PRINCIPAL, <PrincipalHome />)
    const mine = await screen.findByRole("region", { name: "Your papers" })
    expect(await within(mine).findByText("Grain boundaries in thin copper films")).toBeInTheDocument()
    // Theirs only, although the Principal can see the college's.
    expect(within(mine).queryByText(/lattice struts/)).toBeNull()
    expect(requested.some((p) => p.startsWith("/api/claims?") && p.includes("mine=1"))).toBe(true)
    expect(within(mine).getByRole("link", { name: /File a paper/ })).toHaveAttribute("href", "/papers/new")
  })

  it("draws their paper as the claimant's journey, never naming the desk it is at", async () => {
    mount(PRINCIPAL, <PrincipalHome />)
    const mine = await screen.findByRole("region", { name: "Your papers" })
    expect(await within(mine).findAllByText("Under review")).not.toHaveLength(0)
    for (const desk of [/principal/i, /director/i, /finance/i, /research cell/i]) {
      expect(within(mine).queryByText(desk)).toBeNull()
    }
  })

  it("gives the super admin, who files nothing of their own, no such section", async () => {
    mount(SUPER_ADMIN, <OfficeHome />)
    await screen.findByText(/What is waiting, what is stuck/)
    expect(screen.queryByRole("region", { name: "Your papers" })).toBeNull()
    expect(requested.some((p) => p.includes("mine=1"))).toBe(false)
  })
})

describe("the note on a desk's queue", () => {
  it("tells an officer their own papers are not in it, and who decides them", async () => {
    mount(PRINCIPAL, <OwnPapersNote />)
    expect(
      await screen.findByText(/another officer or the super admin decides/i)
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "My papers" })).toHaveAttribute("href", "/papers")
  })

  it("says nothing to the super admin, who has no papers of their own", async () => {
    mount(SUPER_ADMIN, <OwnPapersNote />)
    // Wait for the account to load before asserting an absence.
    await vi.waitFor(() => expect(requested).toContain("/api/auth/me"))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/another officer or the super admin decides/i)).toBeNull()
  })
})
