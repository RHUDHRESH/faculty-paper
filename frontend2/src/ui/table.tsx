import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { ColumnLabel } from "@/ui/text"

/**
 * The Stripe-like table: a bounded, scrolling grid for the lists that run to
 * hundreds of rows and a dozen columns — payments, tickets, faculty.
 *
 * Three things a plain `<table>` does not give you, all needed at once:
 *
 *   1. A sticky head. Scroll to row 80 of a payment list without the column
 *      names pinned above it and you are guessing which figure is the
 *      amount and which is the balance.
 *   2. A bounded height. A page is not the place for an 800-row `<table>` to
 *      simply run to its natural length — the surrounding layout (filters,
 *      pagination, the page chrome) has to stay reachable without scrolling
 *      the whole document past it.
 *   3. Edge shadows on a table wider than its box, so a column sitting just
 *      off the right edge reads as "more, scroll for it" rather than as
 *      "that is all the columns there are".
 *
 * `TableScroller` and `stickyHeadCell` are exported separately because a
 * handful of pages need bespoke `<table>` markup (a rowspan, a footer row)
 * and should still get the same scrolling and shadow behaviour rather than
 * reinventing it worse.
 */

export type Column<T> = {
  key: string
  header: React.ReactNode
  align?: "left" | "right"
  className?: string
  headerClassName?: string
  cell: (row: T, i: number) => React.ReactNode
}

/** The sticky, bordered, surface-coloured `<th>` — for bespoke table markup
 *  that wants the same pinned head this component uses internally. */
export const stickyHeadCell = cn(
  "sticky top-0 z-10 whitespace-nowrap bg-surface px-3 py-2 text-left",
  "border-b border-edge"
)

// A shadow that never fully disappears because the content is one
// sub-pixel wider than the box reads as a bug, not as "more to see" — so a
// few pixels of slack before either edge shadow is allowed to show.
const EDGE_SLACK = 4

/**
 * The scroll box and its edge shadows, on their own, so a page with its own
 * `<table>` markup can wrap it and get sticky heads and "there is more this
 * way" shading for free.
 */
export function TableScroller({
  children,
  maxHeight,
  minWidth,
  className,
}: {
  children: React.ReactNode
  /** Defaults to filling the window under the page chrome, not a fixed
   *  number — a flat height slices the last row in half and leaves a gap
   *  under it on a tall screen. */
  maxHeight?: string
  minWidth?: string
  className?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [showLeft, setShowLeft] = useState(false)
  const [showRight, setShowRight] = useState(false)

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return

    function update() {
      if (!scroller) return
      const max = scroller.scrollWidth - scroller.clientWidth
      setShowLeft(scroller.scrollLeft > EDGE_SLACK)
      setShowRight(scroller.scrollLeft < max - EDGE_SLACK)
    }

    update()
    scroller.addEventListener("scroll", update, { passive: true })
    // The container can stay the same size while its content (a table
    // gaining a column, a filter narrowing rows) changes width, so both the
    // box and the content inside it are watched.
    const ro = new ResizeObserver(update)
    ro.observe(scroller)
    if (contentRef.current) ro.observe(contentRef.current)

    return () => {
      scroller.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [])

  return (
    <div className={cn("relative", className)}>
      <div
        ref={scrollRef}
        className="overflow-auto rounded-lg ring-1 ring-inset ring-edge"
        style={{ maxHeight: maxHeight ?? "max(20rem, calc(100vh - 19rem))" }}
      >
        <div ref={contentRef} style={{ minWidth }}>
          {children}
        </div>
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-8 rounded-l-lg",
          "bg-gradient-to-r from-fg/10 to-transparent",
          "opacity-0 transition-opacity duration-[var(--dur-2)] ease-out",
          showLeft && "opacity-100"
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-lg",
          "bg-gradient-to-l from-fg/10 to-transparent",
          "opacity-0 transition-opacity duration-[var(--dur-2)] ease-out",
          showRight && "opacity-100"
        )}
      />
    </div>
  )
}

/**
 * A dense, aligned, Stripe-like table for a few hundred rows.
 *
 * `rowLink` anchors only the first cell, not the row: a whole-row `<a>`
 * swallows every button and link nested in the other cells (a "remind",
 * a "download", a person's own name linking elsewhere), so only the lead
 * cell — the one that reads as the row's title — becomes the link.
 */
export function Table<T>({
  rows,
  columns,
  getKey,
  rowLink,
  empty,
  maxHeight,
  minWidth,
  caption,
  className,
}: {
  rows: T[]
  columns: Column<T>[]
  getKey: (row: T) => string
  rowLink?: (row: T) => string | null
  /** Shown instead of the table when `rows` is empty. Reserve this for "there
   *  is genuinely nothing" — an error belongs in its own banner, never here,
   *  or a failed request reads as an empty list. */
  empty?: React.ReactNode
  maxHeight?: string
  minWidth?: string
  caption?: string
  className?: string
}) {
  if (rows.length === 0) {
    return (
      <div
        className={cn(
          "rounded-lg px-6 py-16 text-center text-sm text-fg-muted",
          "ring-1 ring-inset ring-edge",
          className
        )}
      >
        {empty ?? "Nothing here."}
      </div>
    )
  }

  return (
    <TableScroller maxHeight={maxHeight} minWidth={minWidth} className={className}>
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(stickyHeadCell, col.align === "right" && "text-right", col.headerClassName)}
              >
                <ColumnLabel>{col.header}</ColumnLabel>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const link = rowLink?.(row) ?? null
            return (
              <tr key={getKey(row)} className="row border-b border-line last:border-b-0">
                {columns.map((col, ci) => {
                  const content = col.cell(row, i)
                  const isLead = ci === 0
                  return (
                    <td
                      key={col.key}
                      className={cn(
                        "px-3 py-2.5 align-middle",
                        col.align === "right" && "text-right tabular",
                        isLead && link && "p-0",
                        col.className
                      )}
                    >
                      {isLead && link ? (
                        <Link to={link} className="block px-3 py-2.5">
                          {content}
                        </Link>
                      ) : (
                        content
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableScroller>
  )
}
