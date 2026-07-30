import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

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
  return (
    <header
      className={cn(
        "sticky top-0 z-20 -mx-4 mb-6 flex items-start justify-between gap-4 border-b border-border/60 bg-background/80 px-4 py-4 backdrop-blur-xl md:-mx-6 md:px-6",
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="truncate font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
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
              <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {title}
              </h2>
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
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card shadow-[0_1px_0_hsl(214_18%_88%/0.6)]",
        className
      )}
    >
      <div className="divide-y divide-border/80">{children}</div>
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
        "flex min-h-14 items-center justify-between gap-4 px-4 py-3 transition-colors active:bg-muted/60",
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
  items: { label: string; value: string | number }[]
}) {
  return (
    <div className="flex gap-8 overflow-x-auto pb-1">
      {items.map((item) => (
        <div key={item.label} className="min-w-[4.5rem] shrink-0">
          <div className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-foreground tabular-nums">
            {item.value}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{item.label}</div>
        </div>
      ))}
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
        "flex flex-col items-center justify-center rounded-[var(--radius)] border border-dashed border-border/90 bg-card/60 px-6 py-14 text-center",
        className
      )}
    >
      {icon ? (
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
          {icon}
        </div>
      ) : null}
      <h3 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight">
        {title}
      </h3>
      {description ? (
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
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
        "sticky bottom-0 z-20 -mx-4 mt-6 border-t border-border/70 bg-background/90 px-4 py-3 backdrop-blur-xl md:-mx-6 md:px-6",
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
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--duration-normal)]",
              done && "bg-primary/15 text-primary",
              active && "bg-primary text-primary-foreground",
              !done && !active && "bg-muted text-muted-foreground"
            )}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-[10px] font-semibold",
                active ? "bg-primary-foreground/20" : "bg-background/60"
              )}
            >
              {i + 1}
            </span>
            {label}
          </li>
        )
      })}
    </ol>
  )
}
