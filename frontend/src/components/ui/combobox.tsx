"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronsUpDown, Search } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A dropdown you can type into.
 *
 * The department picker holds thirty-one options, the journal filters hundreds,
 * and every one of them was a plain select: open it and scroll, with no way to
 * jump. Native selects at least jump on a typed letter; a styled listbox does
 * not, so this app's dropdowns were strictly worse than the browser's own.
 *
 * Keyboard behaviour is the point, not decoration:
 *
 * - Type to narrow, matching anywhere in the label rather than only at the
 *   start — people search a department by "mech", not by "D".
 * - Up/Down move, Home/End jump, Enter picks, Escape closes and returns focus
 *   to the button, which is where the reader was.
 * - The listbox is described with the roles a screen reader needs, and the
 *   active option is announced through aria-activedescendant rather than by
 *   moving focus, so typing continues to reach the search box.
 * - Nothing is chosen implicitly: closing without pressing Enter leaves the
 *   value alone.
 */

export type ComboOption = { value: string; label: string; hint?: string }

export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Type to filter…",
  id,
  className,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: ComboOption[]
  placeholder?: string
  searchPlaceholder?: string
  id?: string
  className?: string
  disabled?: boolean
  "aria-label"?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const selected = options.find((o) => o.value === value)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    // Anywhere in the label, and the ones that start with it first — "mech"
    // should find Mechanical before Biomechanics.
    const hits = options.filter((o) => o.label.toLowerCase().includes(q))
    return hits.sort((a, b) => {
      const as = a.label.toLowerCase().startsWith(q) ? 0 : 1
      const bs = b.label.toLowerCase().startsWith(q) ? 0 : 1
      return as - bs
    })
  }, [options, query])

  useEffect(() => {
    if (!open) return
    setQuery("")
    const i = options.findIndex((o) => o.value === value)
    setActive(i < 0 ? 0 : i)
    const t = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => setActive(0), [query])

  // Keep the highlighted row in view when the arrows run past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [active])

  // Clicking away closes without choosing anything.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  function pick(option: ComboOption) {
    onChange(option.value)
    setOpen(false)
    buttonRef.current?.focus()
  }

  const listId = `${id || "combo"}-list`

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            setOpen(true)
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input",
          "bg-transparent px-3 py-2 text-sm shadow-xs transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        <span className={cn("min-w-0 truncate", !selected && "text-muted-foreground")}>
          {selected?.label || placeholder}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
      </button>

      {open ? (
        <div
          className={cn(
            "absolute z-50 mt-1 w-full min-w-[12rem] overflow-hidden rounded-md border border-border",
            "bg-popover text-popover-foreground shadow-lg",
            "animate-in fade-in-0 zoom-in-95 duration-100"
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              aria-activedescendant={
                shown[active] ? `${listId}-${active}` : undefined
              }
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault()
                  setActive((i) => Math.min(i + 1, shown.length - 1))
                } else if (e.key === "ArrowUp") {
                  e.preventDefault()
                  setActive((i) => Math.max(i - 1, 0))
                } else if (e.key === "Home") {
                  e.preventDefault()
                  setActive(0)
                } else if (e.key === "End") {
                  e.preventDefault()
                  setActive(shown.length - 1)
                } else if (e.key === "Enter") {
                  e.preventDefault()
                  if (shown[active]) pick(shown[active])
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  setOpen(false)
                  buttonRef.current?.focus()
                } else if (e.key === "Tab") {
                  setOpen(false)
                }
              }}
            />
          </div>

          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-64 overflow-y-auto p-1"
          >
            {shown.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing matches “{query.trim()}”.
              </li>
            ) : (
              shown.map((o, i) => {
                const isSelected = o.value === value
                return (
                  <li
                    key={o.value}
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                      i === active && "bg-accent text-accent-foreground"
                    )}
                  >
                    <Check
                      className={cn("size-4 shrink-0", isSelected ? "opacity-100" : "opacity-0")}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>
                    ) : null}
                  </li>
                )
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
