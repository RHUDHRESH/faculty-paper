import { Children, cloneElement, isValidElement } from "react"
import { useReducedMotion } from "motion/react"

import { cn } from "@/lib/cn"

/** Past this many items the rest appear at once — a list never walks down the page. */
export const STAGGER_CAP = 8

/**
 * Staggers its direct children in on first mount (CSS keyframe: opacity plus
 * a 4px rise). Adds no wrapper element: it adds a class and a delay to each
 * child, so it is safe inside a <ul> or a grid.
 */
export function Stagger({ children, step = 30 }: { children: React.ReactNode; step?: number }) {
  const reduce = useReducedMotion()
  if (reduce) return <>{children}</>
  let i = 0
  return (
    <>
      {Children.map(children, (child) => {
        if (!isValidElement<{ className?: string; style?: React.CSSProperties }>(child)) return child
        const n = i++
        if (n >= STAGGER_CAP) return child
        return cloneElement(child, {
          className: cn(child.props.className, "stagger-in"),
          style: { ...child.props.style, animationDelay: `${n * step}ms` },
        })
      })}
    </>
  )
}
