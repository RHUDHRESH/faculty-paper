import { useEffect, useState } from "react"
import { Download, ExternalLink, FileImage, FileText, Maximize2, Paperclip } from "lucide-react"

import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { InlineError } from "@/ui/state"
import { Meta } from "@/ui/text"
import { cn } from "@/lib/cn"

/* ------------------------------------------------------------------------ */
/* What an attachment is                                                     */
/* ------------------------------------------------------------------------ */

/** One row of `claim_to_dict()["attachments"]` in `backend/core/api.py`.
 *  `ref_number` and `ref_title` are only ever set on a `SEC_REFERENCE`; the
 *  server nulls them on any other kind. */
export type Attachment = {
  id?: string | null
  kind: string
  url: string
  filename?: string | null
  size_bytes?: number | null
  ref_number?: string | null
  ref_title?: string | null
}

/** How a file can be shown, which is not the same as what it is called.
 *  `file` is the honest answer for a Word document or a TIFF: no browser
 *  shows one, so pretending otherwise buys a blank rectangle. */
export type Medium = "image" | "pdf" | "file"

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"])

/** The shape the server writes and the only shape it will accept back —
 *  `_ATTACHMENT_NAME` in `backend/core/api.py`. Mirrored here because a URL
 *  that did not come out of the upload endpoint is a URL this component must
 *  never put inside an `<img>` or an `<iframe>`: framing an arbitrary
 *  same-origin path renders someone else's page inside the ticket, and
 *  framing an off-site one hands a third party a view of who is approving
 *  what. Anything that fails this is still downloadable, never embedded. */
const OWN_MEDIA = /^\/media\/claims\/[0-9a-f]{32}\.[a-z0-9]{2,5}$/

export function isOwnMedia(url: string | null | undefined): boolean {
  return OWN_MEDIA.test((url || "").trim())
}

export function extensionOf(file: Attachment): string {
  // The stored name is a uuid, so the URL is the reliable one; the display
  // filename is the fallback for a record written before that was true.
  const fromUrl = (file.url || "").split("?")[0].split(".").pop() || ""
  const fromName = (file.filename || "").split(".").pop() || ""
  return (fromUrl || fromName).toLowerCase()
}

