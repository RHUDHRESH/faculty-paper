import { cn } from "@/lib/cn"
import type { Area } from "@/ui/chip"

/**
 * The certificate surface (docs/ux/00 §8): cream paper, gold ribbon on top.
 * Wall of fame tiles only.
 */
export function SharePlate({
  children,
  className,
  as: Tag = "div",
  ribbon = "gold",
}: {
  children: React.ReactNode
  className?: string
  as?: "div" | "article" | "section" | "li"
  /** Gold for an honour (Q1 on the wall); navy for the rest of the wall. */
  ribbon?: "gold" | "navy"
}) {
  return (
    <Tag
      data-area="honours"
      className={cn(
        "relative overflow-hidden rounded-2xl bg-paper p-6 text-fg shadow-[inset_0_0_0_1px_var(--color-area-honours-line)]",
        className
      )}
    >
      <div aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px]", ribbon === "gold" ? "ribbon" : "bg-accent")} />
      {children}
    </Tag>
  )
}

export type IllustrationName =
  | "celebrate"
  | "empty-messages"
  | "empty-papers"
  | "empty-search"
  | "hero-landing"
  | "ideas"
  | "network-bridge"
  | "scopus-pull"

/**
 * A house illustration on its plate (docs/ux/00 §4): a rounded-3xl area-wash
 * rectangle that keeps the fixed-colour SVG legible in dark mode. Width is
 * the caller's: ≤200px for empty states, 120px in the method picker, 480px
 * on the landing hero. Decorative — the heading beside it says the thing.
 */
export function Illustration({
  name,
  area = "record",
  className,
  plate = true,
}: {
  name: IllustrationName
  area?: Area
  className?: string
  plate?: boolean
}) {
  return (
    <div data-area={area} className={cn(plate && "rounded-3xl bg-(--area-wash) p-3", "w-full max-w-[200px]", className)}>
      <img
        src={`/illustrations/${name}.svg`}
        alt=""
        aria-hidden
        width={320}
        height={200}
        draggable={false}
        className="h-auto w-full select-none"
      />
    </div>
  )
}
