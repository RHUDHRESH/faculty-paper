import type * as Pdfjs from "pdfjs-dist"

/**
 * Loads pdf.js the first time somebody opens a PDF, and never before.
 *
 * pdf.js is around 400 KB plus a worker of about a megabyte. Every other
 * screen in the app is opened by people who will never look at a PDF, so the
 * library sits behind a dynamic import and only the review workspace's
 * viewer asks for it. The worker is a separate file the browser fetches by
 * URL (`?url` gives Vite's hashed path for it), so the parsing of a large
 * paper happens off the thread that draws the page.
 *
 * One promise for the whole session: opening a second tab must not fetch or
 * configure the library again.
 */
let engine: Promise<typeof Pdfjs> | null = null

export function loadPdfjs(): Promise<typeof Pdfjs> {
  engine ??= (async () => {
    const [lib, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ])
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib
  })().catch((err) => {
    // A failed download is not a permanent state: forget it so the next
    // click can try again.
    engine = null
    throw err
  })
  return engine
}

/** What went wrong opening a PDF, in a sentence a reviewer can act on. */
export function describePdfError(err: unknown): string {
  const e = err as { name?: string; status?: number; message?: string } | null
  if (e?.name === "PasswordException") {
    return "This PDF is protected by a password, so it cannot be shown here. Download it to open it."
  }
  if (e?.name === "MissingPDFException" || e?.status === 404 || e?.status === 410) {
    return "This file is no longer in storage. The claim still lists it, but the file is not there. Ask the claimant to upload it again."
  }
  if (e?.status === 401 || e?.status === 403) {
    return "The server would not hand this file over. Sign in again, or ask an administrator."
  }
  if (e?.name === "InvalidPDFException") {
    return "This file is not a readable PDF. Download it to see what it really is."
  }
  return "The file could not be opened. Nothing has been lost; try again, or download it."
}
