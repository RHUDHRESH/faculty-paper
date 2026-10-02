import * as RadixPopover from "@radix-ui/react-popover"
import { Info } from "lucide-react"

import { cn } from "@/lib/cn"
import { menuPop, popKeyframes } from "@/ui/pop"

/**
 * Where secondary text goes instead of the page.
 *
 *   InfoTip   the explanation behind a word, a figure or a title: a small (i)
 *             you press, that opens a popover. Works with a finger and a
 *             keyboard (a tooltip does neither), closes on Escape or an outside
 *             press, and is read by a screen reader as a button with a name.
 *   Details   (ui/section) "More about this": a line you open in place, for a
 *             paragraph the page can do without but a careful reader wants.
 *
 * Rule of thumb: if removing the text changes what the reader does next, it is
 * body copy and stays visible. If it only explains why, it goes here.
 */
export function InfoTip({
  children,
  label = "More about this",
  side = "bottom",
  align = "start",
  className,
}: {
  /** The explanation. Two or three sentences at most. */
  children: React.ReactNode
  /** The button's accessible name: say what it explains ("About fees"). */
  label?: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  className?: string
}) {
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            "no-press inline-grid size-5 shrink-0 place-items-center rounded-full align-middle",
            "text-fg-subtle ring-1 ring-inset ring-transparent",
            "hover:bg-hover hover:text-fg hover:ring-edge data-[state=open]:bg-navy-wash data-[state=open]:text-navy data-[state=open]:ring-navy-line",
            className
          )}
        >
          <Info className="size-3.5" aria-hidden strokeWidth={2} />
        </button>
      </RadixPopover.Trigger>
      <style>{popKeyframes}</style>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
          className={cn(
            "z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-panel bg-surface p-3.5 text-sm leading-relaxed text-fg shadow-pop",
            "text-pretty",
            menuPop
          )}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
}
