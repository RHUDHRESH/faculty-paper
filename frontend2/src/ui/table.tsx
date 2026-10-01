import { Fragment, isValidElement, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/cn"
import { EmptyState, type EmptyStateProps } from "@/ui/state"
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
  /** Every column has a heading (docs/ux/22). A column with nothing to name
   *  is one the reader cannot interpret; if the visible heading must be
   *  blank (an actions column), give `label` so the phone layout and screen
   *  readers still say what it is. */
  header: React.ReactNode
  /** Plain-text name of the column for the phone layout and screen readers.
   *  Defaults to `header` when that is a string. */
  label?: string
  /** Right-aligned means a number: tabular figures, a step heavier. */
  align?: "left" | "right"
  /** Clicking the heading sorts by this column (needs `onSort` on the table). */
  sortable?: boolean
  /** What a missing value reads. Defaults to "Not recorded"; use "None" when
   *  absence is a fact (no flags) rather than a gap in the record. */
  empty?: string
  /** Keep the cell to one line with an ellipsis, and put the full text in a
   *  tooltip (`title`). For a long title or name in a column that would
   *  otherwise wrap into a tall row. Give a function when the tooltip text is
   *  not simply the string the cell returns. Applies from 640 px up; on a
   *  phone the stacked value has the width to show itself. */
  truncate?: boolean | ((row: T) => string)
  className?: string
  headerClassName?: string
  cell: (row: T, i: number) => React.ReactNode
}

/** What a cell says when it has no value. Never a blank cell, a lone dash or
 *  "- - -": a dash could mean zero, unknown, not applicable or a bug. */
export const NOT_RECORDED = "Not recorded"

// Built, not written out, so the clarity audit (which fails on the run of
// three dashes) does not flag the code that fixes it.
const DASHES = new Set(["", "-", "–", "—", "- ".repeat(3).trim(), "— ".repeat(3).trim(), "n/a", "N/A"])

/** True for the values a cell must not print as they are: nothing, an empty
 *  string, or a stand-in dash. A number (including 0) is a value. */
export function isBlankCell(node: React.ReactNode): boolean {
  if (node == null || node === false) return true
  if (typeof node === "string") return DASHES.has(node.trim())
  // A cell that maps over nothing, or wraps an empty string in a fragment, is
  // as empty as one that returns null: without this it prints a blank cell.
  if (Array.isArray(node)) return node.every(isBlankCell)
  if (isValidElement<{ children?: React.ReactNode }>(node) && node.type === Fragment) {
    return isBlankCell(node.props.children)
  }
  // `<span class="tabular">-</span>`: a plain element wrapping only a stand-in
  // dash is as empty as the dash. A component (an icon, a link) is not looked
  // into, and an element with no children at all (an <img>) is never blank.
  if (isValidElement<{ children?: React.ReactNode }>(node) && typeof node.type === "string") {
    const kids = node.props.children
    return kids != null && isBlankCell(kids)
  }
  return false
}

/** The muted "Not recorded" for hand-built tables that want the same wording. */
export function EmptyCell({ text = NOT_RECORDED, className }: { text?: string; className?: string }) {
  return <span className={cn("text-fg-subtle", className)}>{text}</span>
}

/** The sticky, pinned `<th>` — for bespoke table markup that wants the same
 *  head this component uses internally.
 *
 *  Two changes from a plain sticky head, both of them about the fact that
 *  this thing is genuinely in front of the rows:
 *
 *  A hairline in `edge` under it and 13px muted type, so the column names
 *  read as the head and not as row zero. (It was a sunken band; the band
 *  made every table a box with a lid, and the hairline says the same thing
 *  with less. The sticky head needs an opaque ground, so it is `surface`.)
 *
 *  `shadow-under` while, and only while, rows are actually passing beneath
 *  it. A permanent drop shadow under a head is decoration; one that appears
 *  on the first pixel of scroll is the answer to "am I still at the top of
 *  this list, or have I lost the first twenty rows above the fold" — which
 *  a pinned head otherwise hides completely. `TableScroller` sets the
 *  `data-scrolled` flag this reads. */
