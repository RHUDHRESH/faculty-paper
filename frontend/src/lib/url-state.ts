import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router-dom"

/**
 * Screen state that lives in the address bar.
 *
 * Twelve of sixteen screens kept their filters in component state, which
 * meant three things that all read as the software being broken:
 *
 * - A view could not be sent to anybody. A principal narrowing to ECE, 2025,
 *   over-a-month-waiting had no way to share what they were looking at
 *   except by describing it.
 * - The back button left the screen. Filtering four times and pressing back
 *   returned to the previous *page*, not the previous filter, so the only way
 *   out of a filter was to undo it by hand.
 * - Reloading lost the lot, including the row somebody was halfway through
 *   reading.
 *
 * Defaults are kept out of the URL: a bare /admin/reports means the same
 * thing as one carrying every default spelled out, and the shorter one is
 * the one people paste.
 */
export function useUrlState<T extends Record<string, string>>(
  defaults: T
): [T, (patch: Partial<T>) => void, () => void] {
  const [params, setParams] = useSearchParams()

  const value = useMemo(() => {
    const out = { ...defaults }
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      const found = params.get(String(key))
      if (found !== null) out[key] = found as T[keyof T]
    }
    return out
  }, [params, defaults])

  const update = useCallback(
    (patch: Partial<T>) => {
      const next = new URLSearchParams(params)
      for (const [key, v] of Object.entries(patch)) {
        // A value equal to the default carries no information, so it does not
        // go in the URL — otherwise every link people share is twice as long
        // as it needs to be and no clearer.
        if (v === undefined || v === "" || v === defaults[key as keyof T]) {
          next.delete(key)
        } else {
          next.set(key, String(v))
        }
      }
      // Changing a filter resets the page: staying on page 7 of a narrower
      // result set shows an empty screen and reads as "no results".
      if (!("offset" in patch)) next.delete("offset")
      setParams(next, { replace: false })
    },
    [params, setParams, defaults]
  )

  const reset = useCallback(() => setParams(new URLSearchParams()), [setParams])

  return [value, update, reset]
}

/** Numbers still travel as text in a URL; this is the reading of them. */
export function asNumber(value: string | undefined, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
