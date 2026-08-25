import { forwardRef } from "react"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/lib/cn"

/**
 * Four kinds of button, because there are four kinds of thing to do.
 *
 * No `variant` grab-bag: every option here answers "how much does this
 * matter", and a set that offers eight answers to that question guarantees
 * two screens will answer it differently.
 *
 *   primary   the one thing this screen is for. At most one per view.
 *   default   an ordinary action. A hairline and a wash.
 *   quiet     an action that should not compete — toolbar, row, dialog cancel.
 *   danger    something that cannot be undone.
 */
type Kind = "primary" | "default" | "quiet" | "danger"
type Size = "sm" | "md" | "lg" | "icon"

const KIND: Record<Kind, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover " +
    "disabled:bg-fg-subtle",
  default:
    "bg-surface text-fg ring-1 ring-inset ring-edge " +
    "hover:bg-hover",
  quiet: "text-fg-muted hover:bg-hover hover:text-fg",
  danger:
    "text-critical ring-1 ring-inset ring-critical/25 " +
    "hover:bg-critical-wash",
}

const SIZE: Record<Size, string> = {
  sm: "h-7 gap-1.5 px-2 text-xs rounded-sm",
  md: "h-8 gap-1.5 px-2.5 text-sm rounded-md",
  lg: "h-10 gap-2 px-4 text-base rounded-md",
  icon: "size-8 rounded-md",
}

export const Button = forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { kind?: Kind; size?: Size; asChild?: boolean }
>(function Button({ className, kind = "default", size = "md", asChild, ...props }, ref) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      ref={ref}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap",
        "font-medium transition-colors duration-[var(--dur-1)] ease-out",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        KIND[kind],
        SIZE[size],
        className
      )}
      {...props}
    />
  )
})
