import { createContext, useContext, useState } from "react"
import * as RadixDialog from "@radix-ui/react-dialog"
import { AnimatePresence, motion } from "motion/react"
import { X } from "lucide-react"

import { overlayVariants, sheetVariants, useMotionVariants, type Edge } from "@/ui/motion"
import { cn } from "@/lib/cn"

/**
 * A drill-down that keeps the page behind it exactly where it was.
 *
 * A figure on a report that opened a new route would lose the reader's
 * place — the scroll position, the filters, the row they were looking at.
 * A sheet slides in from the edge instead: Escape returns to precisely what
 * was there, because the page underneath never left, never re-fetched,
 * never re-mounted.
 *
 * Built on the same Radix Dialog primitive as `dialog.tsx` — a sheet is a
 * dialog that enters from an edge instead of the centre — so it needs the
 * same open-state bridge to `AnimatePresence`. See the comment in that file
 * for why the state lives here rather than being left to Radix.
 */

const OpenContext = createContext(false)

export function Sheet({
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...props
}: React.ComponentProps<typeof RadixDialog.Root>) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen ?? false)
  const isControlled = open !== undefined
  const actual = isControlled ? open : uncontrolled

  return (
    <RadixDialog.Root
      open={actual}
      onOpenChange={(v) => {
        if (!isControlled) setUncontrolled(v)
        onOpenChange?.(v)
      }}
      {...props}
    >
      <OpenContext.Provider value={actual}>{children}</OpenContext.Provider>
    </RadixDialog.Root>
  )
}

export const SheetTrigger = RadixDialog.Trigger
export const SheetClose = RadixDialog.Close

/** Which edge the sheet is fixed to. The travel itself is `sheetVariants`
 *  in `ui/motion.ts`; this is only where the surface sits once it lands. */
type Side = Edge

// `right` goes full-width below the small-screen breakpoint, because a
// partial-width sheet on a phone leaves a sliver of the old page nobody can
// act on. The rounded corner is always the one facing into the page.
const EDGE: Record<Side, string> = {
  right: "inset-y-0 right-0 h-full w-full sm:w-[26rem] sm:max-w-[85vw]",
  left: "inset-y-0 left-0 h-full w-full sm:w-[26rem] sm:max-w-[85vw]",
  bottom: "inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-xl",
  top: "inset-x-0 top-0 max-h-[85vh] w-full rounded-b-xl",
}

export function SheetContent({
  className,
  side = "right",
  children,
  ...props
}: React.ComponentProps<typeof RadixDialog.Content> & { side?: Side }) {
  const open = useContext(OpenContext)
  const overlay = useMotionVariants(overlayVariants)
  const surface = useMotionVariants(sheetVariants[side])

  return (
    <AnimatePresence>
      {open && (
        <RadixDialog.Portal forceMount>
          <RadixDialog.Overlay asChild forceMount>
            <motion.div
              className="fixed inset-0 z-50 bg-black/20"
              variants={overlay}
              initial="hidden"
              animate="visible"
              exit="hidden"
            />
          </RadixDialog.Overlay>
          <RadixDialog.Content asChild forceMount {...props}>
            <motion.div
              variants={surface}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className={cn(
                "fixed z-50 flex flex-col bg-surface shadow-modal",
                EDGE[side],
                className
              )}
            >
              {children}
              <RadixDialog.Close
                aria-label="Close"
                className={cn(
                  "absolute right-3 top-3 grid size-7 place-items-center rounded-sm",
                  "text-fg-subtle hover:bg-hover hover:text-fg"
                )}
              >
                <X className="size-4" aria-hidden />
              </RadixDialog.Close>
            </motion.div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      )}
    </AnimatePresence>
  )
}

/** `pr-12` keeps the title clear of the close button pinned to the corner. */
export function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("shrink-0 border-b border-line px-5 py-4 pr-12", className)}
      {...props}
    />
  )
}

export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof RadixDialog.Title>) {
  return <RadixDialog.Title className={cn("text-base font-semibold", className)} {...props} />
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof RadixDialog.Description>) {
  return (
    <RadixDialog.Description
      className={cn("mt-1 text-sm text-fg-muted", className)}
      {...props}
    />
  )
}

/** The only part that scrolls. Header and footer stay pinned — a footer
 *  that scrolls away takes its actions with it. */
export function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)} {...props} />
}

export function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3",
        className
      )}
      {...props}
    />
  )
}
