"use client"

import { AlertTriangle, Check, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * What a batch actually did, kept on screen until it is dismissed.
 *
 * Approving two hundred tickets and having three refused reported itself as
 * three toasts that faded in four seconds — while the reader was still
 * looking at the list. By the time they noticed something had gone amber it
 * had gone, and the only way to find out which rows were skipped was to run
 * the batch again and read faster.
 *
 * Every skip carries a reason from the server, and those reasons are the
 * useful part: an amount that drifted, a ticket somebody else already moved,
 * a payment-history warning the reader themselves set aside. They stay put.
 */

export type Skipped = { id: string; reason: string }

export function BatchResult({
  done,
  doneLabel,
  skipped,
  onDismiss,
  className,
}: {
  done: number
  /** "approved", "cleared", "paid" — what the successful rows had done to them. */
  doneLabel: string
  skipped: Skipped[]
  onDismiss: () => void
  className?: string
}) {
  if (!done && !skipped.length) return null
  return (
    <section
      className={cn(
        "rounded-[var(--radius)] border p-4",
        skipped.length ? "border-warning/50 bg-warning/5" : "border-success/40 bg-success/5",
        className
      )}
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {skipped.length ? (
            <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
          ) : (
            <Check className="size-4 shrink-0 text-success" aria-hidden />
          )}
          {done} {doneLabel}
          {skipped.length ? ` · ${skipped.length} not done` : ""}
        </h3>
        <Button variant="ghost" size="xs" onClick={onDismiss} aria-label="Dismiss">
          <X className="size-3.5" />
        </Button>
      </div>

      {skipped.length ? (
        <ul className="mt-3 space-y-1.5">
          {skipped.map((s) => (
            <li
              key={s.id}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
            >
              {s.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {skipped.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          These are still in the list above, unchanged. Open one to see why, or fix
          the reason and run the batch again.
        </p>
      ) : null}
    </section>
  )
}
