import { cn } from "@/lib/cn"

/**
 * A key cap, for the hint that says which key does this. The look lives on the
 * `kbd` element in styles.css (so a raw `<kbd>` and this are identical, and it
 * takes the colour of whatever it sits in: paper, a caption, the navy button).
 *
 * Put it inside the button it belongs to: `<Button>Clear <Kbd>C</Kbd></Button>`.
 * It hides itself on touch screens, where it would only be noise.
 *
 * `keys` joins several caps with a thin gap ("Ctrl", "K") so they read as one
 * chord; a single child is the common case.
 */
export function Kbd({ children, className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd className={cn("ml-0.5", className)} {...props}>
      {children}
    </kbd>
  )
}

/** A chord: "Ctrl" + "K" drawn as two caps that belong together. */
export function KbdChord({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-hidden>
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  )
}