export function mediumOf(file: Attachment): Medium {
  if (!isOwnMedia(file.url)) return "file"
  const ext = extensionOf(file)
  if (IMAGE_EXTENSIONS.has(ext)) return "image"
  if (ext === "pdf") return "pdf"
  return "file"
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ------------------------------------------------------------------------ */
/* Kind — the two things an approver is actually checking                    */
/* ------------------------------------------------------------------------ */

/**
 * The two kinds are different evidence and get checked differently, so they
 * are never mixed into one undifferentiated list. A published paper answers
 * "is this the paper on the ticket". A cited reference answers "is this
 * really reference 27, and is one of its authors from this college" — a
 * question nobody can answer from a filename.
 */
const KIND_ORDER = ["PUBLISHED_PAPER", "SEC_REFERENCE"] as const

const KIND_COPY: Record<string, { title: string; checking: string }> = {
  PUBLISHED_PAPER: {
    title: "Published paper",
    checking: "The full-length paper as it appeared in the journal.",
  },
  SEC_REFERENCE: {
    title: "Cited references with an SEC author",
    checking: "Each one should show its reference number and an SEC-affiliated author.",
  },
}

export function kindTitle(kind: string): string {
  return KIND_COPY[kind]?.title ?? kind.replace(/_/g, " ").toLowerCase()
}

/** The reference's identity as a sentence, or null when it has none. A
 *  `SEC_REFERENCE` with no number is not a small omission — it is the one
 *  fact the file was attached to prove, and the server counts references by
 *  that number, so a blank one is a file nobody can check. */
export function referenceLine(file: Attachment): string | null {
  if (file.kind !== "SEC_REFERENCE") return null
  const number = (file.ref_number || "").trim()
  const title = (file.ref_title || "").trim()
  if (!number) return null
  return title ? `Reference ${number} — ${title}` : `Reference ${number}`
}

/* ------------------------------------------------------------------------ */
/* Will this file actually load?                                             */
/* ------------------------------------------------------------------------ */

export type Readiness =
  | { state: "checking" }
  | { state: "ready" }
  | { state: "gone" }
  | { state: "mistyped"; served: string }
  | { state: "unreachable" }

/**
 * An `<iframe>` does not report a 404. It reports nothing at all — no
 * `error` event fires for a cross-document load, so a file deleted from
 * storage renders as a grey rectangle and the approver is left deciding
 * whether the evidence is missing or the app is broken. The only way to know
 * is to ask the server first, and this is the part of that worth testing:
 * given a status and a content type, what should the reader be told.
 *
 * A `HEAD` the server declines to answer (405/501) is not evidence of
 * anything, so it resolves to `ready` and the frame gets its turn.
 */
export function classifyResponse(
  status: number,
  contentType: string | null,
  medium: Medium
): Readiness {
  if (status === 404 || status === 403 || status === 410) return { state: "gone" }
  if (status === 405 || status === 501) return { state: "ready" }
  if (status < 200 || status >= 300) return { state: "unreachable" }

  const served = (contentType || "").split(";")[0].trim().toLowerCase()
  if (!served) return { state: "ready" }
  if (medium === "pdf" && served !== "application/pdf") return { state: "mistyped", served }
  if (medium === "image" && !served.startsWith("image/")) return { state: "mistyped", served }
  return { state: "ready" }
}

/** The sentence for each failure. Separate from the classification so a test
 *  can assert the wording without rendering, and so no caller writes its own
 *  version of "could not load". */
export function readinessMessage(readiness: Readiness, medium: Medium): string | null {
  const noun = medium === "pdf" ? "PDF" : medium === "image" ? "image" : "file"
  switch (readiness.state) {
    case "gone":
      return `This ${noun} is no longer in storage. The ticket still lists it, but the file itself is not there — ask whoever filed the claim to upload it again.`
    case "mistyped":
      return `The server is serving this as ${readiness.served}, not a ${noun}, so it cannot be shown here. Download it to see what it really is.`
    case "unreachable":
      return `The server did not hand this ${noun} over. Nothing has been deleted; try again in a moment.`
    default:
      return null
  }
}

/** Asks the server whether the file is there before a frame is drawn over
 *  the ticket. Only runs while a viewer is open, so a ticket with twelve
 *  attachments does not fire twelve requests on load. */
function useReadiness(url: string | null, medium: Medium): Readiness {
  const [readiness, setReadiness] = useState<Readiness>({ state: "checking" })

  useEffect(() => {
    if (!url) return
    // jsdom and older runtimes have no fetch; a missing probe must not be
    // the reason a real file refuses to show.
    if (typeof fetch !== "function") {
      setReadiness({ state: "ready" })
      return
    }
    const abort = new AbortController()
    setReadiness({ state: "checking" })
    fetch(url, { method: "HEAD", credentials: "same-origin", signal: abort.signal })
      .then((res) => setReadiness(classifyResponse(res.status, res.headers.get("content-type"), medium)))
      .catch(() => {
        if (!abort.signal.aborted) setReadiness({ state: "unreachable" })
      })
    return () => abort.abort()
  }, [url, medium])

  return readiness
}

/**
 * Whether this screen is wide enough to hold a document frame.
 *
 * The honest answer on a phone is no, and it is not a matter of pixels. iOS
 * Safari and Android Chrome both refuse to render a PDF inside an
 * `<iframe>`: the frame comes back blank or offers a download, which is the
 * exact blank rectangle this component exists to abolish. So below the
 * breakpoint the viewer stops pretending and hands the file to the device's
 * own PDF reader instead, with a sentence saying that is what will happen.
 * Images are unaffected — an `<img>` works everywhere, so a scan still
 * previews in place and opens full size on a phone.
 */
function useCanFrameDocuments(): boolean {
  const [wide, setWide] = useState(
    () => typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? true
      : window.matchMedia("(min-width: 48rem)").matches
  )

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(min-width: 48rem)")
    const onChange = () => setWide(query.matches)
    onChange()
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  return wide
}

/* ------------------------------------------------------------------------ */
/* The gallery                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Evidence an approver can actually look at.
 *
 * These were a row of text links. Five people sign off every payment in this
 * college, and each of them had to open every attachment in a new tab to
 * find out whether it was the right paper — so in practice they were not
 * opened, and a ticket was approved on the strength of a filename. Images
 * preview in place, PDFs open in a viewer over the ticket, and anything a
 * browser cannot show says so and downloads instead of drawing a blank
 * frame. The two kinds are kept apart because they answer different
 * questions, and a cited reference carries its number and title into the
 * viewer, since "is this really reference 27" is the whole of what that file
 * is for.
 */
export function AttachmentGallery({
  files,
  emptyLabel = "No files are attached to this ticket.",
  className,
}: {
  files: Attachment[]
  emptyLabel?: React.ReactNode
  className?: string
}) {
  const [viewing, setViewing] = useState<Attachment | null>(null)

  if (!files.length) {
    return <p className="text-sm text-fg-muted">{emptyLabel}</p>
  }

  // Known kinds first, in the order an approver reads them; anything the
  // server grows later falls through to a group of its own rather than
  // disappearing.
  const kinds = [
    ...KIND_ORDER.filter((k) => files.some((f) => f.kind === k)),
    ...[...new Set(files.map((f) => f.kind))].filter(
      (k) => !KIND_ORDER.includes(k as (typeof KIND_ORDER)[number])
    ),
  ]

  return (
    <div className={cn("space-y-5", className)}>
      {kinds.map((kind) => {
        const group = files.filter((f) => f.kind === kind)
        return (
          <div key={kind} className="space-y-1.5">
            <h3 className="text-base font-medium text-fg">
              {kindTitle(kind)}{" "}
              <span className="tabular font-normal text-fg-subtle">({group.length})</span>
            </h3>
            {KIND_COPY[kind] ? (
              <Meta className="block text-pretty">{KIND_COPY[kind].checking}</Meta>
            ) : null}
            <ul className="divide-y divide-line border-y border-line">
              {group.map((file, i) => (
                <AttachmentRow
                  key={file.id || file.url || i}
                  file={file}
                  index={i}
                  onView={() => setViewing(file)}
                />
              ))}
            </ul>
          </div>
        )
      })}

      <AttachmentViewer file={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* One row                                                                   */
/* ------------------------------------------------------------------------ */

function AttachmentRow({
  file,
  index,
  onView,
}: {
  file: Attachment
  index: number
  onView: () => void
}) {
  const medium = mediumOf(file)
  const name = file.filename || `Document ${index + 1}`
  const reference = referenceLine(file)
  const missingNumber = file.kind === "SEC_REFERENCE" && !reference
  const meta = [extensionOf(file).toUpperCase(), formatSize(file.size_bytes)]
    .filter(Boolean)
    .join(" · ")

  return (
    <li className="row flex items-center gap-3 px-1 py-2">
      <Thumbnail file={file} medium={medium} name={name} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-base" title={name}>
          {name}
        </p>
        {reference ? (
          <p className="truncate text-sm text-fg" title={reference}>
            {reference}
          </p>
        ) : null}
        {missingNumber ? (
          // Not decoration. The server counts a cited reference by its
          // number, so a reference without one is a page an approver has no
          // way to match against the bibliography.
          <p className="text-sm text-caution">No reference number recorded</p>
        ) : null}
        <Meta className="block truncate">
          {meta}
          {medium === "file" ? `${meta ? " · " : ""}Downloads to your device` : ""}
        </Meta>
      </div>

      {medium === "file" ? (
        <Button kind="default" size="sm" asChild className="shrink-0">
          <a href={file.url} download={name}>
            <Download aria-hidden />
            Download
          </a>
        </Button>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <Button kind="default" size="sm" onClick={onView}>
            <Maximize2 aria-hidden />
            View
          </Button>
          {/* A second affordance costs width a 375px row does not have, and
              the viewer offers the same thing one tap further in. */}
          <Button
            kind="quiet"
            size="icon"
            asChild
            aria-label={`Download ${name}`}
            className="hidden sm:inline-flex"
          >
            <a href={file.url} download={name}>
              <Download aria-hidden />
            </a>
          </Button>
        </div>
      )}
    </li>
  )
}

/** The preview in place. A real thumbnail of the real file is the quickest
 *  way to see that a scan is the right page and not a blank one, and it is
 *  the whole difference between a list of filenames and a list of evidence.
 *  A file that will not load falls back to the glyph rather than to a broken
 *  image icon, and the viewer then says why. */
function Thumbnail({
  file,
  medium,
  name,
}: {
  file: Attachment
  medium: Medium
  name: string
}) {
  const [broken, setBroken] = useState(false)

  if (medium === "image" && !broken) {
    return (
      <img
        src={file.url}
        alt={`Preview of ${name}`}
        loading="lazy"
        onError={() => setBroken(true)}
        className="size-10 shrink-0 rounded-sm bg-sunken object-cover ring-1 ring-inset ring-line"
      />
    )
  }

  const Glyph = medium === "pdf" ? FileText : broken ? FileImage : Paperclip
  return (
    <span
      aria-hidden="true"
      className="grid size-10 shrink-0 place-items-center rounded-sm bg-sunken text-fg-muted"
    >
      <Glyph className="size-4" />
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* The viewer                                                                */
/* ------------------------------------------------------------------------ */

/** The file over the ticket rather than in another tab. `Dialog` supplies
 *  the focus trap and Escape; everything below it is about not lying to the
 *  reader when the file will not come. */
function AttachmentViewer({ file, onClose }: { file: Attachment | null; onClose: () => void }) {
  // Held after `file` clears. `DialogContent` hands its exit to
  // `AnimatePresence` (see the note in ui/dialog.tsx), and an exit cannot be
  // animated out of a subtree that has already been torn out of the tree —
  // dropping the body on close turns the dismissal back into the snap that
  // file went to some trouble to avoid. `key` resets the viewer's own state
  // when the reader moves from one attachment straight to the next.
  const [shown, setShown] = useState<Attachment | null>(file)
  useEffect(() => {
    if (file) setShown(file)
  }, [file])

  return (
    <Dialog open={!!file} onOpenChange={(open) => !open && onClose()}>
      {shown ? <ViewerBody key={shown.url} file={shown} /> : null}
    </Dialog>
  )
}

function ViewerBody({ file }: { file: Attachment }) {
  const medium = mediumOf(file)
  const name = file.filename || "Attachment"
  const reference = referenceLine(file)
  const canFrame = useCanFrameDocuments()
  // An image needs no probe: `<img onError>` is reliable, unlike a frame's.
  // A PDF is probed on a phone too, even though no frame is drawn there —
  // finding out the evidence is missing is worth more before the reader
  // leaves the ticket for their device's PDF reader than after.
  const readiness = useReadiness(medium === "pdf" ? file.url : null, medium)
  const [imageBroken, setImageBroken] = useState(false)
  const failure = readinessMessage(readiness, medium)

  return (
    <DialogContent size="lg" className="sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle className="truncate" title={name}>
          {name}
        </DialogTitle>
        <DialogDescription className="text-pretty">
          {file.kind === "SEC_REFERENCE"
            ? `${reference ?? "No reference number was recorded for this file"}. Check the number against the paper's bibliography and that one of its authors is from this college.`
            : `${kindTitle(file.kind)} attached to this ticket.`}
        </DialogDescription>
      </DialogHeader>

      <DialogBody>
        {failure ? (
          <InlineError message={failure} />
        ) : medium === "image" ? (
          imageBroken ? (
            <InlineError
              message={`This image would not load. The ticket still lists it, but the file is not readable — ask whoever filed the claim to upload it again.`}
            />
          ) : (
            <img
              src={file.url}
              alt={name}
              onError={() => setImageBroken(true)}
              className="mx-auto max-h-[60vh] w-full rounded-md bg-sunken object-contain"
            />
          )
        ) : !canFrame ? (
          // The honest answer on a phone. See `useCanFrameDocuments`.
          <div className="well px-3 py-4 text-sm text-fg-muted">
            <p className="text-pretty">
              A phone browser cannot show a PDF inside this window. Opening it hands the
              file to your device&rsquo;s own PDF reader, where you can zoom and scroll;
              come back to the ticket the way you normally go back.
            </p>
          </div>
        ) : readiness.state === "checking" ? (
          <div className="skeleton h-[60vh] w-full rounded-md" aria-hidden="true" />
        ) : (
          <iframe
            // Same-origin: `/media/` is proxied to Django in development and
            // rewritten to Cloud Run in production, so the session cookie
            // goes with it and the file is never fetched from a bucket URL.
            src={file.url}
            title={`${name}, in a document viewer`}
            className="h-[60vh] w-full rounded-md bg-sunken"
          />
        )}
      </DialogBody>

      <DialogFooter>
        <Button kind="quiet" size="md" asChild>
          <a href={file.url} download={name}>
            <Download aria-hidden />
            Download
          </a>
        </Button>
        <Button kind="default" size="md" asChild>
          <a href={file.url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            Open in a new tab
          </a>
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
