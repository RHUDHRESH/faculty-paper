"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

/**
 * One table, for every table.
 *
 * There were five different `<thead>` stylings across the portals and not a
 * single sticky header. Reading row 80 of a payment list meant remembering
 * which column was the amount and which was the SNIP, because the headings had
 * scrolled off the top a screen and a half ago. Wide tables were worse: they
 * sat in a bare `overflow-x-auto` with no edge, no shadow and no scrollbar in
 * view until you had scrolled to the bottom of the page to find it, so columns
 * off the right-hand side simply did not exist as far as the reader knew.
 *
 * What this fixes, in one place:
 *
 * - The header stays put. The table scrolls inside a bounded box, so the
 *   headings are pinned and both scrollbars are next to the thing they move.
 * - The right-hand edge announces itself. A shadow appears when there is more
 *   table that way and goes when you reach the end, so a hidden column is
 *   visibly hidden rather than absent.
 * - Numbers are right-aligned and tabular by declaration, not by each caller
 *   remembering. Money that does not line up cannot be compared down a column.
 * - A row that leads somewhere is a link, so middle-click and "open in new
 *   tab" work — they did not, on rows wired to onClick.
 */

export type Column<T> = {
  key: string
  header: ReactNode
  /** Numbers right, everything else left. */
  align?: "left" | "right"
  /** Tailwind width and clamping classes for this column. */
  className?: string
  /** Header-only classes, when the header needs different treatment. */
  headerClassName?: string
  cell: (row: T, index: number) => ReactNode
}

/**
 * The scroll box, on its own.
 *
 * Not every table in the app can become a `columns` array cheaply -- several
 * are shells that take raw rows, and rewriting their callers would be a large
 * diff for no gain. What those tables actually lacked was this: a header that
 * survives scrolling, and an edge that admits there is more table to the
 * right. Both live here, so a bespoke table can have them by wrapping, and
 * DataTable is built on the same piece rather than a copy of it.
 */
export function TableScroller({
  children,
  maxHeight = "34rem",
  className,
}: {
  children: React.ReactNode
  maxHeight?: string
  className?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ left: false, right: false })

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => {
      const more = el.scrollWidth - el.clientWidth
      setEdge({
        left: el.scrollLeft > 4,
        // A couple of pixels of slack: sub-pixel layout leaves a permanent
        // 1px overflow on tables that in fact fit, and a shadow that never
        // goes away stops meaning anything.
        right: more > 4 && el.scrollLeft < more - 4,
      })
    }
    measure()
    el.addEventListener("scroll", measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // Rows arriving later change the width, and a MutationObserver is the
    // only thing that hears about it when the caller owns the markup.
    const mo = new MutationObserver(measure)
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener("scroll", measure)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  return (
    <div className={cn("relative overflow-hidden", className)}>
      <div
        ref={scroller}
        className="overflow-auto overscroll-x-contain"
        style={{ maxHeight }}
      >
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background/70 to-transparent transition-opacity",
          edge.left ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background/70 to-transparent transition-opacity",
          edge.right ? "opacity-100" : "opacity-0"
        )}
      />
    </div>
  )
}

/**
 * What a `<th>` needs to stay put, for tables that write their own.
 *
 * Sticky only works if no ancestor between here and the scroll box has
 * `overflow: hidden` -- that ancestor becomes the containing block and the
 * header pins itself to the top of a box that scrolls away whole.
 */
export const stickyHeadCell =
  "sticky top-0 z-10 whitespace-nowrap border-b border-border bg-card px-3 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"

export function DataTable<T>({
  rows,
  columns,
  getKey,
  rowLink,
  empty = "Nothing to show",
  maxHeight = "34rem",
  minWidth,
  caption,
  className,
}: {
  rows: T[]
  columns: Column<T>[]
  getKey: (row: T, index: number) => string
  /** When a row leads somewhere, give it a URL rather than a click handler. */
  rowLink?: (row: T) => string | null
  empty?: ReactNode
  /** The box scrolls past this; the header stays. */
  maxHeight?: string
  /** Below this the table scrolls sideways instead of crushing columns. */
  minWidth?: string
  caption?: ReactNode
  className?: string
}) {
  if (!rows.length) {
    return (
      <div className={cn("surface-card px-4 py-10 text-center", className)}>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    )
  }

  return (
    <TableScroller maxHeight={maxHeight} className={cn("surface-card", className)}>
        <table
          className="w-full border-collapse text-left text-sm"
          style={minWidth ? { minWidth } : undefined}
        >
          {caption ? (
            <caption className="px-4 pb-2 pt-3 text-left text-xs text-muted-foreground">
              {caption}
            </caption>
          ) : null}
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    stickyHeadCell,
                    c.align === "right" && "text-right",
                    c.headerClassName
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const to = rowLink?.(row) || null
              return (
                <tr
                  key={getKey(row, i)}
                  className={cn(
                    "border-b border-border/50 last:border-0",
                    to && "transition-colors hover:bg-muted/50"
                  )}
                >
                  {columns.map((c, ci) => {
                    const content = c.cell(row, i)
                    return (
                      <td
                        key={c.key}
                        className={cn(
                          "px-3 py-2 align-middle",
                          c.align === "right" && "text-right tabular-nums",
                          c.className
                        )}
                      >
                        {/* The link covers the first cell only: a whole-row
                            anchor swallows the buttons and links inside the
                            other cells, which is how a table ends up with
                            exactly one thing you can click. */}
                        {to && ci === 0 ? (
                          <Link
                            to={to}
                            className="interactive block text-primary underline-offset-4 hover:underline"
                          >
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
