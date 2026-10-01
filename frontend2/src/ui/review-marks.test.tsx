import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { renderWithProviders } from "@/test/harness"
import {
  composeSendBackReason,
  MarkLayer,
  MarkList,
  type ChecklistItem,
  type ReviewMark,
} from "@/ui/review-marks"

let seq = 0
function mark(over: Partial<ReviewMark> = {}): ReviewMark {
  seq += 1
  return {
    id: `m${seq}`,
    claim_id: "c1",
    upload_id: "u1",
    upload_label: "paper.pdf",
    page: 1,
    rect: null,
    quote: "",
    kind: "ISSUE",
    audience: "CLAIMANT",
    checklist_key: "",
    body: "The affiliation line is cut off",
    author_name: "Ravi Cellperson",
    created_at: `2026-09-30T10:0${seq % 10}:00Z`,
    resolved_at: null,
    sent_back_at: null,
    resolved_in_resubmission: false,
    state: "open",
    ...over,
  }
}

type Served = {
  results: ReviewMark[]
  viewer?: "reviewer" | "claimant" | "blind"
  can_mark?: boolean
}

function serve(s: Served) {
  vi.mocked(api).mockImplementation((async (path: string, options?: { method?: string }) => {
    if (path === "/api/claims/c1/marks" && (!options?.method || options.method === "GET")) {
      return { viewer: "reviewer", can_mark: true, send_back: null, ...s }
    }
    return { ok: true }
  }) as unknown as typeof api)
}

function called(path: string, method: string) {
  return vi
    .mocked(api)
    .mock.calls.find(([p, o]) => p === path && (o as { method?: string } | undefined)?.method === method)
}

/* ------------------------------------------------------------------------ */

describe("composeSendBackReason", () => {
  it("is empty when there is nothing to fix", () => {
    expect(composeSendBackReason([], [])).toBe("")
    expect(
      composeSendBackReason(
        [mark({ kind: "OK" }), mark({ audience: "STAFF" }), mark({ resolved_at: "2026-09-30T11:00:00Z" })],
        [{ key: "indexing", status: "ok" }]
      )
    ).toBe("")
  })

  it("writes a polite numbered list from open claimant issues and failed checklist items", () => {
    const text = composeSendBackReason(
      [
        mark({ page: 3, body: "The affiliation line is cut off", quote: "Dept of Mech" }),
        mark({ upload_id: "u2", upload_label: "SEC reference 14", page: 1, body: "This is not the cited article" }),
      ],
      [
        { key: "affiliation", status: "issue", note: "Not on the first page" },
        { key: "sec_refs", status: "needs_info", note: "Send reference 15" },
        { key: "quartile", status: "ok", note: "fine" },
      ]
    )
    expect(text.split("\n")).toEqual([
      "Thank you for your claim. Please fix the following and send it again.",
      "",
      "1. Affiliation: Not on the first page.",
      "2. SEC references: please tell us more. Send reference 15.",
      "3. paper.pdf, page 3: The affiliation line is cut off (“Dept of Mech”).",
      "4. SEC reference 14, page 1: This is not the cited article.",
    ])
  })

  it("leaves out staff-only marks, notes, OK marks and resolved marks, and names no desk", () => {
    const text = composeSendBackReason(
      [
        mark({ body: "Ask the research cell about this", audience: "STAFF" }),
        mark({ body: "Looks fine", kind: "OK", audience: "CLAIMANT" }),
        mark({ body: "For my own memory", kind: "NOTE", audience: "CLAIMANT" }),
        mark({ body: "Already sorted", resolved_at: "2026-09-30T11:00:00Z" }),
        mark({ body: "Fix the DOI" }),
      ],
      []
    )
    expect(text).toContain("1. paper.pdf, page 1: Fix the DOI.")
    for (const left of ["research cell", "Looks fine", "own memory", "sorted"]) {
      expect(text).not.toContain(left)
    }
    expect(text).not.toMatch(/reject|ticket|verify/i)
  })

  it("does not repeat a line and clips a very long quote", () => {
    const checklist: ChecklistItem[] = [
      { key: "affiliation", status: "issue", note: "Missing" },
      { key: "affiliation", status: "issue", note: "missing." },
    ]
    const lines = composeSendBackReason([], checklist).split("\n").filter((l) => /^\d+\./.test(l))
    expect(lines).toEqual(["1. Affiliation: Missing."])
    const quoted = composeSendBackReason([mark({ quote: "x".repeat(400) })], [])
    expect(quoted).toContain("…”")
    expect(quoted.length).toBeLessThan(400)
  })

  it("uses a marks with no document as a checklist line, and a bare issue gets a nudge", () => {
    const text = composeSendBackReason(
      [mark({ upload_id: null, upload_label: null, page: null, checklist_key: "duplicate", body: "Paid in 2024" })],
      [{ key: "other", status: "issue" }]
    )
    expect(text).toContain("1. Other: please check and correct this.")
    expect(text).toContain("2. Duplicate: Paid in 2024.")
  })
})

