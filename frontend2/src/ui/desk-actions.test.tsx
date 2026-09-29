import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import type { Me } from "@/app/auth"
import { EditClaimFieldsDialog, HoldControl, ReasonActionDialog } from "@/ui/desk-actions"
import { fakeApi, renderWithProviders } from "@/test/harness"

const CELL: Me = { id: "u-cell", email: "cell@example.edu", name: "Cell", role: "RESEARCH_CELL", department: null }
const ADMIN: Me = { id: "u-sa", email: "sa@example.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const CLAIM = {
  id: "c1",
  paper_title: "A paper",
  ticket_number: "T-1",
  owner_email: "faculty@example.edu",
  on_hold: false,
  hold_reason: null,
  doi: "10.1/x",
}

function stub(me: Me) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/claims/": () => ({ ok: true }),
      "/api/admin/claims/": () => ({ ok: true, changed: {} }),
    })
  )
}

function posted(path: string) {
  return vi.mocked(api).mock.calls.find(([p, o]) => p === path && (o as { method?: string })?.method === "POST")
}

describe("hold and resume", () => {
  it("puts a claim on hold only with a 10+ character reason", async () => {
    const user = userEvent.setup()
    stub(CELL)
    renderWithProviders(<HoldControl claim={CLAIM} />)
    await user.click(await screen.findByRole("button", { name: "Put on hold" }))
    const confirm = screen.getAllByRole("button", { name: "Put on hold" }).at(-1)!
    await user.type(screen.getByLabelText(/Reason/), "short")
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText(/Reason/), " but now long enough")
    await user.click(confirm)
    await waitFor(() => expect(posted("/api/claims/c1/hold")).toBeTruthy())
    expect((posted("/api/claims/c1/hold")![1] as { json: unknown }).json).toEqual({
      reason: "short but now long enough",
    })
  })

  it("offers Resume on a held claim", async () => {
    const user = userEvent.setup()
    stub(CELL)
    renderWithProviders(<HoldControl claim={{ ...CLAIM, on_hold: true, hold_reason: "Waiting on proof" }} />)
    await user.click(await screen.findByRole("button", { name: "Resume" }))
    await waitFor(() => expect(posted("/api/claims/c1/resume")).toBeTruthy())
  })

  it("is not offered on your own claim", async () => {
    stub(CELL)
    renderWithProviders(<HoldControl claim={{ ...CLAIM, owner_email: CELL.email }} />)
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("/api/auth/me"))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("button", { name: "Put on hold" })).toBeNull()
  })
})

describe("reject outright / send to the faculty member", () => {
  it("posts the reason to the endpoint it was given", async () => {
    const user = userEvent.setup()
    stub(CELL)
    renderWithProviders(
      <ReasonActionDialog
        claim={CLAIM}
        open
        onOpenChange={() => {}}
        path="/api/claims/c1/reject-outright"
        title="Reject this claim outright?"
        hint="Final."
        confirmLabel="Reject outright"
        doneToast="Rejected outright"
      />
    )
    const btn = await screen.findByRole("button", { name: "Reject outright" })
    expect(btn).toBeDisabled()
    await user.type(screen.getByLabelText(/Reason/), "Not a journal paper at all")
    await user.click(btn)
    await waitFor(() => expect(posted("/api/claims/c1/reject-outright")).toBeTruthy())
    expect((posted("/api/claims/c1/reject-outright")![1] as { json: unknown }).json).toEqual({
      note: "Not a journal paper at all",
    })
  })
})

describe("super admin edits fields", () => {
  it("sends only the changed fields with the reason", async () => {
    const user = userEvent.setup()
    stub(ADMIN)
    renderWithProviders(<EditClaimFieldsDialog claim={CLAIM} open onOpenChange={() => {}} />)
    const doi = await screen.findByLabelText("DOI")
    await user.clear(doi)
    await user.type(doi, "10.1/y")
    const save = screen.getByRole("button", { name: "Save changes" })
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText(/^Reason/), "DOI mistyped in the ERP import")
    await user.click(save)
    await waitFor(() => expect(posted("/api/admin/claims/c1/edit")).toBeTruthy())
    expect((posted("/api/admin/claims/c1/edit")![1] as { json: unknown }).json).toEqual({
      fields: { doi: "10.1/y" },
      reason: "DOI mistyped in the ERP import",
    })
  })
})
