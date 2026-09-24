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
