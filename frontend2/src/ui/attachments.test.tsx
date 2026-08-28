import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AttachmentGallery,
  type Attachment,
  classifyResponse,
  extensionOf,
  isOwnMedia,
  mediumOf,
  readinessMessage,
  referenceLine,
} from "@/ui/attachments"

/**
 * The regression this component exists to undo: an approver deciding a
 * payment could see a filename and nothing else, so in practice nobody
 * opened the evidence. Every assertion here is about something an approver
 * can see or reach without leaving the ticket.
 */

// `restoreMocks` does not undo a stubbed global, and two of the tests below
// stub `matchMedia` — a widened viewport left behind would silently decide
// the answer for whichever test ran next.
afterEach(() => vi.unstubAllGlobals())

const paper: Attachment = {
  id: "a1",
  kind: "PUBLISHED_PAPER",
  url: `/media/claims/${"a".repeat(32)}.pdf`,
  filename: "nanofluids-2024.pdf",
  size_bytes: 2_400_000,
}

const scan: Attachment = {
  id: "a2",
  kind: "SEC_REFERENCE",
  url: `/media/claims/${"b".repeat(32)}.png`,
  filename: "reference-27.png",
  size_bytes: 180_000,
  ref_number: "27",
  ref_title: "Thermal conductivity of hybrid nanofluids",
}

const doc: Attachment = {
  id: "a3",
  kind: "SEC_REFERENCE",
  url: `/media/claims/${"c".repeat(32)}.docx`,
  filename: "cover-note.docx",
  size_bytes: 40_000,
  ref_number: "",
  ref_title: "",
}

describe("what a file is, decided from the URL the server wrote", () => {
  it("reads the extension from the stored URL, not the display name", () => {
    // The stored name is a uuid and the display name is whatever the
    // claimant called it, so a `scan.png` renamed to `paper.pdf` on a
    // desktop must not be framed as a PDF.
    expect(extensionOf(scan)).toBe("png")
    expect(
      extensionOf({ ...scan, filename: "definitely-a-paper.pdf" })
    ).toBe("png")
  })

  it("sorts each file into how it can be shown", () => {
    expect(mediumOf(scan)).toBe("image")
    expect(mediumOf(paper)).toBe("pdf")
    expect(mediumOf(doc)).toBe("file")
  })

  it("refuses to embed anything that did not come from the upload endpoint", () => {
    // Mirrors `_is_own_media_url` in backend/core/api.py. A same-origin path
    // that is not an attachment would render another page of this app inside
    // the ticket; an off-site one would tell a third party who is approving
    // what. Both stay downloadable, neither is framed.
    expect(isOwnMedia(`/media/claims/${"a".repeat(32)}.pdf`)).toBe(true)
    expect(isOwnMedia("/media/claims/../../etc/passwd")).toBe(false)
    expect(isOwnMedia("https://elsewhere.example/paper.pdf")).toBe(false)
    expect(isOwnMedia("/api/claims/1")).toBe(false)
    expect(mediumOf({ ...paper, url: "https://elsewhere.example/paper.pdf" })).toBe("file")
  })
})

describe("a cited reference carries its identity", () => {
  it("states the number and the title together", () => {
    expect(referenceLine(scan)).toBe("Reference 27 — Thermal conductivity of hybrid nanofluids")
    expect(referenceLine({ ...scan, ref_title: null })).toBe("Reference 27")
  })

  it("has none when no number was recorded", () => {
    expect(referenceLine(doc)).toBeNull()
  })

  it("is not invented for a published paper that happens to carry one", () => {
    // The server nulls these on any kind but SEC_REFERENCE; showing one on a
    // paper would claim a bibliography position it does not have.
    expect(referenceLine({ ...paper, ref_number: "27" })).toBeNull()
  })
})

describe("a file that will not load says so", () => {
  it("calls a missing file missing rather than drawing a blank frame", () => {
    expect(classifyResponse(404, null, "pdf")).toEqual({ state: "gone" })
    expect(classifyResponse(403, null, "pdf")).toEqual({ state: "gone" })
    expect(readinessMessage({ state: "gone" }, "pdf")).toMatch(/no longer in storage/i)
  })

  it("names the type actually served when it is not the one claimed", () => {
    expect(classifyResponse(200, "text/html; charset=utf-8", "pdf")).toEqual({
      state: "mistyped",
      served: "text/html",
    })
    expect(
      readinessMessage({ state: "mistyped", served: "text/html" }, "pdf")
    ).toMatch(/text\/html/)
  })

  it("accepts the right type, parameters and all", () => {
    expect(classifyResponse(200, "application/pdf", "pdf")).toEqual({ state: "ready" })
    expect(classifyResponse(200, "image/png", "image")).toEqual({ state: "ready" })
    expect(classifyResponse(200, null, "pdf")).toEqual({ state: "ready" })
  })

  it("does not treat a server that will not answer HEAD as a missing file", () => {
    // A 405 is evidence about the server's methods, not about the file. The
    // frame gets its turn rather than the reader being told the evidence has
    // been deleted.
    expect(classifyResponse(405, null, "pdf")).toEqual({ state: "ready" })
    expect(classifyResponse(500, null, "pdf")).toEqual({ state: "unreachable" })
  })

  it("says nothing at all when there is nothing wrong", () => {
    expect(readinessMessage({ state: "ready" }, "pdf")).toBeNull()
    expect(readinessMessage({ state: "checking" }, "pdf")).toBeNull()
  })
})