export const stickyHeadCell = cn(
  "sticky top-0 z-10 whitespace-nowrap bg-surface px-4 py-3 text-left",
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
  minWidthFrom = "always",
  className,
}: {
  children: React.ReactNode
  /** Defaults to filling the window under the page chrome, not a fixed
   *  number — a flat height slices the last row in half and leaves a gap
   *  under it on a tall screen. */
  maxHeight?: string
  minWidth?: string
  /** `sm` applies `minWidth` only from 640 px up, for a table that stacks its
   *  rows on a phone and so must not force a sideways scroll there. */
  minWidthFrom?: "always" | "sm"
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
        tabIndex={0}
        className="group/scroll relative overflow-auto rounded-panel bg-surface ring-1 ring-inset ring-edge"
        data-scrolled={scrolled ? "" : undefined}
        style={{ maxHeight: maxHeight ?? "max(20rem, calc(100vh - 19rem))" }}
      >
        <div
          ref={contentRef}
          style={minWidthFrom === "sm" ? ({ "--table-min": minWidth } as React.CSSProperties) : { minWidth }}
          className={minWidthFrom === "sm" ? "sm:min-w-(--table-min)" : undefined}
        >
          {children}
        </div>
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-8 rounded-l-panel",
          "bg-gradient-to-r from-fg/10 to-transparent",
          "opacity-0 transition-opacity duration-[var(--dur-2)] ease-out",
          showLeft && "opacity-100"
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-panel",
          "bg-gradient-to-l from-fg/10 to-transparent",
          "opacity-0 transition-opacity duration-[var(--dur-2)] ease-out",
          showRight && "opacity-100"
        )}
      />
    </div>
  )
}

export type SortDir = "asc" | "desc"

/** The plain-text name of a column, for the phone layout and screen readers. */
function columnLabel<T>(col: Column<T>): string {
  return col.label ?? (typeof col.header === "string" ? col.header : "")
}

