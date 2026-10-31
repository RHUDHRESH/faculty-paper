import { forwardRef } from "react"
import { Slot } from "@radix-ui/react-slot"
import { LoaderCircle } from "lucide-react"

import { cn } from "@/lib/cn"

/**
 * Four kinds of button, flat, no shadow or gradient.
 *
 *   primary   filled accent, white text. The one thing this screen is for.
 *   default   white, 1px edge, dark text. An ordinary action.
 *   quiet     text only; a light wash on hover. Toolbar, row, cancel.
 *   danger    filled critical. Something that cannot be undone.
 *
 * Sizes: sm 32px, md 40px (phones keep a 40px tap target). `loading` turns the
 * leading icon into a spinner and ignores a second press.
 */
type Kind = "primary" | "default" | "quiet" | "danger"
type Size = "sm" | "md" | "lg" | "icon" | "icon-sm"

const KIND: Record<Kind, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover " +
    "disabled:bg-sunken disabled:text-fg-subtle disabled:opacity-100",
  default:
    "bg-surface text-fg border border-edge " +
    "hover:bg-bg " +
    "disabled:bg-sunken disabled:text-fg-subtle disabled:opacity-100",
  quiet:
    "text-fg-muted hover:bg-sunken hover:text-fg " +
    "aria-expanded:bg-sunken aria-expanded:text-fg data-[state=open]:bg-sunken data-[state=open]:text-fg",
  danger:
    "bg-critical text-critical-fg hover:brightness-90 " +
    "disabled:bg-sunken disabled:text-fg-subtle disabled:opacity-100",
}

const SIZE: Record<Size, string> = {
  sm: "h-8 max-sm:h-10 gap-1.5 px-3 text-sm rounded-control has-[>svg:first-child]:pl-2.5 has-[>svg:last-child]:pr-2.5",
  md: "h-10 gap-2 px-4 text-sm rounded-control has-[>svg:first-child]:pl-3.5 has-[>svg:last-child]:pr-3.5",
  lg: "h-12 gap-2.5 px-6 text-base rounded-control has-[>svg:first-child]:pl-5 has-[>svg:last-child]:pr-5",
  icon: "size-10 rounded-control",
  "icon-sm": "size-8 max-sm:size-10 rounded-control",
}

export const Button = forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    kind?: Kind
    size?: Size
    asChild?: boolean
    /** An action is under way: the leading icon turns into a spinner and a
     *  second press is ignored. Keeps the button's look (unlike `disabled`),
     *  because the reader pressed it a moment ago and should see it working. */
    loading?: boolean
  }
>(function Button({ className, kind = "default", size = "md", asChild, loading, onClick, children, ...props }, ref) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      ref={ref}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={
        loading
          ? (e: React.MouseEvent<HTMLButtonElement>) => {
              e.preventDefault()
            }
          : onClick
      }
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap",
        "font-medium transition-colors duration-[var(--dur-1)] ease-out",
        "disabled:pointer-events-none",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        loading && "cursor-progress [&>svg:not([data-spin])]:hidden",
        KIND[kind],
        SIZE[size],
        className
      )}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && <LoaderCircle data-spin aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {children}
        </>
      )}
    </Comp>
  )
})
