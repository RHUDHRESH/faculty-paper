import { useEffect, useRef, useState } from "react"
import { animate, useReducedMotion } from "motion/react"

const fmt = (n: number) => Math.round(n).toLocaleString()

/**
 * Counts a number up from 0 on first show (and from the old value on change).
 * The caller's `.figure` class uses tabular figures, so nothing shifts.
 * Reduced motion shows the final value immediately.
 */
export function CountUp({ value, duration = 0.7, format = fmt }: { value: number; duration?: number; format?: (n: number) => string }) {
  const reduce = useReducedMotion()
  const [shown, setShown] = useState(reduce ? value : 0)
  const from = useRef(reduce ? value : 0)
  useEffect(() => {
    if (reduce) {
      from.current = value
      setShown(value)
      return
    }
    const c = animate(from.current, value, { duration, ease: [0.16, 1, 0.3, 1], onUpdate: setShown })
    from.current = value
    return () => c.stop()
  }, [value, reduce, duration])
  return (
    <span aria-label={format(value)}>
      <span aria-hidden>{format(reduce ? value : shown)}</span>
    </span>
  )
}

/** Count a figure up when it is a plain number (or numeric string); otherwise pass it through. */
export function MaybeCount({ figure }: { figure: React.ReactNode }) {
  if (typeof figure === "number" && Number.isFinite(figure)) return <CountUp value={figure} />
  if (typeof figure === "string" && /^\d{1,3}(,\d{3})*$|^\d+$/.test(figure)) {
    return <CountUp value={Number(figure.replace(/,/g, ""))} />
  }
  return <>{figure}</>
}