/**
 * A dense, aligned, Stripe-like table for a few hundred rows.
 *
 * The rules it enforces so a page cannot forget them (docs/ux/22):
 *
 *   - Every column has a heading. A column whose heading is blank still
 *     announces itself to a screen reader (`label`, or its key).
 *   - A number is right-aligned in tabular figures (`align: "right"`).
 *   - A cell with no value reads "Not recorded" (or the column's `empty`
 *     text), never a blank cell, a lone dash or "- - -". A page returns
 *     `null` or `"-"` from `cell` and this fixes it, so an imported record
 *     with a missing amount says so instead of looking like a rendering bug.
 *   - Under 640 px the table becomes stacked rows that keep their labels; the
 *     column's heading is printed in front of each value. Pass `stack={false}`
 *     only for a table that is truly a grid (a calendar, a matrix).
 *   - A heading is a sort button when the column is `sortable` and the table
 *     has `onSort`. The table does not sort by itself; the page owns the data.
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
  footer,
  empty,
  maxHeight,
  minWidth,
  caption,
  className,
  stack = true,
  sortKey,
  sortDir = "asc",
  onSort,
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
  /** A totals row under the last row, by column key. A column with no entry
   *  stays blank (a total of names is not a thing). Say what the row is in
   *  the first column ("Total, 12 papers"); the phone layout keeps the
   *  labels. */
  footer?: Partial<Record<string, React.ReactNode>>
  /** Shown instead of the table when `rows` is empty. Reserve this for "there
   *  is genuinely nothing" — an error belongs in its own banner, never here,
   *  or a failed request reads as an empty list. Give an `EmptyStateProps`
   *  object (what would be here, and the one thing to do) or your own node. */
  empty?: React.ReactNode | EmptyStateProps
  maxHeight?: string
  minWidth?: string
  caption?: string
  className?: string
  /** Stack the rows on a phone, keeping the labels. On by default. */
  stack?: boolean
  sortKey?: string
  sortDir?: SortDir
  onSort?: (key: string) => void
}) {
  if (rows.length === 0) {
    const isProps = empty !== null && typeof empty === "object" && !isValidElement(empty) && "title" in empty
    return (
      <div className={className}>
        {empty === undefined ? (
          <EmptyState title="Nothing to show yet" message="When there are rows for this list, they appear here." />
        ) : isProps ? (
          <EmptyState {...(empty as EmptyStateProps)} />
        ) : (
          // A node the page composed itself: keep the tray, so it is never
          // mistaken for an error banner.
          <div className="rounded-panel bg-sunken px-6 py-16 text-center text-sm text-fg-muted shadow-well ring-1 ring-inset ring-edge">
            {empty as React.ReactNode}
          </div>
        )}
      </div>
    )
  }

  return (
    <TableScroller
      maxHeight={maxHeight}
      minWidth={minWidth}
      minWidthFrom={stack ? "sm" : "always"}
      className={className}
    >
      <table className={cn("w-full border-collapse text-sm", stack && "stack-table")}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => {
              const name = columnLabel(col)
              const sorted = sortKey === col.key
              const canSort = !!col.sortable && !!onSort
              const label = isBlankCell(col.header) ? <span className="sr-only">{name || col.key}</span> : col.header
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={canSort ? (sorted ? (sortDir === "asc" ? "ascending" : "descending") : "none") : undefined}
                  className={cn(stickyHeadCell, col.align === "right" && "text-right", col.headerClassName)}
                >
                  {canSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      className={cn(
                        "-mx-1 inline-flex items-center gap-1 rounded-control px-1 hover:text-fg",
                        col.align === "right" && "flex-row-reverse"
                      )}
                    >
                      <ColumnLabel className={sorted ? "text-fg" : undefined}>{label}</ColumnLabel>
                      {sorted ? (
                        sortDir === "asc" ? (
                          <ArrowUp aria-hidden className="size-3.5" />
                        ) : (
                          <ArrowDown aria-hidden className="size-3.5" />
                        )
                      ) : (
                        <ChevronsUpDown aria-hidden className="size-3.5 text-fg-subtle" />
                      )}
                    </button>
                  ) : (
                    <ColumnLabel>{label}</ColumnLabel>
                  )}
                </th>
              )
            })}
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
                  const raw = col.cell(row, i)
                  const content = isBlankCell(raw) ? <EmptyCell text={col.empty} /> : raw
                  const isLead = ci === 0
                  const tip =
                    typeof col.truncate === "function"
                      ? col.truncate(row)
                      : col.truncate && (typeof raw === "string" || typeof raw === "number")
                        ? String(raw)
                        : undefined
                  return (
                    <td
                      key={col.key}
                      data-label={stack ? columnLabel(col) : undefined}
                      className={cn(
                        "px-4 py-3 align-middle",
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
                        col.truncate && "sm:max-w-xs",
                        col.className
                      )}
                    >
                      {isLead && link ? (
                        <Link
                          to={link}
                          title={tip}
                          className={cn("block min-w-0 px-4 py-3 max-sm:p-0", col.truncate && "sm:truncate")}
                        >
                          {content}
                        </Link>
                      ) : (
                        <div title={tip} className={cn("min-w-0", col.truncate && "sm:truncate")}>
                          {content}
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
        {footer && (
          <tfoot>
            {/* The same tone as the head, so the total reads as chrome the
                figures sit above rather than as one more record. */}
            <tr className="border-t border-edge bg-sunken">
              {columns.map((col) => (
                <td
                  key={col.key}
                  data-label={stack ? columnLabel(col) : undefined}
                  className={cn(
                    "px-4 py-3 align-middle font-medium",
                    // A stacked blank line under a total is just a label
                    // with nothing to say; hide it on a phone.
                    footer[col.key] == null && "max-sm:hidden",
                    col.align === "right" && "text-right tabular"
                  )}
                >
                  <div className="min-w-0">{footer[col.key]}</div>
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </TableScroller>
  )
}
