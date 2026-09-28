import type { LucideIcon } from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { Chip, type Area } from "@/ui/chip"

/** The 88×88 rounded-3xl area-wash tile holding a 48px icon (icon-xl). */
export function IconTile({ icon: Icon, size = "xl", className }: { icon: LucideIcon; size?: "xl" | "lg"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-3xl bg-(--area-wash) text-(--area)",
        size === "xl" ? "size-[88px] max-sm:size-[72px]" : "size-14 rounded-2xl",
        className
      )}
    >
      <Icon className={size === "xl" ? "size-12 max-sm:size-10" : "size-8"} strokeWidth={1.5} />
    </span>
  )
}

type Common = {
  icon: LucideIcon
  title: React.ReactNode
  description?: React.ReactNode
  recommended?: boolean
  area?: Area
  className?: string
}

const TILE =
  "group flex h-full w-full flex-col items-start gap-3 rounded-2xl bg-surface p-5 text-left shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors duration-[var(--dur-1)] hover:bg-hover focus-visible:outline-(--area-line) data-[checked=true]:bg-(--area-wash) data-[checked=true]:shadow-[inset_0_0_0_2px_var(--area)]"

function Body({ icon, title, description, recommended }: Common) {
  return (
    <>
      <IconTile icon={icon} />
      <span className="flex flex-wrap items-center gap-2 text-lg font-semibold text-fg">
        {title}
        {recommended && <Chip tone="gold">Recommended</Chip>}
      </span>
      {description && <span className="text-sm text-fg-muted">{description}</span>}
    </>
  )
}

/**
 * A big choice (docs/ux/00 §8). Three forms from one look:
 * - `to`: a navigation tile (Home "next steps");
 * - `checked` + `onSelect`: a radio inside a `ChoiceGroup` (method picker);
 * - `onSelect` alone: a button.
 */
export function ChoiceTile(props: Common & { to?: string; checked?: boolean; onSelect?: () => void; value?: string }) {
  const { to, checked, onSelect, area, className } = props
  if (to) {
    return (
      <Link to={to} data-area={area} className={cn(TILE, className)}>
        <Body {...props} />
      </Link>
    )
  }
  const radio = checked !== undefined
  return (
    <button
      type="button"
      data-area={area}
      role={radio ? "radio" : undefined}
      aria-checked={radio ? checked : undefined}
      data-checked={checked ? "true" : undefined}
      onClick={onSelect}
      className={cn(TILE, className)}
    >
      <Body {...props} />
    </button>
  )
}

/** Radio semantics for a set of ChoiceTiles: arrow keys move between them. */
export function ChoiceGroup({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]
    if (!keys.includes(e.key)) return
    const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'))
    const i = radios.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    const next = radios[(i + (keys.indexOf(e.key) < 2 ? 1 : -1) + radios.length) % radios.length]
    next.focus()
    next.click()
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {children}
    </div>
  )
}
