import { motion, useReducedMotion } from "motion/react"
import { useLocation } from "react-router-dom"

/**
 * Route enter: fade + 6px rise, 200ms ease-out, transform/opacity only.
 * Keyed by pathname so search-param changes (filters, tabs) do not replay it.
 * No exit animation: back/forward swaps instantly and the new page rises,
 * which avoids the double-render jank of crossfading two pages.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  const reduce = useReducedMotion()
  return (
    <motion.div
      key={pathname}
      data-testid="page-transition"
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  )
}

/**
 * The sliding pill behind the selected tab. Render inside the selected tab
 * (which must be `relative isolate`); `group` names the tab set so two sets
 * on one page do not share a layout id. Reduced motion jumps instantly.
 */
export function TabIndicator({ group, className }: { group: string; className?: string }) {
  const reduce = useReducedMotion()
  return (
    <motion.span
      aria-hidden
      layoutId={`tab-indicator-${group}`}
      className={className ?? "absolute inset-0 -z-10 rounded-full bg-(--area)"}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 }}
    />
  )
}

/** Claude-like sidebar spring: quick, settles without visible overshoot. */
export const sidebarSpring = { type: "spring", stiffness: 420, damping: 40, mass: 0.9 } as const
