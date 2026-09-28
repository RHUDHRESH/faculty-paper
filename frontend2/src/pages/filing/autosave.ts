import { useEffect, type MutableRefObject } from "react"

/**
 * Save a draft a moment after the last edit — but only if it is still unsaved
 * when the moment comes.
 *
 * The dirty flag is read when the timer fires, not when it is set. Filing
 * clears the flag; a timer armed by the last keystroke before "File it" used
 * to fire afterwards anyway and POST a second draft of the paper that had
 * just been filed (found by the year-long e2e scenario).
 */
export function useDebouncedSave(
  trigger: unknown,
  dirtyRef: MutableRefObject<boolean>,
  save: () => void,
  delay = 2500
): void {
  useEffect(() => {
    if (!dirtyRef.current) return
    const t = setTimeout(() => {
      if (dirtyRef.current) save()
    }, delay)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger])
}