/* ------------------------------------------------------------------------ */

describe("MarkList", () => {
  it("groups marks by document and page and shows who it is for", async () => {
    serve({
      results: [
        mark({ id: "a", page: 2, body: "Second page problem" }),
        mark({ id: "b", page: 1, body: "First page problem" }),
        mark({ id: "c", upload_id: "u2", upload_label: "SEC reference 14", body: "Wrong article", audience: "STAFF", kind: "NOTE" }),
      ],
    })
    renderWithProviders(<MarkList claimId="c1" />)
    const paper = await screen.findByRole("region", { name: "paper.pdf" })
    const sec = screen.getByRole("region", { name: "SEC reference 14" })
    const rows = within(paper).getAllByRole("listitem")
    expect(rows[0]).toHaveTextContent("First page problem")
    expect(rows[1]).toHaveTextContent("Second page problem")
    expect(within(sec).getByText("Staff only")).toBeInTheDocument()
    expect(within(rows[0]).getByText("For the claimant")).toBeInTheDocument()
    expect(within(rows[0]).getByText("Ravi Cellperson")).toBeInTheDocument()
  })

  it("jumps to the mark when its row is pressed", async () => {
    const user = userEvent.setup()
    const m = mark({ id: "j", page: 4, body: "Look here" })
    serve({ results: [m] })
    const onJump = vi.fn()
    renderWithProviders(<MarkList claimId="c1" onJump={onJump} />)
    await user.click(await screen.findByRole("button", { name: /Mark 1: Look here/ }))
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ id: "j", page: 4 }))
  })

  it("resolves a mark, and confirms or reopens one that is waiting as fixed?", async () => {
    const user = userEvent.setup()
    serve({
      results: [
        mark({ id: "o", body: "Open one", page: 1 }),
        mark({ id: "f", body: "Fixed one", page: 2, state: "fixed?", resolved_in_resubmission: true, sent_back_at: "2026-09-29T00:00:00Z" }),
        mark({ id: "r", body: "Done one", page: 3, state: "resolved", resolved_at: "2026-09-30T00:00:00Z" }),
      ],
    })
    renderWithProviders(<MarkList claimId="c1" />)
    await screen.findByText("Open one")
    expect(screen.getByText("Fixed?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Resolve" }))
    await waitFor(() => expect(called("/api/marks/o/resolve", "POST")).toBeTruthy())
    await user.click(screen.getByRole("button", { name: "Confirm fixed" }))
    await waitFor(() => expect(called("/api/marks/f/resolve", "POST")).toBeTruthy())
    await user.click(screen.getByRole("button", { name: "Not fixed" }))
    await waitFor(() => expect(called("/api/marks/f/reopen", "POST")).toBeTruthy())
    await user.click(screen.getByRole("button", { name: "Reopen" }))
    await waitFor(() => expect(called("/api/marks/r/reopen", "POST")).toBeTruthy())
    // A mark already sent to the claimant cannot be deleted, only resolved.
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2)
  })

  it("edits a mark in place", async () => {
    const user = userEvent.setup()
    serve({ results: [mark({ id: "e", body: "Old words here" })] })
    renderWithProviders(<MarkList claimId="c1" />)
    await user.click(await screen.findByRole("button", { name: "Edit" }))
    const box = screen.getByRole("textbox", { name: "What should the claimant fix?" })
    await user.clear(box)
    await user.type(box, "New words here")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(called("/api/marks/e", "PATCH")).toBeTruthy())
    expect((called("/api/marks/e", "PATCH")![1] as { json: Record<string, unknown> }).json).toMatchObject({
      body: "New words here",
      kind: "ISSUE",
      audience: "CLAIMANT",
    })
  })

  it("shows the claimant a read-only list from the college", async () => {
    serve({
      viewer: "claimant",
      can_mark: false,
      results: [mark({ author_name: "The college", body: "Add page 2 of the reference" })],
    })
    renderWithProviders(<MarkList claimId="c1" />)
    expect(await screen.findByText("Add page 2 of the reference")).toBeInTheDocument()
    expect(screen.getByText("The college")).toBeInTheDocument()
    expect(screen.queryByText("For the claimant")).not.toBeInTheDocument()
    expect(screen.queryByText("Staff only")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Resolve|Edit|Delete|Reopen/ })).not.toBeInTheDocument()
  })

  it("says so when the marks could not load, and when there are none", async () => {
    vi.mocked(api).mockRejectedValue(new Error("down"))
    const failed = renderWithProviders(<MarkList claimId="c1" />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the marks")
    failed.unmount()

    serve({ results: [] })
    renderWithProviders(<MarkList claimId="c1" />)
    expect(await screen.findByText(/No marks yet/)).toBeInTheDocument()
  })

  it("renders nothing for a reader who is not shown marks", async () => {
    serve({ results: [], viewer: "blind", can_mark: false })
    const { container } = renderWithProviders(<MarkList claimId="c1" />)
    await waitFor(() => expect(api).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})

/* ------------------------------------------------------------------------ */

const RECT_BOX = { left: 100, top: 50, width: 400, height: 800 }

function sizeTheLayer() {
  const layer = screen.getByTestId("mark-layer")
  layer.getBoundingClientRect = () =>
    ({ ...RECT_BOX, right: 500, bottom: 850, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect
  return layer
}

function drag(layer: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(layer, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1 })
  fireEvent.pointerMove(layer, { clientX: to[0], clientY: to[1], pointerId: 1 })
  fireEvent.pointerUp(layer, { clientX: to[0], clientY: to[1], pointerId: 1 })
}

describe("MarkLayer", () => {
  it("draws only the marks on this page of this document, at their fractions", async () => {
    serve({
      results: [
        mark({ id: "here", page: 2, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 }, body: "On this page" }),
        mark({ id: "other-page", page: 3, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 } }),
        mark({ id: "other-doc", upload_id: "u2", page: 2, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 } }),
        mark({ id: "quote", page: 2, rect: null, quote: "Saveetha Engineering", body: "Spelling" }),
      ],
    })
    renderWithProviders(
      <div className="relative">
        <MarkLayer claimId="c1" uploadId="u1" page={2} scale={1.5} />
      </div>
    )
    const box = await screen.findByRole("button", { name: /On this page/ })
    expect(box).toHaveStyle({ left: "10%", top: "20%", width: "50%", height: "5%" })
    expect(screen.getAllByRole("button")).toHaveLength(2)
    expect(screen.getByRole("button", { name: /Saveetha Engineering/ })).toBeInTheDocument()
  })

  it("reports a press on a mark", async () => {
    const user = userEvent.setup()
    serve({ results: [mark({ id: "p", page: 1, rect: { x: 0, y: 0, w: 0.3, h: 0.1 }, body: "Press me" })] })
    const onSelect = vi.fn()
    renderWithProviders(<MarkLayer claimId="c1" uploadId="u1" page={1} scale={1} onSelect={onSelect} />)
    await user.click(await screen.findByRole("button", { name: /Press me/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "p" }))
  })

  it("takes no pointer events over the page until draw mode is on", async () => {
    serve({ results: [] })
    renderWithProviders(<MarkLayer claimId="c1" uploadId="u1" page={1} scale={1} />)
    const layer = await screen.findByTestId("mark-layer")
    expect(layer.className).toContain("pointer-events-none")
    expect(layer).not.toHaveAttribute("data-drawing")
  })

  it("drags a region, asks for kind, audience and note, and saves it as fractions", async () => {
    const user = userEvent.setup()
    serve({ results: [] })
    const onDrawModeChange = vi.fn()
    renderWithProviders(
      <MarkLayer claimId="c1" uploadId="u1" page={2} scale={1} drawMode onDrawModeChange={onDrawModeChange} />
    )
    await waitFor(() => expect(screen.getByTestId("mark-layer")).toHaveAttribute("data-drawing", "true"))
    const layer = sizeTheLayer()
    // (140, 130) to (340, 250) on a 400 x 800 page starting at (100, 50).
    drag(layer, [140, 130], [340, 250])

    const dialog = await screen.findByRole("dialog", { name: "Add a mark" })
    const add = within(dialog).getByRole("button", { name: "Add mark" })
    expect(add).toBeDisabled() // an issue for the claimant needs words
    await user.type(within(dialog).getByRole("textbox"), "Affiliation is missing")
    await user.selectOptions(within(dialog).getByLabelText("Checklist item"), "affiliation")
    await user.click(add)

    await waitFor(() => expect(called("/api/claims/c1/marks", "POST")).toBeTruthy())
    const sent = (called("/api/claims/c1/marks", "POST")![1] as { json: Record<string, unknown> }).json
    expect(sent).toMatchObject({
      upload_id: "u1",
      page: 2,
      kind: "ISSUE",
      audience: "CLAIMANT",
      checklist_key: "affiliation",
      body: "Affiliation is missing",
    })
    const rect = sent.rect as { x: number; y: number; w: number; h: number }
    expect(rect.x).toBeCloseTo(0.1)
    expect(rect.y).toBeCloseTo(0.1)
    expect(rect.w).toBeCloseTo(0.5)
    expect(rect.h).toBeCloseTo(0.15)
    await waitFor(() => expect(onDrawModeChange).toHaveBeenCalledWith(false))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("makes a note staff-only by default and lets Escape cancel", async () => {
    const user = userEvent.setup()
    serve({ results: [] })
    renderWithProviders(<MarkLayer claimId="c1" uploadId="u1" page={1} scale={1} drawMode />)
    await waitFor(() => expect(screen.getByTestId("mark-layer")).toHaveAttribute("data-drawing", "true"))
    drag(sizeTheLayer(), [150, 100], [300, 200])
    const dialog = await screen.findByRole("dialog", { name: "Add a mark" })
    await user.selectOptions(within(dialog).getByLabelText("Kind"), "NOTE")
    expect(within(dialog).getByLabelText("Who sees it")).toHaveValue("STAFF")
    await user.type(within(dialog).getByRole("textbox"), "{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(called("/api/claims/c1/marks", "POST")).toBeUndefined()
  })

  it("ignores a click that is too small to be a region", async () => {
    serve({ results: [] })
    renderWithProviders(<MarkLayer claimId="c1" uploadId="u1" page={1} scale={1} drawMode />)
    await waitFor(() => expect(screen.getByTestId("mark-layer")).toHaveAttribute("data-drawing", "true"))
    drag(sizeTheLayer(), [200, 200], [201, 201])
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("never lets the claimant draw", async () => {
    serve({ results: [], viewer: "claimant", can_mark: false })
    renderWithProviders(<MarkLayer claimId="c1" uploadId="u1" page={1} scale={1} drawMode />)
    await waitFor(() => expect(api).toHaveBeenCalled())
    const layer = sizeTheLayer()
    drag(layer, [150, 100], [300, 200])
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(layer).not.toHaveAttribute("data-drawing")
  })

  it("keeps the form open and shows the server's reason when saving is refused", async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockImplementation((async (path: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        const { ApiError } = await import("@/lib/api")
        throw new ApiError(403, "This paper is not at your desk, so you cannot mark it.")
      }
      return { results: [], viewer: "reviewer", can_mark: true, send_back: null, path }
    }) as unknown as typeof api)
    renderWithProviders(<MarkLayer claimId="c1" uploadId="u1" page={1} scale={1} drawMode />)
    await waitFor(() => expect(screen.getByTestId("mark-layer")).toHaveAttribute("data-drawing", "true"))
    drag(sizeTheLayer(), [150, 100], [300, 200])
    const dialog = await screen.findByRole("dialog", { name: "Add a mark" })
    await user.type(within(dialog).getByRole("textbox"), "Something to fix")
    await user.click(within(dialog).getByRole("button", { name: "Add mark" }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("not at your desk")
  })
})
