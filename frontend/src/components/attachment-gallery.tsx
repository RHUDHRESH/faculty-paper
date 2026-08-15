import { useState } from "react"
import { Download, FileText, ImageIcon, Maximize2 } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { mediaUrl } from "@/lib/api"
import { cn } from "@/lib/utils"

export type GalleryFile = {
  url: string
  filename?: string | null
  size_bytes?: number | null
}

function extensionOf(f: GalleryFile): string {
  const fromUrl = (f.url || "").split("?")[0].split(".").pop() || ""
  const fromName = (f.filename || "").split(".").pop() || ""
  return (fromName || fromUrl).toLowerCase()
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"])

export function isImage(f: GalleryFile): boolean {
  return IMAGE_EXT.has(extensionOf(f))
}

export function isPdf(f: GalleryFile): boolean {
  return extensionOf(f) === "pdf"
}

function formatBytes(bytes?: number | null): string {
  if (!bytes) return ""
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Evidence an approver can actually look at.
 *
 * These were a row of text links. An approver deciding on a payment had to open
 * each one in a new tab to see whether it was the right paper — so in practice
 * they were not opened at all. Images preview in place, PDFs open in a viewer
 * over the ticket, and anything else downloads.
 */
export function AttachmentGallery({
  files,
  emptyLabel = "None uploaded",
  className,
}: {
  files: GalleryFile[]
  emptyLabel?: string
  className?: string
}) {
  const [preview, setPreview] = useState<GalleryFile | null>(null)

  if (!files.length) {
    return <span className="text-sm text-muted-foreground">{emptyLabel}</span>
  }

  return (
    <>
      <ul className={cn("grid gap-2 sm:grid-cols-2", className)}>
        {files.map((f, i) => {
          const href = mediaUrl(f.url)
          const image = isImage(f)
          const viewable = image || isPdf(f)
          const name = f.filename || `Document ${i + 1}`
          return (
            <li key={f.url || i}>
              <div className="group flex items-center gap-3 rounded-xl border border-border bg-card p-2 transition-colors hover:border-primary/40">
                {image ? (
                  // A real thumbnail of the real file — the quickest way to see
                  // that a scan is the right page and not a blank one.
                  <img
                    src={href}
                    alt={name}
                    loading="lazy"
                    className="size-12 shrink-0 rounded-lg border border-border object-cover"
                  />
                ) : (
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-brand text-primary">
                    {isPdf(f) ? <FileText className="size-5" /> : <ImageIcon className="size-5" />}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground" title={name}>
                    {name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[extensionOf(f).toUpperCase(), formatBytes(f.size_bytes)]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {viewable ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Preview ${name}`}
                      onClick={() => setPreview(f)}
                    >
                      <Maximize2 />
                    </Button>
                  ) : null}
                  <Button asChild variant="ghost" size="icon-sm" aria-label={`Download ${name}`}>
                    <a href={href} target="_blank" rel="noreferrer" download={name}>
                      <Download />
                    </a>
                  </Button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate">{preview?.filename || "Document"}</DialogTitle>
            <DialogDescription>
              Served from the claim record. Open in a new tab if you need to zoom or print.
            </DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="overflow-hidden rounded-xl border border-border bg-muted/30">
              {isImage(preview) ? (
                <img
                  src={mediaUrl(preview.url)}
                  alt={preview.filename || "Attachment"}
                  className="max-h-[70vh] w-full object-contain"
                />
              ) : (
                <iframe
                  // Same-origin in dev via the proxy, API origin in production.
                  src={mediaUrl(preview.url)}
                  title={preview.filename || "Document preview"}
                  className="h-[70vh] w-full"
                />
              )}
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button asChild variant="secondary" size="sm">
              <a href={mediaUrl(preview?.url)} target="_blank" rel="noreferrer">
                Open in new tab
              </a>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
