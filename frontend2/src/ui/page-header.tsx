import { cn } from "@/lib/cn"
import { Breadcrumbs, type Crumb } from "@/ui/breadcrumbs"
import type { IllustrationName } from "@/ui/illustration"
import { InfoTip } from "@/ui/info"
import { Plate } from "@/ui/plate"

/** The small mounted print at the right of a `.page-head` header. */
export function HeaderSpot({ name }: { name: IllustrationName }) {
  return <Plate name={name} width={120} className="hidden sm:block" eager />
}

/**
 * The top of every view (docs/ux/22, "page anatomy", part 1): the title, one
 * line saying what the view is for in the person's words, and at most one
 * primary action at the top right. Breadcrumbs sit above the title when the
 * view is a detail of something else.
 *
 * The title is the display face at 32 to 40px (DESIGN.md, "Display"): the one
 * thing on most pages set in it, and the only thing within 16px of its size,
 * so a reader always knows where they are standing before they read anything
 * else. The line under it is the lead, 18px, no wider than 40rem.
 *
 *   `sub`        the lead. A sentence, not a paragraph. It wraps to as many
 *                lines as it needs (`text-pretty`); it is never truncated.
 *   `about`      the explanation that does not need to be on the page: how the
 *                numbers are worked out, who can see what. Opens from the (i).
 *   `action`     the one primary action (a `Button kind="primary"`). Only one.
 *   `actions`    the older slot for several buttons; kept so existing pages
 *                keep working, but a new page uses `action`.
 *   `breadcrumbs` for a page drawn outside the router. Routed pages get theirs
 *                from the shell (`app/crumbs.ts`); passing both draws two.
 *   `spot`       a mounted print at the right. Home views, and a view whose
 *                subject has a drawing. One per view (DESIGN.md).
 *   `eyebrow`    deprecated: a kicker above a title is banned. Still drawn so
 *                old pages keep working; a new page does not pass it.
 *
 * There is no rule under the header. Space separates it from the first
 * section; a hairline is for the rows of one list.
 */
export function PageHeader({
  eyebrow,
  title,
  sub,
  about,
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
  about?: React.ReactNode
  action?: React.ReactNode
  actions?: React.ReactNode
  breadcrumbs?: Crumb[]
  spot?: IllustrationName
  children?: React.ReactNode
  className?: string
}) {
  const buttons = action ?? actions
  const aboutBody = about ?? null
  return (
    <header className={cn("flex items-start gap-8 pb-2", className)}>
      <div className="min-w-0 flex-1">
        {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} className="mb-2" />}
        {eyebrow && <p className="text-sm text-fg-muted">{eyebrow}</p>}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="display text-display text-balance text-fg">{title}</h1>
            {aboutBody && <InfoTip label="About this page">{aboutBody}</InfoTip>}
          </div>
          {buttons && (
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:mt-1 sm:shrink-0 print:hidden">{buttons}</div>
          )}
        </div>
        {sub && (
          <div className="mt-2 max-w-[48rem] text-pretty text-lead text-fg-muted">{sub}</div>
        )}
        {children}
      </div>
      {spot && <Plate name={spot} width={120} className="hidden sm:block print:hidden" eager />}
    </header>
  )
}
