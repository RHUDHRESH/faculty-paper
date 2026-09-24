import { useEffect, useState } from "react"

/**
 * Ctrl-K / Cmd-K from anywhere, and Escape to leave.
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
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return { open, setOpen }
}
