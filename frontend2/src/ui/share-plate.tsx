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

/** Decorative: renders nothing in the minimalist skin. */
export function Illustration(_props: { name: IllustrationName; area?: Area; className?: string; plate?: boolean }) {
  return null
}
