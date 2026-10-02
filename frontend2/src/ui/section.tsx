import { useId, useState } from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { InfoTip } from "@/ui/info"
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
  showSub,
  action,
  children,
  className,
  ...rest
}: {
  title?: React.ReactNode
  /** What the section is, in a sentence. Hidden behind an (i) beside the
   *  title: the title and the content already say what this is, so the line
   *  is for the reader who wants it. Without a title it is drawn in place. */
  sub?: React.ReactNode
  /** Draw `sub` as a visible line after all, for the rare one that the
   *  reader needs before they can act. */
  showSub?: boolean
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
} & Omit<React.ComponentProps<"section">, "title">) {
  const id = useId()
  return (
    <section aria-labelledby={title ? id : undefined} className={cn("min-w-0", className)} {...rest}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {title && (
            <span className="inline-flex items-center gap-1.5">
              <SectionTitle id={id}>{title}</SectionTitle>
              {sub && !showSub && <InfoTip label="About this section">{sub}</InfoTip>}
            </span>
          )}
          {action && <div className="text-sm">{action}</div>}
        </div>
      )}
      {sub && (showSub || !title) && <p className="-mt-2 mb-3 max-w-prose text-sm text-fg-muted">{sub}</p>}
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
  summary,
  defaultOpen = false,
  children,
  className,
}: {
  /** How many items are behind it. Shown in full. */
  count?: number
  /** The noun after Show/Hide ("details", "history", "older claims"). */
  label?: string
  /** A fixed line in place of "Show details (n)": "More about this". */
  summary?: React.ReactNode
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
          "-ml-2 inline-flex min-h-8 items-center gap-1.5 rounded-control px-2 text-sm font-medium text-fg-muted",
          "ring-1 ring-inset ring-transparent hover:bg-hover hover:text-fg hover:ring-edge active:bg-active max-sm:min-h-10",
          open && "text-fg"
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn("size-4 transition-transform duration-[var(--dur-1)]", open && "rotate-90")}
        />
        {summary ?? (
          <>
            {open ? "Hide" : "Show"} {label}
          </>
        )}
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
