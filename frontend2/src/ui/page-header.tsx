import { cn } from "@/lib/cn"
import { Illustration, type IllustrationName } from "@/ui/illustration"

/** The small illustration at the right of a `.page-head` header. */
export function HeaderSpot({ name }: { name: IllustrationName }) {
  return <Illustration name={name} width={96} className="hidden sm:block" eager />
}

/**
 * The calm page header (docs/ux/00, "Claude-like"): an optional muted
 * eyebrow, a serif title, one muted sentence, actions on the right, and a
 * small spot illustration that supports rather than dominates. The spot is
 * hidden on phones so the title stays the first thing read.
 */
export function PageHeader({
  eyebrow,
  title,
  sub,
  actions,
  spot,
  children,
  className,
}: {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  sub?: React.ReactNode
  actions?: React.ReactNode
  spot?: IllustrationName
  children?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn("flex items-start gap-6 border-b border-line pb-6", className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && <p className="text-sm text-fg-muted">{eyebrow}</p>}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="display text-balance text-[1.75rem] leading-9 text-fg">{title}</h1>
          {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
        </div>
        {sub && <div className="mt-1.5 max-w-prose text-pretty text-base text-fg-muted">{sub}</div>}
        {children}
      </div>
      {spot && <Illustration name={spot} width={104} className="hidden sm:block" eager />}
    </header>
  )
}
