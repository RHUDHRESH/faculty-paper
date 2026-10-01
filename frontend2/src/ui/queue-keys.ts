import { useEffect, type RefObject } from "react"

/**
 * `/` puts the cursor in a queue's search box, as it does in most tools a
 * desk already uses. Ignored while somebody is typing in another field, so a
 * slash in a note or a DOI is only ever a slash.
 */
export function useSlashToSearch(search: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (!search.current) return
      e.preventDefault()
      search.current.focus()
      search.current.select()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [search])
}

/**
 * Single-letter keys for working down a queue (j/k to move, a letter to act).
 * Ignored while typing, with a modifier held, or while a dialog is open, so a
 * letter in a note is only ever a letter. Pass a stable (memoised) map.
 */
export function useQueueKeys(handlers: Record<string, () => void>, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (document.querySelector('[role="dialog"]')) return
      const run = handlers[e.key]
      if (!run) return
      e.preventDefault()
      run()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [handlers, enabled])
}
