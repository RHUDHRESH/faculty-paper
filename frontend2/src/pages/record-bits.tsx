import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"

/**
 * One row of choices where exactly one is on: the claim state on My papers,
 * the financial year on the payment statement. A count sits beside each name
 * so the reader can see what is behind a choice before pressing it.
 *
 * Without it each page draws its own strip of tabs (one did, and its buttons
 * were a different height and radius from every filter beside it), and a row
 * of eight years on a phone forces the page to scroll sideways. This wraps.
 */
export function ChoiceChips<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  /** Names the group for a screen reader ("Financial year"). */
  label: string
  value: T
  onChange: (next: T) => void
  options: { id: T; label: string; count?: number | string }[]
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent max-sm:h-10",
              on ? "bg-sunken font-medium text-fg shadow-[inset_0_0_0_1px_var(--color-edge)]" : "text-fg-muted hover:bg-hover hover:text-fg"
            )}
          >
            {o.label}
            {o.count != null && (
              <span className={cn("tabular", on ? "text-fg-muted" : "text-fg-subtle")}>
                {typeof o.count === "number" ? formatCount(o.count) : o.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** "conference-paper" -> "Conference paper": the words a form uses, not the index's. */
export function typeLabel(type: string | null | undefined): string | null {
  if (!type) return null
  const t = type.trim().toLowerCase()
  if (t === "article" || t === "journal-article" || t === "journal") return "Journal article"
  if (t === "conference-paper" || t === "proceedings-article" || t === "conference paper") return "Conference paper"
  if (t === "book-chapter") return "Book chapter"
  if (t === "other") return "Other"
  const words = t.replace(/[-_]/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}
