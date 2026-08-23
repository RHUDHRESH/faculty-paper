"use client"

import { useState, type ReactNode } from "react"
import { SlidersHorizontal, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The controls that are not the search box.
 *
 * A row of five dropdowns competes with the list underneath it for the
 * reader's attention, and four of the five are usually left alone. They fold
 * behind one button that says how many are doing something — so the screen
 * opens as a search box and a list, which is what somebody arriving actually
 * wants, and the rest is one click away rather than always in the way.
 *
 * Active filters stay visible as chips even when the panel is shut: a filter
 * that is quietly narrowing the numbers while hidden is how a reader ends up
 * believing a wrong total.
 */
export function FilterBar({
  children,
  active,
  onClear,
  className,
}: {
  /** The controls themselves, shown when the panel is open. */
  children: ReactNode
  /** One entry per filter that is currently narrowing the view. */
  active: { label: string; value: string; onClear: () => void }[]
  onClear: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={open ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <SlidersHorizontal className="size-4" />
          Filters
          {active.length ? (
            <span className="ml-1 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
              {active.length}
            </span>
          ) : null}
        </Button>

        {/* Shut or open, what is narrowing the view stays on screen. */}
        {active.map((f) => (
          <button
            key={f.label}
            type="button"
            onClick={f.onClear}
            className="interactive inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs hover:border-destructive/50"
            aria-label={`Remove the ${f.label} filter`}
          >
            <span className="text-muted-foreground">{f.label}:</span>
            <span className="font-medium">{f.value}</span>
            <X className="size-3 text-muted-foreground" aria-hidden />
          </button>
        ))}

        {active.length > 1 ? (
          <button
            type="button"
            onClick={onClear}
            className="interactive text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear all
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="flex flex-wrap items-end gap-3 rounded-[var(--radius)] border border-border bg-card p-3">
          {children}
        </div>
      ) : null}
    </div>
  )
}
