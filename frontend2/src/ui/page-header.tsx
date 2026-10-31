import { cn } from "@/lib/cn"
import { Breadcrumbs, type Crumb } from "@/ui/breadcrumbs"
import type { IllustrationName } from "@/ui/illustration"
import { InfoTip } from "@/ui/info"

/** Retained for imports; pictures are no longer drawn. */
export function HeaderSpot(_props: { name: IllustrationName }) {
  return null
}

/**
 * The top of every view: optional breadcrumb line, the title (24px/600), one
 * line saying what the view is for, and the actions on the right (wrapping
 * below the title on phones).
 *
 *   `sub`         the description line.
 *   `about`       longer explanation, opened from the (i).
 *   `action`      the one primary action. `actions` is the older multi slot.
 *   `breadcrumbs` for a page drawn outside the router.
 *   `spot`        ignored: no picture is drawn.
 *   `eyebrow`     deprecated; still drawn as a small muted line.
 */
export function PageHeader({
  eyebrow,
  title,
  sub,
  about,
  action,
  actions,
  breadcrumbs,
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
  /** Ignored. */
  spot?: IllustrationName
  children?: React.ReactNode
  className?: string
}) {
  const buttons = action ?? actions
  const aboutBody = about ?? null
  return (
    <header className={cn("pb-2", className)}>
      {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} className="mb-2" />}
      {eyebrow && <p className="text-sm text-fg-muted">{eyebrow}</p>}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="text-balance text-2xl font-semibold leading-8 text-fg">{title}</h1>
            {aboutBody && <InfoTip label="About this page">{aboutBody}</InfoTip>}
          </div>
          {sub && <div className="mt-1 text-pretty text-sm text-fg-muted">{sub}</div>}
        </div>
        {buttons && (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end print:hidden">
            {buttons}
          </div>
        )}
      </div>
      {children}
    </header>
  )
}
