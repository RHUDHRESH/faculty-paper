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
          <p className="text-sm text-muted-foreground md:text-base">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function Section({
  title,
  children,
  className,
}: {
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("space-y-3", className)}>
      {title ? (
        <h2 className="px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
      ) : null}
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
        "overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card",
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
        "flex min-h-14 items-center justify-between gap-4 px-4 py-3 active:bg-muted/60",
        className
      )}
    >
      {label ? (
        <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      ) : null}
      <div className="min-w-0 flex-1 text-right text-sm text-foreground">
        {children}
      </div>
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
          <div className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-foreground">
            {item.value}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{item.label}</div>
        </div>
      ))}
    </div>
  )
}
