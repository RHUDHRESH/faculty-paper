import { useId } from "react"

import { Button } from "@/ui/button"

/**
 * One import, as a row: what it is, what it is for, what is loaded from it now,
 * and an Open button. The form behind it opens on request, so a page with ten
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
  const bodyId = useId()
  return (
    <li id={id} className="py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <p className="font-medium">{title}</p>
          <p className="text-sm text-fg-muted">{purpose}</p>
        </div>
        {summary != null && <span className="tabular text-sm text-fg-muted sm:text-right">{summary}</span>}
        <Button
          kind={open ? "quiet" : "default"}
          size="sm"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${open ? "Close" : "Open"} ${title}`}
          onClick={onToggle}
        >
          {open ? "Close" : "Open"}
        </Button>
      </div>
      {open && (
        <div id={bodyId} role="region" aria-label={title} className="mt-4 space-y-4">
          {children}
        </div>
      )}
    </li>
  )
}
