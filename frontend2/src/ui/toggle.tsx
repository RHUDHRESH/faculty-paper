import { useRef } from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/cn"

/**
 * The two kinds of control that are a choice rather than an action, drawn so
 * they read as pressable and so the chosen one is unmistakable.
 *
 *   FilterChip   a pill that switches one filter on or off (aria-pressed).
 *                Off: surface and outline. On: clay wash, clay outline and a
 *                tick, so selection never rests on colour alone.
 *   Segmented    one choice out of two to five, in a recessed track: the
 *                chosen segment is a raised surface. Arrow keys move.
 *
 * Both are 32px tall on a desk and 40px on a phone, like `Button size="sm"`.
 * `chipClass` / `segmentClass` are exported for a control that must stay a
 * link or carry its own element (a filter that is a router link).
 */
export function chipClass(on: boolean, extra?: string): string {
  return cn(
    "inline-flex h-8 max-sm:h-10 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-medium",
    "ring-1 ring-inset transition-[background-color,color,box-shadow] duration-[var(--dur-1)] ease-out",
    "[&_svg]:size-3.5 [&_svg]:shrink-0",
    on
      ? "bg-accent-wash text-accent ring-accent hover:bg-accent-line/60"
      : "bg-surface text-fg ring-control-edge shadow-raise hover:bg-hover hover:ring-field active:bg-active active:shadow-press",
    extra
  )
}

export function FilterChip({
  on,
  onClick,
  children,
  count,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "onClick"> & {
  on: boolean
  onClick: () => void
  /** A figure after the label ("Waiting 24"), in tabular numerals. */
  count?: number | string | null
}) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={chipClass(on, className)} {...props}>
      {on && <Check aria-hidden strokeWidth={2.5} />}
      {children}
      {count != null && <span className={cn("tabular text-xs", on ? "text-accent" : "text-fg-muted")}>{count}</span>}
    </button>
  )
}

export function segmentClass(on: boolean, extra?: string): string {
  return cn(
    "inline-flex h-7 max-sm:h-9 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[0.5rem] px-3 text-sm",
    "transition-[background-color,color,box-shadow] duration-[var(--dur-1)] ease-out",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    on
      ? "bg-surface font-semibold text-fg shadow-raise ring-1 ring-inset ring-control-edge"
      : "font-medium text-fg-muted hover:bg-hover hover:text-fg active:bg-active",
    extra
  )
}

export type SegmentItem = { id: string; label: React.ReactNode; icon?: React.ReactNode; "aria-label"?: string }

export function Segmented({
  value,
  onChange,
  items,
  label,
  className,
}: {
  value: string
  onChange: (id: string) => void
  items: SegmentItem[]
  /** What the segments choose between, for a screen reader. */
  label: string
  className?: string
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  function move(to: number) {
    const next = items[(to + items.length) % items.length]
    onChange(next.id)
    refs.current[next.id]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("well inline-flex items-center gap-0.5 p-0.5 max-sm:p-0.5", className)}
      onKeyDown={(e) => {
        const i = items.findIndex((s) => s.id === value)
        const to =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? i + 1
            : e.key === "ArrowLeft" || e.key === "ArrowUp"
              ? i - 1
              : null
        if (to === null) return
        e.preventDefault()
        move(to)
      }}
    >
      {items.map((s) => {
        const on = s.id === value
        return (
          <button
            key={s.id}
            ref={(el) => {
              refs.current[s.id] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={s["aria-label"]}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(s.id)}
            className={segmentClass(on)}
          >
            {s.icon}
            {s.label}
          </button>
        )
      })}
    </div>
  )
}
