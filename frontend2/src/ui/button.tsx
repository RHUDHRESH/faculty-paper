import { forwardRef } from "react"
import { Slot } from "@radix-ui/react-slot"
import { LoaderCircle } from "lucide-react"

import { cn } from "@/lib/cn"

/**
 * Four kinds of button, because there are four kinds of thing to do.
 *
 * No `variant` grab-bag: every option here answers "how much does this
 * matter", and a set that offers eight answers to that question guarantees
 * two screens will answer it differently.
 *
 *   primary   the one thing this screen is for. At most one per view.
 *   default   an ordinary action. A surface, an outline and a raised edge.
 *   quiet     an action that should not compete -- toolbar, row, dialog
 *             cancel. Flat at rest; a wash and an outline the moment the
 *             pointer or the keyboard arrives, so it is never mistaken for text.
 *   danger    something that cannot be undone. Crimson wash and outline at
 *             rest; fills crimson under the pointer.
 *
 * Every kind answers the same five states, in the same order of weight:
 *
 *   rest      says what it is
 *   hover     colour and edge deepen; it never moves
 *   pressed   one pixel down and the raised edge spent (the shadow is a claim
 *             about height, so pressing the thing has to use it up)
 *   focus     the global clay ring, offset 2px (styles.css)
 *   disabled  a flat well, not a washed-out copy: half-opacity navy reads as
 *             broken, a flat well reads as "not yet"
 *   loading   the leading icon becomes a spinner, the label stays, a second
 *             press is ignored
 *
 * Motion is colour and shadow at --dur-1/--dur-2 and a 1px press; the global
 * reduced-motion rule in styles.css removes the transitions, and the press
 * transform is dropped here too.
 */
type Kind = "primary" | "default" | "quiet" | "danger"
type Size = "sm" | "md" | "lg" | "icon" | "icon-sm"

const KIND: Record<Kind, string> = {
  primary:
    "bg-action text-action-fg shadow-action " +
    "hover:bg-action-hover hover:shadow-action-hover " +
    "active:shadow-press " +
    "disabled:bg-hover disabled:text-fg-muted disabled:opacity-100 disabled:shadow-none disabled:ring-1 disabled:ring-inset disabled:ring-edge",
  default:
    "bg-surface text-fg ring-1 ring-inset ring-control-edge shadow-raise " +
    "hover:bg-hover hover:ring-field " +
    "active:bg-active active:shadow-press " +
    "disabled:bg-sunken disabled:text-fg-subtle disabled:shadow-none disabled:ring-edge disabled:opacity-100",
  quiet:
    "text-fg-muted ring-1 ring-inset ring-transparent " +
    "hover:bg-hover hover:text-fg hover:ring-edge " +
    "active:bg-active " +
    "aria-expanded:bg-hover aria-expanded:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg",
  danger:
    "bg-critical-wash text-critical ring-1 ring-inset ring-critical-line " +
    "hover:bg-critical hover:text-critical-fg hover:ring-critical " +
    "active:brightness-90 " +
    "disabled:bg-sunken disabled:text-fg-subtle disabled:ring-edge disabled:opacity-100",
}

const SIZE: Record<Size, string> = {
  sm: "h-8 max-sm:h-10 gap-1.5 px-3 text-sm rounded-control has-[>svg:first-child]:pl-2.5 has-[>svg:last-child]:pr-2.5",
  md: "h-10 max-sm:h-11 gap-2 px-4 text-sm rounded-control has-[>svg:first-child]:pl-3.5 has-[>svg:last-child]:pr-3.5",
  lg: "h-12 gap-2.5 px-6 text-base rounded-control has-[>svg:first-child]:pl-5 has-[>svg:last-child]:pr-5",
  icon: "size-10 max-sm:size-11 rounded-control",
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
        "font-medium transition-[background-color,color,box-shadow,transform] duration-[var(--dur-1)] ease-out",
        // A real <button> gets its 1px press from the base layer; a link
        // wearing the button asks for the same one.
        asChild && "active:translate-y-px",
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
