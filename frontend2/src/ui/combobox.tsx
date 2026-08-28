import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/cn"

/**
 * A select you can type into.
 *
 * A styled listbox that only opens and clicks is strictly worse than the
 * browser's native `<select>`, which at least jumps to an option on a
 * keypress — and the department picker has 31 options, journal filters have
 * hundreds. Nobody reads a list that long; they type three letters and
 * expect it to narrow.
 *
 * Built on a plain button and an absolutely positioned panel rather than
 * Radix's Select, which does not leave room for a filter input inside the
 * listbox. Radix's Popover would work but is more machinery than a listbox
 * with a text box at the top needs.
 */

export type ComboboxOption = {
  value: string
  label: string
  hint?: string
}

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
  // `Field` clones id, aria-describedby and aria-invalid onto its child.
  // Destructuring only some of them silently dropped the hint and the error
  // announcement from every <Field><Combobox/></Field> in the app, and it
  // typechecks either way because they are optional -- the exact failure this
  // component's own docstring warns about.
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: {
  value: string | null
  onChange: (value: string) => void
  options: ComboboxOption[]
  placeholder?: string
  searchPlaceholder?: string
  id?: string
  className?: string
  disabled?: boolean
  "aria-label"?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean | "true" | "false"
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [highlighted, setHighlighted] = useState(0)

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const listId = useId()
  const optionId = (i: number) => `${listId}-opt-${i}`

  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value])

  // Anywhere in the label counts as a match, but a label that STARTS with
  // the term goes first — typing "mech" should surface Mechanical before
  // Biomechanics, not alphabetically-whatever-comes-first between them.
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return options
    const starts: ComboboxOption[] = []
    const contains: ComboboxOption[] = []
    for (const option of options) {
      const at = option.label.toLowerCase().indexOf(term)
      if (at === 0) starts.push(option)
      else if (at > 0) contains.push(option)
    }
    return [...starts, ...contains]
  }, [options, query])

  // Opening always starts from a clean search, and closing (either way)
  // invalidates whatever was highlighted so a stale index from a longer
  // list can't survive into a shorter one.
  useEffect(() => {
    if (open) {
      setQuery("")
      const t = setTimeout(() => searchRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => setHighlighted(0), [query, open])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector(`[data-i="${highlighted}"]`)?.scrollIntoView({ block: "nearest" })
  }, [highlighted, open])

  // Outside click closes without picking anything — the value only ever
  // changes on Enter or a direct click on an option.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  function pick(option: ComboboxOption) {
    onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setHighlighted((i) => Math.min(i + 1, filtered.length - 1))
        break
      case "ArrowUp":
        e.preventDefault()
        setHighlighted((i) => Math.max(i - 1, 0))
        break
      case "Home":
        e.preventDefault()
        setHighlighted(0)
        break
      case "End":
        e.preventDefault()
        setHighlighted(filtered.length - 1)
        break
      case "Enter":
        e.preventDefault()
        if (filtered[highlighted]) pick(filtered[highlighted])
        break
      case "Escape":
        // Closes without choosing. Focus goes back to the trigger, not
        // wherever Escape happened to leave it, so the next Tab is sane.
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        break
      case "Tab":
        // No preventDefault: focus is left to move on as it normally would,
        // the panel just should not still be open when it gets there.
        setOpen(false)
        break
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-2 rounded-md bg-surface px-2.5 text-sm",
          "ring-1 ring-inset ring-field outline-none",
          "focus-visible:ring-2 focus-visible:ring-accent",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
      >
        <span className={cn("truncate text-left", !selected && "text-fg-subtle")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-20 w-full min-w-[14rem] rounded-lg bg-surface shadow-pop">
          <div className="border-b border-line p-1.5">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={filtered[highlighted] ? optionId(highlighted) : undefined}
              aria-autocomplete="list"
              className="h-7 w-full bg-transparent px-1.5 text-sm outline-none placeholder:text-fg-subtle"
            />
          </div>

          <ul ref={listRef} id={listId} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="px-2.5 py-6 text-center text-sm text-fg-muted">
                Nothing matches &quot;{query.trim()}&quot;.
              </li>
            ) : (
              filtered.map((option, i) => {
                const on = i === highlighted
                const isSelected = option.value === value
                return (
                  <li
                    key={option.value}
                    id={optionId(i)}
                    data-i={i}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setHighlighted(i)}
                    onClick={() => pick(option)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                      on && "bg-hover"
                    )}
                  >
                    {/* The checkmark's space is reserved even when absent, so
                        an unselected row is not a pixel narrower than a
                        selected one — a list where rows shift width as you
                        arrow through it reads as broken, not as decoration. */}
                    <Check
                      className={cn("size-3.5 shrink-0 text-accent", !isSelected && "invisible")}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.hint && (
                      <span className="shrink-0 truncate text-xs text-fg-subtle">{option.hint}</span>
                    )}
                  </li>
                )
              })
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
