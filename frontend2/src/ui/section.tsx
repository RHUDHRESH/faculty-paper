import { useId, useState } from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { SectionTitle } from "@/ui/text"

/**
 * One part of a page (docs/ux/22, "page anatomy", part 3): a heading, an
 * optional line saying what it is, an optional link or button at the right,
 * then the content.
 *
 * Space separates one section from the next, not a rule and not a card. A page
 * of sections each boxed in a bordered panel is the "boxes in boxes" look that
 * docs/ux/17 rules out, and the boxes made it impossible to see which of them
 * mattered. Give a page `space-y-10` and put its sections in it; the section
 * adds no margin of its own, so it sits correctly inside any parent.
 */
export function Section({
  title,
  sub,
  action,
  children,
  className,
  ...rest
}: {
  title?: React.ReactNode
  sub?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
} & Omit<React.ComponentProps<"section">, "title">) {
  const id = useId()
  return (
    <section aria-labelledby={title ? id : undefined} className={cn("min-w-0", className)} {...rest}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {title && <SectionTitle id={id}>{title}</SectionTitle>}
          {action && <div className="text-sm">{action}</div>}
        </div>
      )}
      {sub && <p className="-mt-2 mb-3 max-w-prose text-sm text-fg-muted">{sub}</p>}
      {children}
    </section>
  )
}

/**
 * The rows of one list, divided by a single hairline. This is the only
 * divider a list has: no rule above the first row, none below the last, no
 * card around it, no second line inside a row.
 */
export function Rows({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <ul className={cn("divide-y divide-line", className)}>{children}</ul>
  )
}

/**
 * Detail one step away (docs/ux/22, "detail on demand"): a line the reader can
 * open, which says how much is behind it. "Show details (12)" tells them the
 * detail exists, what it costs to read, and that nothing has been hidden
 * without a way in.
 *
 * Without the count, a disclosure is a guess: people do not open a closed door
 * they cannot see into, and the detail an auditor came for goes unread.
 */
export function Details({
  count,
  label = "details",
  defaultOpen = false,
  children,
  className,
}: {
  /** How many items are behind it. Shown in full. */
  count?: number
  /** The noun after Show/Hide ("details", "history", "older claims"). */
  label?: string
  defaultOpen?: boolean
  children: React.ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex min-h-8 items-center gap-1.5 rounded-control text-sm font-medium text-fg-muted",
          "hover:text-fg max-sm:min-h-10"
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn("size-4 transition-transform duration-[var(--dur-1)]", open && "rotate-90")}
        />
        {open ? "Hide" : "Show"} {label}
        {count != null && <span className="tabular text-fg-subtle">({formatCount(count)})</span>}
      </button>
      {open && (
        <div id={id} className="mt-2">
          {children}
        </div>
      )}
    </div>
  )
}
