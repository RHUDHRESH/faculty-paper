import { cn } from "@/lib/cn"

/**
 * A small success badge for a decision ("Cleared", "Approved", "Paid"), with
 * the date available to assistive technology. `verb` is one word; `date`
 * defaults to today.
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
        "inline-flex select-none items-center rounded-md bg-positive-wash px-2 py-0.5 text-xs font-medium text-positive",
        className
      )}
    >
      <span aria-hidden>{verb}</span>
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
