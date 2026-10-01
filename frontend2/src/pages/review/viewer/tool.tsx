import { cn } from "@/lib/cn"

/**
 * One icon button on the viewer's toolbar. The label is both the tooltip and
 * the accessible name: an icon with neither is a guess, and a toolbar of
 * eight guesses is how a reviewer ends up rotating a page they meant to
 * download.
 */
export function ToolButton({
  label,
  onClick,
  active = false,
  disabled = false,
  className,
  children,
}: {
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted",
        "hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40",
        "max-sm:size-10 [&_svg]:size-4",
        active && "bg-active text-fg",
        className
      )}
    >
      {children}
    </button>
  )
}

/** A text-and-icon button on the toolbar, for the two actions that deserve a word. */
export function ToolTextButton({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active || undefined}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-fg-muted",
        "hover:bg-hover hover:text-fg max-sm:h-10 [&_svg]:size-4",
        active && "bg-active text-fg"
      )}
    >
      {children}
      {label}
    </button>
  )
}

export function ToolDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line max-sm:hidden" />
}

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

/** The next zoom step above or below `scale`, staying inside the range. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((s) => s > scale + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
  const lower = [...ZOOM_STEPS].reverse().find((s) => s < scale - 0.01)
  return lower ?? ZOOM_STEPS[0]
}
