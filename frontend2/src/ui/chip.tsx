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

export type ChipTone = "neutral" | "area" | "gold" | "caution" | "positive"

const TONE: Record<ChipTone, string> = {
  neutral: "bg-sunken text-fg-muted shadow-[inset_0_0_0_1px_var(--color-line)]",
  area: "bg-(--area-wash) text-(--area) shadow-[inset_0_0_0_1px_var(--area-line)]",
  gold: "bg-area-honours-wash text-area-honours shadow-[inset_0_0_0_1px_var(--color-area-honours-line)]",
  caution: "bg-caution-wash text-caution",
  positive: "bg-positive-wash text-positive",
}

/**
 * A 24px label. `area` tone takes the colour of the nearest `data-area`, or
 * of the `area` prop when given. Gold is for honours only.
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
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium",
        TONE[tone],
        className
      )}
    >
      {Icon && <Icon aria-hidden className="size-4" strokeWidth={1.75} />}
      {children}
    </span>
  )
}
