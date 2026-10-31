import { useEffect, useState } from "react"

/**
 * What says somebody is at the page. Scroll does not bubble, so every listener
 * is a capturing one on the window: it sees a scroll in any element.
 */
const INPUT = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "scroll"] as const

/**
 * True once `ms` have passed with no pointer, key, touch or scroll input; false
 * again at the next input, or when the person returns to the window.
 *
 * It exists for background work. A tab can be on screen for hours with nobody
 * at it, and anything that polls the server on a clock keeps a free host and
 * its database awake for all of them. Such work stops while this is true and
 * catches up once, at once, when it turns false.
 *
 * One timer, not one per event: input only writes a timestamp, and the timer
 * looks at it when it fires. A pointer moves a hundred times a second.
 */
export function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    let last = Date.now()
    let resting = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const arm = (delay: number) => {
      timer = setTimeout(check, delay)
    }
    function check() {
      const left = ms - (Date.now() - last)
      if (left > 0) {
        arm(left)
        return
      }
      resting = true
      setIdle(true)
    }
    const present = () => {
      last = Date.now()
      if (!resting) return
      resting = false
      setIdle(false)
      arm(ms)
    }
    const visible = () => {
      if (document.visibilityState === "visible") present()
    }

    setIdle(false)
    arm(ms)
    for (const type of INPUT) window.addEventListener(type, present, { capture: true, passive: true })
    window.addEventListener("focus", present)
    document.addEventListener("visibilitychange", visible)
    return () => {
      clearTimeout(timer)
      for (const type of INPUT) window.removeEventListener(type, present, { capture: true })
      window.removeEventListener("focus", present)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [ms])

  return idle
}
