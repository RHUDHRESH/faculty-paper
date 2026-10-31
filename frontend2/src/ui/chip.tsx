import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/cn"

/** The five areas of the app (docs/ux/00 §1). Each has its own colour. */
export type Area = "record" | "research" | "people" | "honours" | "time"

/** Area → its heading-dot / text utility, for places that need a literal class. */
export const AREA_TEXT: Record<Area, string> = {
  record: "text-area-record",
  research: "text-area-research",
  people: "text-area-people",
  honours: "text-area-honours",
  time: "text-area-time",
}
export const AREA_DOT: Record<Area, string> = {
  record: "bg-area-record",
  research: "bg-area-research",
  people: "bg-area-people",
  honours: "bg-area-honours-fill",
  time: "bg-area-time",
}

export type ChipTone =
  | "neutral" | "area" | "gold" | "caution" | "positive" | "critical" | "info" | "accent" | "navy" | "clay"

const TONE: Record<ChipTone, string> = {
  neutral: "bg-sunken text-fg-muted",
  area: "bg-accent-wash text-accent",
  gold: "bg-sunken text-fg-muted",
  caution: "bg-caution-wash text-caution",
  positive: "bg-positive-wash text-positive",
  critical: "bg-critical-wash text-critical",
  info: "bg-accent-wash text-accent",
  accent: "bg-accent-wash text-accent",
  navy: "bg-accent-wash text-accent",
  clay: "bg-accent-wash text-accent",
}

/**
 * A badge: 12px/500, 2px 8px, radius 6px, a light wash with coloured text.
 * `gold` maps to neutral and `area` to accent.
 */
export function Chip({
  children,
  tone = "neutral",
  area,
  icon: Icon,
  className,
  title,
}: {
  children: React.ReactNode
  tone?: ChipTone
  area?: Area
  icon?: LucideIcon
  className?: string
  title?: string
}) {
  return (
    <span
      data-area={area}
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium",
        TONE[tone],
        className
      )}
    >
      {Icon && <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />}
      {children}
    </span>
  )
}