describe("the gallery an approver reads", () => {
  it("previews an image in place, without a click", () => {
    // The whole regression in one assertion: the old list showed a filename,
    // this shows the page.
    render(<AttachmentGallery files={[scan]} />)
    const thumb = screen.getByRole("img", { name: /preview of reference-27\.png/i })
    expect(thumb).toHaveAttribute("src", scan.url)
  })

  it("keeps the two kinds of evidence apart", () => {
    render(<AttachmentGallery files={[paper, scan]} />)
    expect(screen.getByRole("heading", { name: /published paper/i })).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: /cited references with an SEC author/i })
    ).toBeInTheDocument()
  })

  it("shows a reference's number and title in the list", () => {
    render(<AttachmentGallery files={[scan]} />)
    expect(
      screen.getByText("Reference 27 — Thermal conductivity of hybrid nanofluids")
    ).toBeInTheDocument()
  })

  it("flags a reference with no number, because that is the fact it was filed to prove", () => {
    render(<AttachmentGallery files={[doc]} />)
    expect(screen.getByText(/no reference number recorded/i)).toBeInTheDocument()
  })

  it("offers a download, labelled as one, for anything a browser cannot show", () => {
    render(<AttachmentGallery files={[doc]} />)
    const link = screen.getByRole("link", { name: /download/i })
    expect(link).toHaveAttribute("href", doc.url)
    expect(link).toHaveAttribute("download")
    expect(screen.getByText(/downloads to your device/i)).toBeInTheDocument()
    // And no viewer is promised for it.
    expect(screen.queryByRole("button", { name: /view/i })).toBeNull()
  })

  it("opens the viewer over the ticket rather than in a new tab", async () => {
    render(<AttachmentGallery files={[scan]} />)
    await userEvent.click(screen.getByRole("button", { name: /view/i }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "reference-27.png" })).toBeInTheDocument()
    // The reference's identity travels into the viewer — it is the question
    // being asked of that file.
    expect(within(dialog).getByText(/Reference 27 —/)).toBeInTheDocument()
  })

  it("closes on Escape", async () => {
    render(<AttachmentGallery files={[scan]} />)
    await userEvent.click(screen.getByRole("button", { name: /view/i }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    // `waitFor`, not a bare assertion: the dialog animates out rather than
    // snapping, so it is still in the tree for a frame or two after Escape.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("distinguishes an empty ticket from a broken one", () => {
    // CONVENTIONS rule 5. Nothing attached is a sentence, not an alert.
    render(<AttachmentGallery files={[]} />)
    expect(screen.getByText(/no files are attached/i)).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("still lists a kind the server grows later", () => {
    render(<AttachmentGallery files={[{ ...doc, kind: "FUNDING_LETTER" }]} />)
    expect(screen.getByRole("heading", { name: /funding letter/i })).toBeInTheDocument()
  })
})

/**
 * The one place this deliberately does something different from the desktop.
 * Neither iOS Safari nor Android Chrome renders a PDF inside an `<iframe>` —
 * the frame comes back blank, which is the exact failure this component was
 * written to abolish. So on a narrow screen it stops pretending.
 */
describe("a PDF on a phone", () => {
  /** The suite's default `matchMedia` answers "no" to every query, which is
   *  the narrow layout. This one answers "yes" to the 48rem breakpoint. */
  function widenViewport() {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList
    )
  }

  /** The file is there; the only question is what the phone will do with it. */
  function fileIsThere() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
      })
    )
  }

  it("hands the file to the device's own reader instead of drawing a blank frame", async () => {
    fileIsThere()
    render(<AttachmentGallery files={[paper]} />)
    await userEvent.click(screen.getByRole("button", { name: /view/i }))
    const dialog = await screen.findByRole("dialog")

    expect(dialog.querySelector("iframe")).toBeNull()
    expect(
      await within(dialog).findByText(/cannot show a PDF inside this window/i)
    ).toBeInTheDocument()
    // And the way out is still one tap away, in both directions.
    expect(within(dialog).getByRole("link", { name: /open in a new tab/i })).toHaveAttribute(
      "href",
      paper.url
    )
    expect(within(dialog).getByRole("link", { name: /download/i })).toHaveAttribute("download")
  })

  it("frames it once there is room, after asking whether the file is really there", async () => {
    widenViewport()
    const head = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
    })
    vi.stubGlobal("fetch", head)

    render(<AttachmentGallery files={[paper]} />)
    await userEvent.click(screen.getByRole("button", { name: /view/i }))
    const dialog = await screen.findByRole("dialog")

    const frame = await within(dialog).findByTitle(/nanofluids-2024\.pdf, in a document viewer/i)
    expect(frame).toHaveAttribute("src", paper.url)
    expect(head).toHaveBeenCalledWith(
      paper.url,
      expect.objectContaining({ method: "HEAD", credentials: "same-origin" })
    )
  })

  it("says the file is gone rather than framing a 404", async () => {
    widenViewport()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 404, headers: new Headers() })
    )

    render(<AttachmentGallery files={[paper]} />)
    await userEvent.click(screen.getByRole("button", { name: /view/i }))
    const dialog = await screen.findByRole("dialog")

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/no longer in storage/i)
    expect(dialog.querySelector("iframe")).toBeNull()
  })
})
