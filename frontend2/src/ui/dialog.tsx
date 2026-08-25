import { createContext, useContext, useEffect, useState } from "react"
import * as RadixDialog from "@radix-ui/react-dialog"
import { AnimatePresence, motion } from "motion/react"
import { X } from "lucide-react"

import { Button } from "@/ui/button"
import { cn } from "@/lib/cn"

/**
 * A surface that genuinely leaves the page: a form, a record, anything that
 * must be finished or dismissed before the page behind it matters again.
 *
 * Radix's `Dialog.Content` unmounts the instant it closes, which is correct
 * for behaviour (focus returns, the DOM is cleared) and wrong for how it
 * looks — the exit reads as a snap rather than a dismissal. `forceMount`
 * stops Radix from deciding when the content leaves the tree, and hands that
 * job to `AnimatePresence` instead, which is why open state is tracked here
 * rather than left to Radix alone: something has to tell `AnimatePresence`
 * when the exit should start.
 */

const OpenContext = createContext(false)

export function Dialog({
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

export const DialogTrigger = RadixDialog.Trigger
export const DialogClose = RadixDialog.Close

const WIDTH = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
} as const

/**
 * The dialog surface. `max-h-[85vh]` and a scrolling `DialogBody` exist so a
 * tall form on a short laptop screen loses its footer to overflow rather
 * than its actions — without a fixed footer, "Save" scrolls out of reach
 * exactly when a long form makes it most needed.
 */
export function DialogContent({
  className,
  size = "md",
  children,
  ...props
}: React.ComponentProps<typeof RadixDialog.Content> & { size?: keyof typeof WIDTH }) {
  const open = useContext(OpenContext)
  return (
    <AnimatePresence>
      {open && (
        <RadixDialog.Portal forceMount>
          <RadixDialog.Overlay asChild forceMount>
            <motion.div
              className="fixed inset-0 z-50 bg-black/20"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
            />
          </RadixDialog.Overlay>
          <div className="fixed inset-0 z-50 grid place-items-center p-4">
            <RadixDialog.Content asChild forceMount {...props}>
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.985 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                className={cn(
                  "relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl",
                  "bg-surface shadow-modal",
                  WIDTH[size],
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
          </div>
        </RadixDialog.Portal>
      )}
    </AnimatePresence>
  )
}

/** Left-aligned on purpose — a centred title reads as an alert, and most of
 *  what opens here is an ordinary form, not one. `pr-12` keeps the title
 *  clear of the close button in the corner. */
export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("shrink-0 border-b border-line px-5 py-4 pr-12", className)}
      {...props}
    />
  )
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof RadixDialog.Title>) {
  return <RadixDialog.Title className={cn("text-base font-semibold", className)} {...props} />
}

export function DialogDescription({
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

/** The only part of the dialog that scrolls. Not in the brief's export list,
 *  but "the body scrolls, not the page" needs a region to scroll — see the
 *  note in the report about this addition. */
export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)} {...props} />
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
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

/**
 * A confirmation that a click cannot pass through by reflex.
 *
 * This app destroys payment records, and a plain "Are you sure?" button sits
 * exactly where the button that opened it was, which trains a fast clicker
 * to hit it just as fast. `requirePhrase` forces the exact words to be
 * typed; `reasonLabel` forces a sentence of why, kept for whoever has to
 * explain the deletion later. Both are optional — most confirmations only
 * need the pause of a second dialog, not a typing test.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  requirePhrase,
  reasonLabel,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  requirePhrase?: string
  reasonLabel?: string
  onConfirm: (reason?: string) => void | Promise<void>
}) {
  const [phrase, setPhrase] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  // Every re-open starts clean — a stale reason left over from a cancelled
  // attempt reads as though it belongs to this one.
  useEffect(() => {
    if (open) {
      setPhrase("")
      setReason("")
      setBusy(false)
    }
  }, [open])

  const phraseOk = !requirePhrase || phrase === requirePhrase
  const reasonOk = !reasonLabel || reason.trim().length > 0
  const canConfirm = phraseOk && reasonOk && !busy

  async function confirm() {
    setBusy(true)
    try {
      await onConfirm(reasonLabel ? reason.trim() : undefined)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {(requirePhrase || reasonLabel) && (
          <DialogBody className="space-y-3.5">
            {reasonLabel && (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{reasonLabel}</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  className={cn(
                    "w-full resize-none rounded-md bg-surface px-3 py-2 text-sm",
                    "ring-1 ring-inset ring-field outline-none",
                    "focus-visible:ring-2 focus-visible:ring-accent"
                  )}
                />
              </label>
            )}
            {requirePhrase && (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">
                  Type <span className="font-mono text-critical">{requirePhrase}</span>{" "}
                  to confirm
                </span>
                <input
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(
                    "h-9 w-full rounded-md bg-surface px-3 text-sm",
                    "ring-1 ring-inset ring-field outline-none",
                    "focus-visible:ring-2 focus-visible:ring-accent"
                  )}
                />
              </label>
            )}
          </DialogBody>
        )}

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button kind={danger ? "danger" : "primary"} disabled={!canConfirm} onClick={confirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
