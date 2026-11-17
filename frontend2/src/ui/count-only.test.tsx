import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})
vi.mock("@/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ui/toast")>()
  return { ...actual, toast: { ...actual.toast, ok: vi.fn(), fail: vi.fn() } }
})

import { api } from "@/lib/api"
import type { Me } from "@/app/auth"
import { Approvals } from "@/pages/approvals"
import { DeskTable } from "@/pages/desk-table"
import { fakeApi, renderWithProviders } from "@/test/harness"
import { CountOnlyBadge, CountOnlyDialog, CountOnlyRowMenu, canAcceptForCountOnly } from "@/ui/count-only"
import { toast } from "@/ui/toast"

/**
 * "Accept for count only". Pinned: who is offered it and where (the same
 * matrix the server enforces), the dialog's three plain choices with a note
 * that "Other" cannot do without, what is posted, the toast, and the badge a
 * counted paper wears on the desk list and on the claimant's page.
 */

const me = (role: Me["role"], email = `${role.toLowerCase()}@example.edu`): Me => ({
  id: `u-${role}`,
  email,
  name: role,
  role,
  department: null,
})
const CELL = me("RESEARCH_CELL")
const COORD = me("RESEARCH_COORDINATOR")
const PRINCIPAL = me("PRINCIPAL")
const DIRECTOR = me("DIRECTOR")
const ADMIN = me("SUPER_ADMIN")
const FINANCE = me("FINANCE")
const FACULTY = me("FACULTY")

const CLAIM = {
  id: "c1",
  paper_title: "Fuzzy control of a grid",
  ticket_number: "FP-2026-000001",
  owner_email: "asha@example.edu",
  status: "SUBMITTED",
  claim_reason: "INCENTIVE",
}

function serve(who: Me, extra: Record<string, () => unknown> = {}) {
  vi.mocked(api).mockImplementation(
    fakeApi({ "/api/auth/me": () => who, "/api/claims/": () => ({ ok: true }), ...extra })
  )
}
const posted = (path: string) =>
  vi.mocked(api).mock.calls.find(([p, o]) => p === path && (o as { method?: string })?.method === "POST")
const body = (path: string) => (posted(path)![1] as { json: unknown }).json

describe("who is offered it, and where", () => {
  it("follows the step the claim is at", () => {
    const yes: [Me["role"], string][] = [
      ["RESEARCH_CELL", "SUBMITTED"],
      ["RESEARCH_COORDINATOR", "SUBMITTED"],
      ["SUPER_ADMIN", "SUBMITTED"],
      ["PRINCIPAL", "CLEARED"],
      ["SUPER_ADMIN", "CLEARED"],
      ["DIRECTOR", "PRINCIPAL_APPROVED"],
      ["SUPER_ADMIN", "PRINCIPAL_APPROVED"],
    ]
    for (const [role, status] of yes) expect(canAcceptForCountOnly(role, status), `${role} at ${status}`).toBe(true)
    const no: [Me["role"], string][] = [
      ["PRINCIPAL", "SUBMITTED"],
      ["DIRECTOR", "SUBMITTED"],
      ["RESEARCH_CELL", "CLEARED"],
      ["DIRECTOR", "CLEARED"],
      ["RESEARCH_CELL", "PRINCIPAL_APPROVED"],
      ["PRINCIPAL", "PRINCIPAL_APPROVED"],
      ["FINANCE", "SUBMITTED"],
      ["FINANCE", "DIRECTOR_APPROVED"],
      ["FACULTY", "SUBMITTED"],
      ["HOD", "SUBMITTED"],
      ["SUPER_ADMIN", "DIRECTOR_APPROVED"],
      ["SUPER_ADMIN", "PAID"],
      ["SUPER_ADMIN", "DRAFT"],
    ]
    for (const [role, status] of no) expect(canAcceptForCountOnly(role, status), `${role} at ${status}`).toBe(false)
    expect(canAcceptForCountOnly(undefined, "SUBMITTED")).toBe(false)
  })
})

