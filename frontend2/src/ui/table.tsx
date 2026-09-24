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

/** The sticky, pinned `<th>` — for bespoke table markup that wants the same
 *  head this component uses internally.
 *
 *  Two changes from a plain sticky head, both of them about the fact that
 *  this thing is genuinely in front of the rows:
 *
 *  `bg-sunken` rather than `bg-surface`. The head sat on the same white as
 *  the body, so the column names read as row zero — and in a grid whose
 *  first row is often a total, that is a real misreading and not a stylistic
 *  one. A tinted ground makes the head chrome.
 *
 *  `shadow-under` while, and only while, rows are actually passing beneath
 *  it. A permanent drop shadow under a head is decoration; one that appears
 *  on the first pixel of scroll is the answer to "am I still at the top of
 *  this list, or have I lost the first twenty rows above the fold" — which
 *  a pinned head otherwise hides completely. `TableScroller` sets the
 *  `data-scrolled` flag this reads. */
export const stickyHeadCell = cn(
  "sticky top-0 z-10 whitespace-nowrap bg-sunken px-3 py-2 text-left",
  "border-b border-edge",
  "transition-shadow duration-[var(--dur-2)] ease-out",
  "group-data-[scrolled]/scroll:shadow-under"
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
  // Vertical, for the pinned head: rows are passing under it, so it has to
  // say so. Same slack as the horizontal edges, for the same reason.
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return

    function update() {
      if (!scroller) return
      const max = scroller.scrollWidth - scroller.clientWidth
      setShowLeft(scroller.scrollLeft > EDGE_SLACK)
      setShowRight(scroller.scrollLeft < max - EDGE_SLACK)
      setScrolled(scroller.scrollTop > EDGE_SLACK)
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
        // `bg-surface`, not the page's own ground. The page is a hair off
        // white and a grid is the biggest object on most screens in this
        // app; sitting it on plain surface is what makes it read as a thing
        // resting on the page rather than as a rectangle ruled onto it. It
        // gets no drop shadow — a table is not pressable, does not float,
        // and is not the page's one answer, so none of the elevation steps
        // apply to it. The tone step and the `edge` hairline are the whole
        // treatment.
        className="group/scroll overflow-auto rounded-lg bg-surface ring-1 ring-inset ring-edge"
        data-scrolled={scrolled ? "" : undefined}
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
  isCurrent,
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
  /** The one row that is the reader's own — their place on a leaderboard.
   *  Marked for assistive technology (`aria-current`) and tinted, because
   *  finding yourself in four hundred rows by reading names is the job this
   *  saves. */
  isCurrent?: (row: T) => boolean
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
      // Sunken, where a populated grid is `surface`. An empty state drawn on
      // the same white as a full one is a container that might simply have
      // failed to paint; a recessed tray reads as a container that is
      // genuinely empty. It also puts more distance between this and an
      // error banner, which must never be confusable with it.
      <div
        className={cn(
          "rounded-lg px-6 py-16 text-center text-sm text-fg-muted",
          "bg-sunken shadow-well ring-1 ring-inset ring-edge",
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
            const current = isCurrent?.(row) ?? false
            return (
              <tr
                key={getKey(row)}
                aria-current={current ? "true" : undefined}
                className={cn("row border-b border-line last:border-b-0", current && "bg-accent-wash")}
              >
                {columns.map((col, ci) => {
                  const content = col.cell(row, i)
                  const isLead = ci === 0
                  return (
                    <td
                      key={col.key}
                      className={cn(
                        "px-3 py-2.5 align-middle",
                        // Right-aligned means numeric in every table in this
                        // app, and the numeric column is the one a reader
                        // came to scan. `font-medium` against the 400 of the
                        // text columns beside it is what lets the eye run
                        // down the amounts without reading the names — a
                        // step small enough that a whole grid of it does not
                        // read as bold, and `tabular` keeps the digits on a
                        // common rhythm so the column has a straight edge on
                        // both sides.
                        col.align === "right" && "text-right font-medium tabular",
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
