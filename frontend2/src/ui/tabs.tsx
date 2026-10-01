import { useRef } from "react"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"

/**
 * Tabs (DESIGN.md, "Components"): the way to say "the same thing, cut a
 * different way". A hairline under the list; the current tab is ink with a
 * 2px ink bar sitting on the hairline; the others are muted. A count after
 * the label is a real number in tabular figures ("Not claimed 24").
 *
 * Every page used to draw its own, so there were fourteen slightly different
 * ones. This one has the keyboard behaviour of the ARIA pattern: the list is
 * one tab stop, Left and Right move (and select), Home and End jump.
 *
 *   `value`/`onChange`  the selected tab id, controlled by the page.
 *   `tabs`              [{ id, label, count? }]. Four at most; five is a menu.
 *   `label`             what the tabs choose between, for a screen reader.
 *   `idPrefix`          panels carry `role="tabpanel"` and
 *                       `id={`${idPrefix}-${tab.id}`}` and are labelled by
 *                       `${idPrefix}-tab-${tab.id}`.
 *
 * Tabs that are really pages (a route per tab) should be links, not these.
 */
export type TabItem = { id: string; label: string; count?: number | null }

export function Tabs({
  value,
  onChange,
  tabs,
  label,
  idPrefix = "tabs",
  className,
}: {
  value: string
  onChange: (id: string) => void
  tabs: TabItem[]
  label: string
  idPrefix?: string
  className?: string
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  function move(to: number) {
    const next = tabs[(to + tabs.length) % tabs.length]
    onChange(next.id)
    refs.current[next.id]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("flex gap-x-6 overflow-x-auto border-b border-line", className)}
      onKeyDown={(e) => {
        const i = tabs.findIndex((t) => t.id === value)
        const to =
          e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null
        if (to === null) return
        e.preventDefault()
        move(to)
      }}
    >
      {tabs.map((t) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el
            }}
            id={`${idPrefix}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={`${idPrefix}-${t.id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cn(
              "relative -mb-px inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-none px-0.5 text-base",
              "border-b-2 transition-colors duration-[var(--dur-1)]",
              on
                ? "border-fg font-medium text-fg"
                : "border-transparent text-fg-muted hover:border-edge hover:text-fg"
            )}
          >
            {t.label}
            {t.count != null && <span className="tabular text-sm text-fg-subtle">{formatCount(t.count)}</span>}
          </button>
        )
      })}
    </div>
  )
}
