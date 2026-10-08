import { Search } from "lucide-react"
import { forwardRef, useState } from "react"
import { useNavigate } from "react-router-dom"

import { cn } from "@/lib/cn"
import { KbdChord } from "@/ui/kbd"
import { chipClass } from "@/ui/toggle"

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
          className="h-16 w-full rounded-3xl bg-surface pr-24 pl-14 text-lg text-fg ring-1 ring-line placeholder:text-fg-subtle focus:ring-accent-line focus:outline-none max-sm:text-lg"
        />
        <KbdChord
          keys={["Ctrl", "K"]}
          className="pointer-events-none absolute top-1/2 right-5 -translate-y-1/2 text-fg-muted max-sm:hidden"
        />
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
                className={chipClass(on)}
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

/** Home's centred composer-style search (Claude-like): type, press Enter, land on Search. */
export function HomeSearch({ className }: { className?: string }) {
  const [q, setQ] = useState("")
  const nav = useNavigate()
  return (
    <div className={cn("mx-auto w-full max-w-2xl", className)}>
      <BigSearch
        value={q}
        onChange={setQ}
        hideScopes
        label="Search the college's research"
        onSubmit={(v) => nav(v.trim() ? `/search?q=${encodeURIComponent(v.trim())}` : "/search")}
      />
    </div>
  )
}
