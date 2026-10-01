import { ExternalLink } from "lucide-react"

import { isOwnMedia } from "@/ui/attachments"
import type { Rect } from "./items"

/**
 * Where a reviewer's mark sits on a PDF page: a small drawing of the page
 * with the marked region on it, the words for where that is, the text the
 * reviewer quoted, and a link that opens the file at that page.
 *
 * Deliberately not a rendered page. A claimant needs to know which page and
 * which part of it, and to get there in one click; a PDF renderer would add
 * a large dependency to show what a browser's own viewer already shows when
 * it is opened at `#page=N`. The drawing is exact (the rectangle is the
 * mark's own fractions of the page), so nothing about it is approximate.
 */
export function regionPhrase(rect: Rect): string {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const v = cy < 0.34 ? "top" : cy < 0.67 ? "middle" : "bottom"
  const h = cx < 0.34 ? "left" : cx < 0.67 ? "centre" : "right"
  if (v === "middle" && h === "centre") return "the middle of the page"
  if (v === "middle") return `the middle ${h} of the page`
  if (h === "centre") return `the ${v} of the page`
  return `the ${v} ${h} of the page`
}

const clamp = (n: number) => Math.min(1, Math.max(0, n))

export function pageLink(url: string, page: number): string | null {
  // Only a file this server stored is linked: the URL came from the mark.
  return isOwnMedia(url) ? `${url}#page=${page}` : null
}

export function MarkedPage({
  fileUrl,
  fileName,
  page,
  rect,
  quotedText,
}: {
  fileUrl?: string | null
  fileName?: string | null
  page: number
  rect?: Rect | null
  quotedText?: string | null
}) {
  const href = fileUrl ? pageLink(fileUrl, page) : null
  return (
    <div className="flex gap-4" data-testid="marked-page">
      {/* A drawing of a page with no region on it says nothing, so it is drawn only for a mark that has one. */}
      {rect && <PageDrawing page={page} rect={rect} />}
      <div className="min-w-0 space-y-1.5 text-sm">
        <p className="font-medium">
          Page {page}
          {fileName ? <span className="font-normal text-fg-muted"> of {fileName}</span> : null}
        </p>
        {rect && <p className="text-fg-muted">The mark is at {regionPhrase(rect)}.</p>}
        {quotedText && (
          <blockquote className="border-l-2 border-line pl-3 text-fg-muted">“{quotedText}”</blockquote>
        )}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent underline-offset-4 hover:underline"
          >
            Open page {page}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </div>
    </div>
  )
}

function PageDrawing({ page, rect }: { page: number; rect: Rect }) {
  return (
    <div
      role="img"
      aria-label={`Page ${page}, with the marked region at ${regionPhrase(rect)}`}
      className="relative aspect-[1/1.414] w-24 shrink-0 rounded-sm bg-surface shadow-[inset_0_0_0_1px_var(--color-line)]"
    >
      {/* Grey lines standing in for text, so the drawing reads as a page. */}
      <div aria-hidden className="absolute inset-x-3 top-4 space-y-1.5">
        {Array.from({ length: 11 }, (_, i) => (
          <div key={i} className={i % 5 === 4 ? "h-0.5 w-2/3 rounded-full bg-active" : "h-0.5 rounded-full bg-active"} />
        ))}
      </div>
      <div
        data-testid="marked-region"
        className="absolute rounded-[2px] border-2 border-accent bg-accent/20"
        style={{
          left: `${clamp(rect.x) * 100}%`,
          top: `${clamp(rect.y) * 100}%`,
          width: `${clamp(rect.w) * 100}%`,
          height: `${clamp(rect.h) * 100}%`,
        }}
      />
    </div>
  )
}
