import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import type { Proof } from "@/pages/filing/locker"
import { AttachmentGroup } from "@/pages/filing/proof"
import { emptyForm, type AttachmentRow } from "@/pages/filing/types"
import { ProofLocker } from "@/pages/proof-locker"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

const proof = (over: Partial<Proof> = {}): Proof => ({
  id: "p1",
  kind: "ARTICLE",
  filename: "my-article.pdf",
  url: "/media/claims/aaaa.pdf",
  size: 2048,
  content_hash: "h1",
  publication_id: null,
  publication_title: null,
  doi_found: null,
  checks: [
    { key: "readable", status: "ok", title: "The text can be read", detail: "" },
    {
      key: "affiliation",
      status: "bad",
      title: "The college's name was not found",
      detail: "The college's name is not on this PDF. Claims without it are sent back. Check you uploaded the published version.",
    },
    { key: "author", status: "warn", title: "Your name was not found in the author list", detail: "" },
  ],
  worst: "bad",
  checked_at: null,
  created_at: "2026-10-01T00:00:00Z",
  used_on: [],
  ...over,
})

function mount(items: Proof[], extra: Record<string, () => unknown> = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({ "/api/auth/me": () => FACULTY, "/api/me/proofs": () => ({ items }), ...extra })
  )
}

describe("Proof locker page", () => {
  it("lists files with their checks and plain reasons", async () => {
    mount([proof()])
    renderWithProviders(<ProofLocker />, { route: "/papers/locker" })
    expect(await screen.findByText("my-article.pdf")).toBeInTheDocument()
    expect(screen.getByText(/Claims without it are sent back/)).toBeInTheDocument()
    expect(screen.getByLabelText("Problem")).toBeInTheDocument()
    expect(screen.getByLabelText("Worth a look")).toBeInTheDocument()
  })

  it("uploads a picked file with the chosen kind", async () => {
    mount([])
    renderWithProviders(<ProofLocker />, { route: "/papers/locker" })
    expect(await screen.findByText("Your locker is empty")).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText("SEC reference"))
    const file = new File(["%PDF-1.4"], "ref.pdf", { type: "application/pdf" })
    await userEvent.upload(screen.getByTestId("locker-input"), file)
    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([p, o]) => p === "/api/me/proofs" && o?.method === "POST")
      expect(call).toBeTruthy()
      const body = (call![1] as unknown as { body: FormData }).body
      expect(body.get("kind")).toBe("REFERENCE")
      expect((body.get("file") as File).name).toBe("ref.pdf")
    })
  })
})

describe("Choosing from the locker while filing", () => {
  function group(rows: AttachmentRow[], onPick = vi.fn()) {
    renderWithProviders(
      <AttachmentGroup
        title="The published paper"
        hint=""
        kind="PUBLISHED_PAPER"
        rows={rows}
        busy={false}
        empty="Nothing attached yet."
        sameAs={new Map()}
        onAdd={async () => {}}
        onRemove={() => {}}
        onPick={onPick}
        form={emptyForm()}
      />,
      { route: "/papers/new" }
    )
    return onPick
  }

  it("attaches a locker file as an ordinary attachment row", async () => {
    mount([proof()])
    const onPick = group([])
    await userEvent.click(screen.getByRole("button", { name: "Choose from your locker" }))
    await userEvent.click(await screen.findByRole("button", { name: "Attach my-article.pdf" }))
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "PUBLISHED_PAPER", url: "/media/claims/aaaa.pdf", content_hash: "h1" })
    )
  })

  it("shows the locker's warnings beside an attached file, without blocking", async () => {
    mount([proof()], { "/api/lookup/file-check": () => null })
    group([{ kind: "PUBLISHED_PAPER", url: "/media/claims/aaaa.pdf", filename: "my-article.pdf", size_bytes: 2048, content_hash: "h1" }])
    expect(await screen.findByText(/Claims without it are sent back/)).toBeInTheDocument()
    expect(screen.getByText(/You can still file/)).toBeInTheDocument()
  })
})
