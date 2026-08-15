import { useEffect, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const APP_NAME = "Publication Tickets"

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  className?: string
}) {
  // Every screen renders this header, so it is the one place that knows what
  // the page is called. Without it the tab, history, and window switcher all
  // read "Publication Tickets" no matter where you are.
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`
    return () => {
      document.title = APP_NAME
    }
  }, [title])

  return (
    <header
      className={cn(
        "mb-6 flex items-start justify-between gap-4 border-b border-border pb-4",
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {title}
        </h1>
        {subtitle ? (
          <p className="max-w-2xl text-sm text-muted-foreground md:text-base">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </header>
  )
}

export function Section({
  title,
  description,
  children,
  className,
  actions,
}: {
  title?: string
  description?: string
  children: ReactNode
  className?: string
  actions?: ReactNode
}) {
  return (
    <section className={cn("space-y-3", className)}>
      {(title || actions) && (
        <div className="flex items-end justify-between gap-3 px-1">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function InsetList({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>
      <div className="divide-y divide-border">{children}</div>
    </div>
  )
}

export function InsetRow({
  label,
  children,
  className,
}: {
  label?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex min-h-11 items-center justify-between gap-4 px-4 py-2.5 transition-colors hover:bg-muted/40",
        className
      )}
    >
      {label ? (
        <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      ) : null}
      <div className="min-w-0 flex-1 text-right text-sm text-foreground">{children}</div>
    </div>
  )
}

export function StatStrip({
  items,
}: {
  items: { label: string; value: string | number; to?: string }[]
}) {
  return (
    <div className="flex gap-8 overflow-x-auto pb-1">
      {items.map((item) => {
        const body = (
          <>
            <div className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
              {item.value}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{item.label}</div>
          </>
        )
        // A number the reader can act on links to where the action happens —
        // "To clear: 47" with nothing to click was a dead end.
        return item.to ? (
          <Link
            key={item.label}
            to={item.to}
            className="min-w-[4.5rem] shrink-0 rounded-md transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </Link>
        ) : (
          <div key={item.label} className="min-w-[4.5rem] shrink-0">
            {body}
          </div>
        )
      })}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/60 px-6 py-10 text-center",
        className
      )}
    >
      {icon ? (
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {description ? (
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/** A failed load must never masquerade as "you have nothing" — it says what
 * happened and offers a retry. */
export function ErrorState({
  title = "Could not load",
  description = "Something went wrong talking to the server.",
  onRetry,
  className,
}: {
  title?: string
  description?: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-destructive/40 bg-card/60 px-6 py-10 text-center",
        className
      )}
    >
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">{description}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}

export function FilterBar({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3", className)}>
      {children}
    </div>
  )
}

export function MasterDetail({
  list,
  detail,
  className,
  listClassName,
  detailClassName,
}: {
  list: ReactNode
  detail: ReactNode
  className?: string
  listClassName?: string
  detailClassName?: string
}) {
  return (
    <div
      className={cn(
        "grid gap-4 lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)] lg:items-start",
        className
      )}
    >
      <div className={cn("min-w-0", listClassName)}>{list}</div>
      <div className={cn("hidden min-w-0 lg:block", detailClassName)}>{detail}</div>
    </div>
  )
}

export function StickyActions({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-20 -mx-4 mt-6 border-t border-border bg-background/95 px-4 py-3 backdrop-blur-sm md:-mx-6 md:px-6",
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  )
}

export function Stepper({
  steps,
  current,
  className,
}: {
  steps: string[]
  current: number
  className?: string
}) {
  return (
    <ol className={cn("flex flex-wrap gap-2", className)} aria-label="Progress">
      {steps.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={label} aria-current={active ? "step" : undefined}>
            <Badge
              variant={active ? "default" : done ? "secondary" : "outline"}
              className="gap-1.5 px-2.5 py-1"
            >
              <span className="text-[10px] font-semibold tabular-nums">{i + 1}</span>
              {label}
            </Badge>
          </li>
        )
      })}
    </ol>
  )
}