describe("the row's More menu", () => {
  beforeEach(() => vi.clearAllMocks())

  async function menuFor(who: Me, claim = CLAIM, stage: "SUBMITTED" | "CLEARED" | "PRINCIPAL_APPROVED" = "SUBMITTED") {
    serve(who)
    renderWithProviders(<CountOnlyRowMenu claim={claim} stage={stage} />)
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("/api/auth/me"))
    await new Promise((r) => setTimeout(r, 30))
  }

  it("holds Accept for count only for the research cell at the clearing desk", async () => {
    const user = userEvent.setup()
    await menuFor(CELL)
    await user.click(await screen.findByRole("button", { name: /More actions/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Accept for count only" }))
    expect(await screen.findByRole("dialog", { name: "Accept for count only?" })).toBeInTheDocument()
  })

  it.each([
    ["the coordinator", COORD, "SUBMITTED"],
    ["the Principal", PRINCIPAL, "CLEARED"],
    ["the Director", DIRECTOR, "PRINCIPAL_APPROVED"],
    ["a super admin", ADMIN, "CLEARED"],
  ] as const)("offers it to %s", async (_n, who, status) => {
    await menuFor(who, { ...CLAIM, status }, status)
    expect(await screen.findByRole("button", { name: /More actions/ })).toBeInTheDocument()
  })

  it.each([
    ["the Principal at the clearing desk", PRINCIPAL, "SUBMITTED"],
    ["Finance", FINANCE, "SUBMITTED"],
    ["a faculty member", FACULTY, "SUBMITTED"],
    ["the cell at the Principal's step", CELL, "CLEARED"],
  ] as const)("does not offer it to %s", async (_n, who, status) => {
    await menuFor(who, { ...CLAIM, status }, status)
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull()
  })

  it("does not offer it on your own claim, or on one already counted only", async () => {
    await menuFor(CELL, { ...CLAIM, owner_email: CELL.email })
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull()
  })

  it("does not offer it again once the paper is count only", async () => {
    await menuFor(CELL, { ...CLAIM, claim_reason: "COUNT_ONLY" })
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull()
  })
})

describe("the dialog", () => {
  beforeEach(() => vi.clearAllMocks())

  function open() {
    serve(CELL)
    const onOpenChange = vi.fn()
    renderWithProviders(<CountOnlyDialog claim={CLAIM} open onOpenChange={onOpenChange} />)
    return onOpenChange
  }

  it("has three plain choices and says what it does", async () => {
    open()
    const dialog = await screen.findByRole("dialog")
    const radios = within(dialog).getAllByRole("radio")
    expect(radios.map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      "Student publication",
      "Does not cite SEC-affiliated articles",
      "Other reason",
    ])
    expect(radios[0]).toBeChecked()
    expect(within(dialog).getByText("The paper is counted for the college. No incentive is paid.")).toBeInTheDocument()
    expect(within(dialog).queryByLabelText("Say why")).toBeNull()
  })

  it("posts the chosen reason and says Recorded for count only", async () => {
    const user = userEvent.setup()
    const onOpenChange = open()
    await user.click(await screen.findByRole("radio", { name: "Does not cite SEC-affiliated articles" }))
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(posted("/api/claims/c1/count-only")).toBeTruthy())
    expect(body("/api/claims/c1/count-only")).toEqual({ reason: "no_sec_citation" })
    await waitFor(() => expect(toast.ok).toHaveBeenCalledWith("Recorded for count only"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("will not take Other without a note", async () => {
    const user = userEvent.setup()
    open()
    await user.click(await screen.findByRole("radio", { name: "Other reason" }))
    const confirm = screen.getByRole("button", { name: "Confirm" })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText("Say why"), "   ")
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText("Say why"), "Conference abstract only")
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(posted("/api/claims/c1/count-only")).toBeTruthy())
    expect(body("/api/claims/c1/count-only")).toEqual({ reason: "other", note: "Conference abstract only" })
  })

  it("shows the server's refusal and stays open", async () => {
    const user = userEvent.setup()
    serve(CELL, {
      "/api/claims/c1/count-only": () => {
        throw new Error("This claim is already paid, so it cannot be changed to count only.")
      },
    })
    const onOpenChange = vi.fn()
    renderWithProviders(<CountOnlyDialog claim={CLAIM} open onOpenChange={onOpenChange} />)
    await user.click(await screen.findByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(toast.fail).toHaveBeenCalled())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

describe("the badge", () => {
  it("is worn by a count-only paper and by nothing else", () => {
    renderWithProviders(
      <>
        <CountOnlyBadge claim={{ claim_reason: "COUNT_ONLY" }} />
        <CountOnlyBadge claim={{ claim_reason: "INCENTIVE" }} />
      </>
    )
    expect(screen.getAllByText("Count only")).toHaveLength(1)
  })

  it("shows on the desk list, in the row of the paper, with no amount to pay", async () => {
    serve(CELL)
    renderWithProviders(
      <DeskTable
        rows={[
          { ...CLAIM, journal_title: "Nature", owner_name: "Asha Faculty", remuneration: 0, waiting_days: 2, claim_reason: "COUNT_ONLY" },
          { ...CLAIM, id: "c2", ticket_number: "FP-2026-000002", paper_title: "Another paper", journal_title: null, owner_name: "Ravi", remuneration: 5000, waiting_days: 1 },
        ]}
        href={(r) => `/review/${r.id}`}
        id="t"
        title="T"
        caption="Claims"
        action={() => null}
        countOnlyStage="SUBMITTED"
        empty={{ title: "None" }}
      />
    )
    const first = (await screen.findByText("FP-2026-000001")).closest("tr") as HTMLElement
    expect(within(first).getByText("Count only")).toBeInTheDocument()
    const second = screen.getByText("FP-2026-000002").closest("tr") as HTMLElement
    expect(within(second).queryByText("Count only")).toBeNull()
    // The row that is already count only has no menu to offer it again.
    await waitFor(() => expect(within(second).getByRole("button", { name: /More actions/ })).toBeInTheDocument())
    expect(within(first).queryByRole("button", { name: /More actions/ })).toBeNull()
  })
})

describe("on the Principal's approvals list", () => {
  it("opens the dialog from a row's More menu and posts to that claim", async () => {
    const user = userEvent.setup()
    const claim = {
      id: "a1",
      ticket_number: "FP-2026-000011",
      paper_title: "Grid paper",
      journal_title: "Nature",
      quartile: "Q1",
      owner_name: "Asha Faculty",
      owner_email: "asha@example.edu",
      owner_department: "ECE",
      remuneration: 52_377.5,
      remuneration_is_estimate: false,
      waiting_days: 3,
      verification_ok: true,
      duplicate_warning: false,
      calc_error: null,
      on_hold: false,
      status: "CLEARED",
      claim_reason: "INCENTIVE",
      cleared_by_name: "R Cell",
      needs_second_approval: false,
      open_flags: 0,
    }
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => PRINCIPAL,
        "/api/principal/queue": () => ({
          total: 1, limit: 200, offset: 0, results: [claim],
          totals: { count: 1, amount: 52_377.5, longest_wait_days: 3 }, departments: ["ECE"],
        }),
        "/api/claims/a1/count-only": () => ({ ok: true }),
      })
    )
    renderWithProviders(<Approvals />, { route: "/approvals" })
    const row = (await screen.findByText("FP-2026-000011")).closest("tr") as HTMLElement
    await user.click(within(row).getByRole("button", { name: /More actions/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Accept for count only" }))
    await user.click(await screen.findByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(posted("/api/claims/a1/count-only")).toBeTruthy())
    expect(body("/api/claims/a1/count-only")).toEqual({ reason: "student_publication" })
  })
})
