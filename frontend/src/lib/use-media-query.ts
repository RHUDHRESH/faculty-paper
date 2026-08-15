import { useEffect, useState } from "react"

/** Tailwind's `lg` breakpoint, where the master-detail layout takes over. */
const DESKTOP = "(min-width: 1024px)"

/**
 * True once the layout is wide enough to show detail beside the list.
 *
 * The ticket detail lives in two places: inline on desktop, and a bottom sheet
 * on smaller screens. Hiding the sheet with `lg:hidden` hid only its *content* —
 * Radix still mounted the overlay and set `pointer-events: none` on the body, so
 * clicking a ticket on a desktop window dimmed and froze the page with nothing
 * visible to dismiss. The sheet has to not open at all up here.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP).matches
  )

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP)
    const onChange = () => setIsDesktop(mq.matches)
    onChange()
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  return isDesktop
}
