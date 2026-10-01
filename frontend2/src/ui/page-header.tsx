import { cn } from "@/lib/cn"
import { Breadcrumbs, type Crumb } from "@/ui/breadcrumbs"
import { Illustration, type IllustrationName } from "@/ui/illustration"

/** The small illustration at the right of a `.page-head` header. */
export function HeaderSpot({ name }: { name: IllustrationName }) {
  return <Illustration name={name} width={96} className="hidden sm:block" eager />
}

/**
 * The top of every view (docs/ux/22, "page anatomy", part 1): the title, one
 * line saying what the view is for in the person's words, and at most one
 * primary action at the top right. Breadcrumbs sit above the title when the
 * view is a detail of something else.
 *
 * Without it every page invents its own top: a title with three buttons of
 * equal weight, a paragraph of instructions, or nothing, and a reader cannot
 * tell what the page is for until they have read the whole of it.
 *
 *   `sub`        the one line. A sentence, not a paragraph.
 *   `action`     the one primary action (a `Button kind="primary"`). Only one.
 *   `actions`    the older slot for several buttons; kept so existing pages
 *                keep working, but a new page uses `action`.
 *   `breadcrumbs` for a page drawn outside the router. Routed pages get theirs
 *                from the shell (`app/crumbs.ts`); passing both draws two.
 *
 * There is no rule under the header. Space separates it from the first
 * section; a hairline is for the rows of one list.
 */
export function PageHeader({
  eyebrow,
  title,
  sub,
  action,
  actions,
  breadcrumbs,
  spot,
  children,
  className,
}: {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  sub?: React.ReactNode
  action?: React.ReactNode
  actions?: React.ReactNode
  breadcrumbs?: Crumb[]
  spot?: IllustrationName
  children?: React.ReactNode
  className?: string
}) {
  const buttons = action ?? actions
  return (
    <header className={cn("flex items-start gap-6 pb-2", className)}>
      <div className="min-w-0 flex-1">
        {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} className="mb-2" />}
        {eyebrow && <p className="text-sm text-fg-muted">{eyebrow}</p>}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="display text-balance text-[1.75rem] leading-9 text-fg">{title}</h1>
          {buttons && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:shrink-0 print:hidden">{buttons}</div>}
        </div>
        {sub && <div className="mt-1.5 max-w-prose text-pretty text-base text-fg-muted">{sub}</div>}
        {children}
      </div>
      {spot && <Illustration name={spot} width={104} className="hidden sm:block print:hidden" eager />}
    </header>
  )
}
