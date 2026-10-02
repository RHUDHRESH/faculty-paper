import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { ErpRemark } from "@/pages/erp-remark"
import { fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

const row = (n: number, over: Record<string, unknown> = {}) => ({
  claim_id: `c${n}`,
  claim_no: `ERP-PROCESSED-${n}`,
  claimant: { id: `u${n}`, name: `Person ${n}`, staff_id: null, photo_url: null },
  title: `Paper ${n}`,
  ...over,
})

const PREVIEW = {
  will_change: [row(1), row(2)],
  held: [row(3, { reason: "possible repeat" }), row(4, { reason: "rejected on the accounts sheet" })],
  counts: { will_change: 2, held_repeat: 1, held_rejected: 1, already_done: 0 },
  signature: "sig-1",
  after_status_label: "Cleared",
}

function mount(table: ApiTable) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((path: string, ...rest: unknown[]) =>
    fakeApi({
      "/api/admin/erp-remark/preview": () => PREVIEW,
      "/api/admin/erp-remark/batches": () => ({ batches: [] }),
      ...table,
    })(path, ...(rest as []))
  )
  renderWithProviders(<ErpRemark />)
}

describe("re-mark the old-ERP claims marked Paid in error", () => {
  it("says how many, previews exactly those, and shows the held ones apart with their reasons", async () => {
    mount({})
    expect(await screen.findByText(/2 claims are marked Paid but were never priced/)).toBeInTheDocument()
    expect(screen.getByText(/2 stay held for the research cell/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Preview 2 claims" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Paper 1")).toBeInTheDocument()
    expect(within(dialog).getByText("Paper 2")).toBeInTheDocument()
    // Held claims are behind a Details, with a way in, and are not in the list to change.
    expect(within(dialog).queryByText("Paper 3")).toBeNull()
    await userEvent.click(within(dialog).getByRole("button", { name: /held for the research cell/ }))
    expect(within(dialog).getByText("possible repeat")).toBeInTheDocument()
    expect(within(dialog).getByText("rejected on the accounts sheet")).toBeInTheDocument()
  })

  it("applies with the signature the preview returned, then offers undo", async () => {
    const apply = vi.fn(() => ({ batch_id: "b1", changed: 2, skipped: 0 }))
    mount({ "/api/admin/erp-remark/apply": apply })
    await userEvent.click(await screen.findByRole("button", { name: "Preview 2 claims" }))
    await userEvent.click(await screen.findByRole("button", { name: "Re-mark 2 claims" }))
    expect(apply).toHaveBeenCalledTimes(1)
    const call = vi.mocked(api).mock.calls.find((c) => c[0] === "/api/admin/erp-remark/apply")
    expect(call?.[1]).toMatchObject({ method: "POST", json: { signature: "sig-1", confirm: true } })
  })

  it("is silent when there is nothing to re-mark and nothing to undo", async () => {
    mount({
      "/api/admin/erp-remark/preview": () => ({
        ...PREVIEW,
        will_change: [],
        counts: { will_change: 0, held_repeat: 0, held_rejected: 0, already_done: 0 },
      }),
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole("heading")).toBeNull()
  })

  it("offers to put the last run back", async () => {
    const undo = vi.fn(() => ({ restored: 2, skipped: [] }))
    mount({
      "/api/admin/erp-remark/preview": () => ({ ...PREVIEW, will_change: [], counts: { ...PREVIEW.counts, will_change: 0 } }),
      "/api/admin/erp-remark/batches": () => ({
        batches: [{ batch_id: "b9", at: "2026-10-01T10:00:00Z", by: "Admin", changed: 2, undone: false }],
      }),
      "/api/admin/erp-remark/undo": undo,
    })
    await userEvent.click(await screen.findByRole("button", { name: "Undo the last re-mark" }))
    expect(undo).toHaveBeenCalledTimes(1)
  })
})
