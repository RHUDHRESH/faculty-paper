import { cn } from "@/lib/cn"

/**
 * The Stamp (DESIGN.md, "The Stamp"): the one authored motion in the app, and
 * the way a decision is confirmed. In an Indian college office a file is
 * decided by a rubber stamp and a date, so when somebody Clears, Approves,
 * Authorises or Pays, the answer is a stamp.
 *
 * A clay double ring around the verb in the display face's italic and the date
 * beneath in the interface face, turned three degrees, multiplied into the
 * paper. It lands in 360ms (scale 1.14 to 1, a 1px blur to sharp). With
 * reduced motion it appears without moving.
 *
 *   `verb`   what was decided, in the vocabulary (docs/ux/19): "Cleared",
 *            "Approved", "Authorised", "Paid". One word.
 *   `date`   a short date ("1 Oct"); defaults to today.
 *
 * Use it once, where the decision was made, or through `toast.stamp()`. It is
 * never decoration and never used for anything but a decision.
 */
export function Stamp({
  verb,
  date,
  className,
}: {
  verb: string
  date?: string
  className?: string
}) {
  const when =
    date ?? new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
  return (
    <span
      role="img"
      aria-label={`${verb}, ${when}`}
      className={cn(
        "stamp inline-flex select-none flex-col items-center justify-center rounded-lg px-4 py-1.5 text-accent",
        // Two thin rings, the outer one a gap away: a stamp, not a badge.
        "ring-2 ring-inset ring-accent shadow-[0_0_0_3px_var(--color-surface),0_0_0_4px_var(--color-accent)]",
        className
      )}
    >
      <span aria-hidden className="font-display text-2xl italic leading-none tracking-tight">
        {verb}
      </span>
      <span aria-hidden className="mt-1 text-[0.6875rem] font-medium leading-none tabular">
        {when}
      </span>
    </span>
  )
}

/** What `toast.stamp` shows: the stamp, then the receipt in words. */
export function StampToast({ verb, message }: { verb: string; message?: string }) {
  return (
    <div
      role="status"
      className="flex w-[22rem] max-w-[calc(100vw-2rem)] items-center gap-4 rounded-panel bg-surface p-4 text-fg shadow-pop"
    >
      <Stamp verb={verb} className="shrink-0" />
      {message && <p className="min-w-0 text-pretty text-sm text-fg-muted">{message}</p>}
    </div>
  )
}
