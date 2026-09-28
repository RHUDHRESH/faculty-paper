import { Search } from "lucide-react"
import { forwardRef } from "react"

import { cn } from "@/lib/cn"

export const SEARCH_SCOPES = [
  { id: "all", label: "All" },
  { id: "papers", label: "Papers" },
  { id: "people", label: "People" },
  { id: "journals", label: "Journals" },
  { id: "topics", label: "Topics" },
  { id: "departments", label: "Departments" },
  { id: "pages", label: "Pages" },
] as const
export type SearchScope = (typeof SEARCH_SCOPES)[number]["id"]

/**
 * The Search page's input (docs/ux/00 §8): 64px, rounded-2xl, 20px text,
 * leading 24px Search icon, trailing Ctrl K hint, scope chips beneath.
 *
 * A shell only: the page owns the query and renders results as `children`
 * with the same renderer as the palette (app/palette.tsx).
 */
export const BigSearch = forwardRef<
  HTMLInputElement,
  {
    value: string
    onChange: (value: string) => void
    onSubmit?: (value: string) => void
    scope?: SearchScope
    onScope?: (scope: SearchScope) => void
    placeholder?: string
    label?: string
    /** Hide the scope chips (e.g. an embedded search on Home). */
    hideScopes?: boolean
    children?: React.ReactNode
    className?: string
  }
>(function BigSearch(
  {
    value,
    onChange,
    onSubmit,
    scope = "all",
    onScope,
    placeholder = "Search papers, people, journals, topics…",
    label = "Search",
    hideScopes,
    children,
    className,
  },
  ref
) {
  return (
    <div className={cn("w-full", className)}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit?.(value)
        }}
        className="relative"
      >
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-5 size-6 -translate-y-1/2 text-fg-subtle" strokeWidth={1.75} />
        <input
          ref={ref}
          type="search"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-16 w-full rounded-3xl bg-surface pr-24 pl-14 text-lg text-fg shadow-[inset_0_0_0_1px_var(--color-edge),0_2px_12px_-4px_rgb(43_42_39/0.08)] placeholder:text-fg-subtle focus:shadow-[inset_0_0_0_1px_var(--color-accent-line),0_2px_16px_-4px_rgb(43_42_39/0.12)] focus:outline-none max-sm:text-lg"
        />
        <kbd
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-5 -translate-y-1/2 rounded-md bg-sunken px-2 py-0.5 font-sans text-xs text-fg-muted shadow-[inset_0_0_0_1px_var(--color-line)] max-sm:hidden"
        >
          Ctrl K
        </kbd>
      </form>
      {!hideScopes && (
        <div role="tablist" aria-label="Search in" className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {SEARCH_SCOPES.map((s) => {
            const on = s.id === scope
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onScope?.(s.id)}
                className={cn(
                  "h-8 shrink-0 rounded-full px-3 text-sm transition-colors duration-[var(--dur-1)]",
                  on
                    ? "bg-accent text-accent-fg"
                    : "bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-hover"
                )}
              >
                {s.label}
              </button>
            )
          })}
        </div>
      )}
      {children}
    </div>
  )
})
