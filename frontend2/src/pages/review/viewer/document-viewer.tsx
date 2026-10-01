import { lazy, Suspense, useRef } from "react"
import { Download, FileText, FileWarning, Image as ImageIcon } from "lucide-react"

import { cn } from "@/lib/cn"
import { extensionOf, formatSize, mediumOf, type Attachment } from "@/ui/attachments"
import { Skeleton } from "@/ui/state"

// pdf.js is fetched when the first PDF opens, not with the workspace.
const PdfView = lazy(() => import("./pdf-view"))
const ImageView = lazy(() => import("./image-view"))

/** The tab text for one attachment: what the file is for. A reference is
 *  known by its number, because "is this really reference 27" is the whole of
 *  what that file was attached to prove. */
export function tabLabel(file: Attachment, index: number, all: Attachment[]): string {
  if (file.kind === "PUBLISHED_PAPER") return "Published paper"
  if (file.kind === "SEC_REFERENCE") {
    const number = (file.ref_number || "").trim()
    return number ? `Reference ${number}` : "Reference"
  }
  return file.filename || `File ${index + 1} of ${all.length}`
}

/**
 * The centre of the workspace: one tab per attachment, and the file itself
 * filling the rest of the pane.
 *
 * The tab strip scrolls sideways inside itself, so a claim with a dozen
 * references never widens the page. The file behind each tab is only opened
 * when its tab is selected, and switching away throws its viewer state away:
 * a reviewer who wants a file kept open downloads it.
 */
export function DocumentViewer({
  claimId,
  files,
  index,
  onIndex,
}: {
  claimId: string
  files: Attachment[]
  index: number
  onIndex: (i: number) => void
}) {
  const tabsRef = useRef<HTMLDivElement>(null)

  if (files.length === 0) {
    return (
      <div className="grid h-full place-items-center bg-sunken p-8 text-center">
        <div className="max-w-xs space-y-2">
          <FileWarning className="mx-auto size-6 text-fg-subtle" aria-hidden />
          <p className="text-sm font-medium">Nothing is attached to this claim</p>
          <p className="text-sm text-fg-muted">
            The claimant filed it without a paper or references. Send it back and ask for them.
          </p>
        </div>
      </div>
    )
  }

  const at = Math.min(Math.max(index, 0), files.length - 1)
  const file = files[at]
  const medium = mediumOf(file)

  function onKeyDown(e: React.KeyboardEvent) {
    const next = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : null
    if (next === null) return
    e.preventDefault()
    const to = (next + files.length) % files.length
    onIndex(to)
    tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${to}"]`)?.focus()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={tabsRef}
        role="tablist"
        aria-label="Files attached to this claim"
        onKeyDown={onKeyDown}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-bg px-2 pt-1.5"
      >
        {files.map((f, i) => {
          const selected = i === at
          const Icon = mediumOf(f) === "image" ? ImageIcon : FileText
          return (
            <button
              key={f.id ?? i}
              type="button"
              role="tab"
              id={`doc-tab-${i}`}
              data-tab={i}
              aria-selected={selected}
              aria-controls="doc-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => onIndex(i)}
              title={[f.filename, f.ref_title].filter(Boolean).join(" · ") || undefined}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-t-md px-3 text-sm max-sm:h-10",
                selected
                  ? "bg-surface font-medium text-fg shadow-[inset_0_-2px_0_var(--color-accent)]"
                  : "text-fg-muted hover:bg-hover hover:text-fg"
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {tabLabel(f, i, files)}
            </button>
          )
        })}
      </div>
      <div id="doc-panel" role="tabpanel" aria-labelledby={`doc-tab-${at}`} className="min-h-0 flex-1 bg-surface">
        {medium === "pdf" ? (
          <Suspense fallback={<ViewerLoading />}>
            <PdfView key={file.url} url={file.url} filename={file.filename || "document.pdf"} claimId={claimId} uploadId={file.id ?? null} />
          </Suspense>
        ) : medium === "image" ? (
          <Suspense fallback={<ViewerLoading />}>
            <ImageView key={file.url} url={file.url} filename={file.filename || "image"} />
          </Suspense>
        ) : (
          <NotShowable file={file} />
        )}
      </div>
    </div>
  )
}

function ViewerLoading() {
  return (
    <div className="grid h-full place-items-center bg-sunken p-8" role="status" aria-label="Opening the viewer">
      <div className="w-full max-w-sm space-y-3">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}

/** A Word file, a spreadsheet, or a file the server would not vouch for. */
function NotShowable({ file }: { file: Attachment }) {
  const ext = extensionOf(file)
  return (
    <div className="grid h-full place-items-center bg-sunken p-8 text-center">
      <div className="max-w-xs space-y-3">
        <FileWarning className="mx-auto size-6 text-fg-subtle" aria-hidden />
        <p className="text-sm font-medium break-words">{file.filename || "This file"}</p>
        <p className="text-sm text-fg-muted">
          {ext ? `A .${ext} file` : "This file"} cannot be shown here.
          {formatSize(file.size_bytes) ? ` ${formatSize(file.size_bytes)}.` : ""} Download it to read it.
        </p>
        <a
          href={file.url}
          download={file.filename || undefined}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface px-3.5 text-sm font-medium shadow-raise ring-1 ring-inset ring-edge hover:bg-hover"
        >
          <Download className="size-4" aria-hidden /> Download
        </a>
      </div>
    </div>
  )
}
