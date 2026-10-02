import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { Inbox } from "lucide-react"

import { cn } from "@/lib/cn"
import { Avatar, initialsOf } from "@/ui/person"
import { paperTitle } from "@/lib/names"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"

import type { RailClaim } from "./types"

/** "Today", "1 day", "5 days": how long a claim has waited. */
export function waitingLabel(days: number | null | undefined): string {
  if (days == null) return ""
  if (days <= 0) return "Today"
  if (days === 1) return "1 day"
  return `${days} days`
}

/** Amber after two weeks, red after a month, as the list does. */
function waitTone(days: number | null | undefined): string {
  const d = days ?? 0
  return d > 30 ? "text-critical" : d > 14 ? "text-caution" : "text-fg-muted"
}

/**
 * The queue down the left of the workspace: claim number, the claimant's
 * face and how long it has waited, for every claim still to do. The open one
 * is marked and kept in view as j and k walk down the list. Rows are links,
 * so Enter opens the focused one and a middle-click opens it in a new tab.
 */
export function QueueRail({
  rows,
  total,
  currentId,
  hrefFor,
  isLoading,
  isError,
  onRetry,
  filter,
  onFilter,
  title,
}: {
  rows: RailClaim[]
  total: number
  currentId: string
  hrefFor: (id: string) => string
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  filter: string
  onFilter: (text: string) => void
  title: string
}) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" })
  }, [currentId, rows.length])

  return (
    <div className="flex h-full min-h-0 flex-col bg-sunken">
      <div className="shrink-0 space-y-2 border-b border-line px-3 py-2.5">
        <p className="text-sm font-medium">
          {title} <span className="tabular font-normal text-fg-muted">{total}</span>
        </p>
        <label className="sr-only" htmlFor="rail-filter">
          Filter this queue
        </label>
        <input
          id="rail-filter"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="Filter by claim, name or journal"
          className="h-8 w-full rounded-md bg-surface px-2.5 text-sm shadow-well ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent max-sm:h-10"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <SkeletonRows rows={6} rowHeight={56} className="p-3" />
        ) : isError ? (
          <div className="p-3">
            <ErrorState title="Could not load the queue" message="Nothing has been lost." onRetry={onRetry} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-3">
            <EmptyState
              icon={Inbox}
              title={filter ? "No claim matches" : "Nothing waiting"}
              message={filter ? `${total} are waiting in all.` : "Every claim here has been dealt with."}
            />
          </div>
        ) : (
          <ul ref={listRef} className="divide-y divide-line">
            {rows.map((c) => {
              const current = c.id === currentId
              return (
                <li key={c.id}>
                  <Link
                    to={hrefFor(c.id)}
                    replace
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "flex items-start gap-2.5 px-3 py-2.5 hover:bg-hover focus-visible:bg-hover",
                      current && "bg-selected"
                    )}
                  >
                    <Avatar
                      person={{ name: c.owner_name, initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">{c.owner_name}</span>
                        <span className={cn("shrink-0 text-xs tabular", waitTone(c.waiting_days))}>{waitingLabel(c.waiting_days)}</span>
                      </span>
                      <span className="line-clamp-2 break-words text-sm leading-snug text-fg-muted">{paperTitle(c.paper_title)}</span>
                      <span className="block truncate text-xs text-fg-subtle">
                        <span className="tabular">{c.ticket_number || "No claim no."}</span>
                        {c.on_hold ? " · On hold" : ""}
                        {c.duplicate_warning ? " · Possible duplicate" : ""}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
