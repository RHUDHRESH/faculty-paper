import { TrendingDown, TrendingUp, type LucideIcon } from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { Chip, type Area } from "@/ui/chip"
import { MaybeCount } from "@/ui/motion/count-up"

/**
 * A showcase figure (docs/ux/00 §8): area-coloured 32px icon, figure, label,
 * optional delta against last year and optional caution chip. A link when
 * `to` is given. Lay out in rows of 3–4 (see `StatRow`).
 */
export function StatTile({
  icon: Icon,
  figure,
  label,
  delta,
  deltaLabel = "vs last year",
  caution,
  to,
  area,
  spark,
  className,
}: {
  icon: LucideIcon
  /** null while loading: an em dash, never 0. */
  figure: React.ReactNode | null | undefined
  label: React.ReactNode
  delta?: number | null
  deltaLabel?: string
  /** Partial truth, said as a chip beside the number (docs/ux/00 §7). */
  caution?: React.ReactNode
  to?: string
  area?: Area
  /** e.g. a `<Sparkline>` from ui/chart. */
  spark?: React.ReactNode
  className?: string
}) {
  const Trend = delta != null && delta < 0 ? TrendingDown : TrendingUp
  const inner = (
    <>
      <Icon aria-hidden className="size-5 text-fg-subtle" strokeWidth={1.5} />
      <div className="mt-3 flex flex-wrap items-baseline gap-2">
        <span className="figure text-figure text-fg">{figure == null ? "—" : <MaybeCount figure={figure} />}</span>
        {spark}
        {caution && (
          <Chip tone="caution" className="self-center">
            {caution}
          </Chip>
        )}
      </div>
      <p className="mt-1 text-sm text-fg-muted">{label}</p>
      {delta != null && delta !== 0 && (
        <p className={cn("mt-1 flex items-center gap-1 text-xs", delta > 0 ? "text-positive" : "text-fg-muted")}>
          <Trend aria-hidden className="size-4" strokeWidth={1.75} />
          {delta > 0 ? "+" : ""}
          {delta} {deltaLabel}
        </p>
      )}
    </>
  )
  const box = cn("panel block p-5 text-left", className)
  return (
    <div data-area={area} className="min-w-0">
      {to ? (
        <Link to={to} className={cn(box, "row hover:bg-hover")}>
          {inner}
        </Link>
      ) : (
        <div className={box}>{inner}</div>
      )}
    </div>
  )
}

/** Tiles in rows of 3–4; two per row on a phone. */
export function StatRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-4 lg:grid-cols-4", className)}>{children}</div>
}
