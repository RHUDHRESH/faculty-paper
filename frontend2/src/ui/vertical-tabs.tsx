import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/cn"

/**
 * A short list of views of the same thing, chosen from a strip.
 *
 * On a desk it is a vertical tab list standing on the left of what it
 * controls: the current view has a bar on its left edge and a tinted ground,
 * the others are muted. On a phone the same tabs become a segmented control
 * across the top, in a recessed track with the chosen segment raised, because
 * a column of three words beside a table leaves the table no room.
 *
 * It is one ARIA tab list either way (`tablist` > `tab`), one tab stop, and
 * the arrow keys move and select: Up and Down on the desk, Left and Right on a
 * phone, and either pair works on both, with Home and End jumping. The page
 * owns the panel: give it `role="tabpanel"`, `id={`${idPrefix}-${id}`}` and
 * `aria-labelledby={`${idPrefix}-tab-${id}`}`.
 *
 * Use `Tabs` for tabs that sit on a hairline above their content, and
 * `Segmented` for a choice that is not a view. Use this one for the period of
 * a board: monthly, yearly, all time.
 */
export type StripItem = { id: string; label: string }

const PHONE = "(max-width: 47.99rem)"

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const m = window.matchMedia(PHONE)
    const on = () => setPhone(m.matches)
    on()
    m.addEventListener?.("change", on)
    return () => m.removeEventListener?.("change", on)
  }, [])
  return phone
}

export function VerticalTabs({
  value,
  onChange,
  items,
  label,
  idPrefix = "strip",
  className,
}: {
  value: string
  onChange: (id: string) => void
  items: StripItem[]
  /** What the tabs choose between, for a screen reader. */
  label: string
  idPrefix?: string
  className?: string
}) {
  const phone = usePhone()
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  function move(to: number) {
    const next = items[(to + items.length) % items.length]
    onChange(next.id)
    refs.current[next.id]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation={phone ? "horizontal" : "vertical"}
      data-variant={phone ? "segmented" : "vertical"}
      className={cn(
        phone ? "well grid auto-cols-fr grid-flow-col gap-0.5 p-0.5" : "flex flex-col gap-1 border-l border-edge",
        className
      )}
      onKeyDown={(e) => {
        const i = items.findIndex((t) => t.id === value)
        const to =
          e.key === "ArrowDown" || e.key === "ArrowRight"
            ? i + 1
            : e.key === "ArrowUp" || e.key === "ArrowLeft"
              ? i - 1
              : e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : null
        if (to === null) return
        e.preventDefault()
        move(to)
      }}
    >
      {items.map((t) => {
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
              "select-none whitespace-nowrap text-sm transition-[background-color,color,box-shadow] duration-[var(--dur-1)] ease-out",
              phone
                ? cn(
                    "inline-flex h-10 items-center justify-center rounded-[0.5rem] px-3",
                    on
                      ? "bg-surface font-semibold text-fg shadow-raise ring-1 ring-inset ring-control-edge"
                      : "font-medium text-fg-muted hover:bg-hover hover:text-fg active:bg-active"
                  )
                : cn(
                    "relative -ml-px flex h-10 items-center rounded-r-control border-l-[3px] px-4 text-left",
                    on
                      ? "border-action bg-hover/60 font-semibold text-fg"
                      : "border-transparent font-medium text-fg-muted hover:border-control-edge hover:bg-hover/60 hover:text-fg active:bg-active"
                  )
            )}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
