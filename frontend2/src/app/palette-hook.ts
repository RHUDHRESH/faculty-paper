import { useEffect, useState } from "react"

/** True when a key press belongs to something being typed into. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable
}

/**
 * Ctrl-K / Cmd-K from anywhere (including inside a form such as the file
 * wizard), and `/` when not typing in a field (docs/ux/02-search.md).
 *
 * Kept out of `palette.tsx` so listening for the key costs the first screen
 * nothing: the palette (and the animation library it opens with) is fetched
 * the first time it is asked for.
 */
export function usePalette() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) {
        // A queue page claims `/` for its own search box (ui/queue-keys.ts);
        // wait for the whole dispatch and yield to it if it did.
        queueMicrotask(() => {
          if (!e.defaultPrevented) setOpen(true)
        })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return { open, setOpen }
}
