import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/cn"

/**
 * One import, as a row: what it is, what it is for, what is loaded from it now,
 * and a way in. The form behind it opens on request, so a page with ten
 * importers reads as a list of ten jobs instead of ten forms with their
 * warnings (docs/ux/22: the answer first, the detail one step away).
 */
export function ImportTask({
  id,
  title,
  purpose,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string
  title: string
  purpose: string
  /** What is loaded from this file now, in words ("432 on the roster"). */
  summary?: React.ReactNode
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <li id={id} className="py-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={onToggle}
        className="flex w-full flex-wrap items-start gap-x-3 gap-y-1 rounded-control text-left"
      >
        <ChevronRight
          aria-hidden
          className={cn("mt-1 size-4 shrink-0 text-fg-subtle transition-transform duration-[var(--dur-1)]", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 basis-64">
          <span className="block font-medium">{title}</span>
          <span className="block text-sm text-fg-muted">{purpose}</span>
        </span>
        {summary != null && (
          <span className="tabular text-sm text-fg-muted max-sm:pl-7 sm:text-right">{summary}</span>
        )}
      </button>
      {open && (
        <div id={`${id}-body`} role="region" aria-label={title} className="mt-4 space-y-4 sm:pl-7">
          {children}
        </div>
      )}
    </li>
  )
}
