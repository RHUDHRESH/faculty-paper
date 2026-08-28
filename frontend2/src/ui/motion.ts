import { useMemo } from "react"
import { useReducedMotion, type Transition, type Variants } from "motion/react"

/**
 * The motion vocabulary — every duration, easing and variant this app is
 * allowed to move with, in one file.
 *
 * Without it each surface picks its own numbers, which is exactly what had
 * happened: `0.12`, `0.14`, `0.16`, `0.18`, `0.22`, `0.24` and `0.28` were
 * all in use, and `[0.16, 1, 0.3, 1]` — the `--ease-out` curve, spelled out
 * by hand — appeared in nine files. Nothing looks broken when timings drift
 * like that; the interface just stops feeling like one thing, and there is
 * no single place to change if it does.
 *
 * Two forms, because there are two kinds of surface here:
 *
 *   JS  — dialog, sheet, anything whose exit is driven by `AnimatePresence`.
 *         Use the `*Variants` exports with `useMotionVariants`.
 *   CSS — menu, tooltip, anything whose mount is owned by Radix. Radix holds
 *         an element in the tree for its close animation only when that
 *         animation is a real `@keyframes` rule, because it waits for
 *         `animationend`. Those surfaces use `popKeyframes` plus `menuPop` or
 *         `tooltipPop` instead, and read the `--dur-*` tokens directly.
 *
 * Both forms describe the same feel and both are timed from the same three
 * tokens, so a change to `--dur-2` in `styles.css` moves the CSS surfaces on
 * its own and needs one number changed here for the rest.
 */

/**
 * Durations in seconds, because `motion/react` counts in seconds and CSS
 * counts in milliseconds. Each one mirrors a token in `styles.css` — this is
 * the JS copy of that scale, not a second scale.
 *
 * There is no step between 80ms and 140ms, which is the one gap worth
 * knowing about: a menu pop wants roughly 120ms and gets `base` instead.
 * 140ms is close enough that inventing a token for it would cost more than
 * it buys, and hard-coding `120ms` in one component is how the drift above
 * started.
 */
export const duration = {
  /** `--dur-1`, 80ms. Exits, and anything a pointer triggered directly. */
  fast: 0.08,
  /** `--dur-2`, 140ms. The default entrance. */
  base: 0.14,
  /** `--dur-3`, 220ms. Only for a surface crossing a real distance. */
  slow: 0.22,
} as const

/** The same three as CSS values, for a class-driven animation. */
export const durationVar = {
  fast: "var(--dur-1)",
  base: "var(--dur-2)",
  slow: "var(--dur-3)",
} as const

/**
 * `--ease-out` and `--ease-in-out`, as bezier tuples.
 *
 * `out` for anything that arrives or leaves: it covers most of the distance
 * in the first third, which is what makes a fast animation read as a
 * response rather than as a delay. `inOut` only for something that moves
 * from one place to another while staying on screen.
 */
export const easing = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const

/** A surface arriving. */
export const enterTransition: Transition = { duration: duration.base, ease: easing.out }

/**
 * A surface leaving. Deliberately faster than the entrance: nobody waits to
 * watch something they have already dismissed, and Escape has to feel like
 * it worked before the pixels agree that it did.
 */
export const exitTransition: Transition = { duration: duration.fast, ease: easing.out }

/** An entrance that crosses the screen rather than an inch of it — a sheet. */
export const travelTransition: Transition = { duration: duration.slow, ease: easing.out }

/**
 * The matching exit. Still shorter than the entrance, but not `fast`: a
 * surface that has travelled the width of the screen and then leaves in 80ms
 * does not read as quick, it reads as a cut.
 */
export const travelExitTransition: Transition = { duration: duration.base, ease: easing.out }

/** What every variant collapses to when the reader has asked for less. */
export const fadeTransition: Transition = { duration: duration.fast, ease: easing.out }

/**
 * The wash behind a dialog or a sheet. Opacity only: it covers the whole
 * viewport, so anything else here is a full-screen composite every frame.
 */
export const overlayVariants: Variants = {
  hidden: { opacity: 0, transition: exitTransition },
  visible: { opacity: 1, transition: enterTransition },
}

/**
 * A dialog. A centred surface has no edge to come from, so it rises the 8px
 * a sheet of paper would and settles from 98.5% — enough to read as arriving
 * from under the pointer, not enough to look like a zoom.
 */
export const dialogVariants: Variants = {
  hidden: { opacity: 0, y: 8, scale: 0.985, transition: exitTransition },
  visible: { opacity: 1, y: 0, scale: 1, transition: enterTransition },
}

/** Which edge a sheet belongs to. */
export type Edge = "top" | "right" | "bottom" | "left"

/**
 * A sheet, per edge. Percentage translates, never `left` or `top`: a sheet
 * opens beside a table that may hold fifty rows, and animating its position
 * rather than its transform reflows every one of them once a frame.
 */
export const sheetVariants: Record<Edge, Variants> = {
  right: {
    hidden: { opacity: 0, x: "100%", transition: travelExitTransition },
    visible: { opacity: 1, x: 0, transition: travelTransition },
  },
  left: {
    hidden: { opacity: 0, x: "-100%", transition: travelExitTransition },
    visible: { opacity: 1, x: 0, transition: travelTransition },
  },
  bottom: {
    hidden: { opacity: 0, y: "100%", transition: travelExitTransition },
    visible: { opacity: 1, y: 0, transition: travelTransition },
  },
  top: {
    hidden: { opacity: 0, y: "-100%", transition: travelExitTransition },
    visible: { opacity: 1, y: 0, transition: travelTransition },
  },
}

/**
 * A short list arriving one item at a time.
 *
 * For a list short enough that the last item still lands inside a fifth of a
 * second — eight or ten rows, a set of results, the cards on a home screen.
 * Never a data table: at 20ms a step a fifty-row table would still be
 * assembling itself a full second after its data arrived, and a reader
 * looking for one number would watch it walk down the page.
 */
export const listVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.02 } },
}

/** One item inside a `listVariants` parent. */
export const listItemVariants: Variants = {
  hidden: { opacity: 0, y: 4, transition: exitTransition },
  visible: { opacity: 1, y: 0, transition: enterTransition },
}

/**
 * The same variants with every transform stripped out, leaving the opacity.
 *
 * Reduced motion has to mean less motion, not a missing component: a dialog
 * whose entrance is simply cancelled either never appears or appears without
 * its overlay, and both are worse than the animation was. So the surface
 * still arrives and still leaves — it just does it by fading, in one step,
 * in 80ms.
 *
 * A variant given as a function of `custom` is passed through untouched.
 * There is nothing to strip without calling it, and the callers that need
 * one are rare enough to be worth handling by hand.
 */
export function reducedMotion(variants: Variants): Variants {
  const faded: Variants = {}
  for (const name of Object.keys(variants)) {
    const state = variants[name]
    if (typeof state === "function") {
      faded[name] = state
      continue
    }
    const opacity = state.opacity
    faded[name] = { opacity: opacity === undefined ? 1 : opacity, transition: fadeTransition }
  }
  return faded
}

/**
 * The variants a surface should actually animate with, given what the reader
 * has asked their system for.
 *
 * The global `prefers-reduced-motion` rule in `styles.css` cannot reach any
 * of this. It caps `animation-duration` and `transition-duration`, and
 * `motion/react` uses neither — it drives the Web Animations API, which that
 * rule does not touch. So every JS-animated surface has to ask on its own
 * behalf, and this is how it asks.
 *
 * Pass a variants object that is stable between renders (every export above
 * is); the memo is what stops a surface re-resolving its animation each time
 * its parent renders.
 */
export function useMotionVariants(variants: Variants): Variants {
  const reduce = useReducedMotion()
  return useMemo(() => (reduce ? reducedMotion(variants) : variants), [reduce, variants])
}

/**
 * The keyframes behind `menuPop` and `tooltipPop`.
 *
 * Keyframes cannot be scoped to a component, so this is global by nature; it
 * is rendered inside the surfaces that use it, which means it is in the
 * document wherever one of them is mounted and nowhere else. A page with
 * several menus therefore holds several identical copies, which costs
 * nothing — an identical `@keyframes` redefinition is not a conflict — and
 * saves the app a global stylesheet for two rules.
 *
 * Both animations are parameterised by custom properties, so one pair covers
 * every side a popper can land on:
 *
 *   `--pop-x` / `--pop-y`   the 4px the surface travels, signed by side
 *   `--pop-scale`           what it grows from, about its own anchor
 *
 * The reduced-motion block redefines both as a plain fade. The global rule
 * in `styles.css` would already have squashed them to nothing visible, but
 * that rule is a blunt instrument and this says what the fallback is meant
 * to be instead of leaving it to one.
 */
export const popKeyframes = `
@keyframes ui-pop-in {
  from { opacity: 0; transform: translate(var(--pop-x, 0), var(--pop-y, 0)) scale(var(--pop-scale, 0.96)); }
  to { opacity: 1; transform: translate(0, 0) scale(1); }
}
@keyframes ui-pop-out {
  from { opacity: 1; transform: translate(0, 0) scale(1); }
  to { opacity: 0; transform: translate(var(--pop-x, 0), var(--pop-y, 0)) scale(var(--pop-scale, 0.96)); }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes ui-pop-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ui-pop-out { from { opacity: 1; } to { opacity: 0; } }
}
`

/**
 * A menu opening from wherever Radix put it. The direction of the 4px rise
 * follows the side Radix actually chose, which is not always the side that
 * was asked for once collision detection has flipped it.
 *
 * Set `transform-origin` to the popper's own origin variable alongside this,
 * or the scale grows from the middle of the menu instead of from the button
 * that opened it — which is the difference between a menu unfolding and a
 * menu simply appearing.
 */
export const menuPop =
  "data-[side=bottom]:[--pop-y:-4px] data-[side=top]:[--pop-y:4px] " +
  "data-[side=right]:[--pop-x:-4px] data-[side=left]:[--pop-x:4px] " +
  "data-[state=open]:animate-[ui-pop-in_var(--dur-2)_var(--ease-out)] " +
  "data-[state=closed]:animate-[ui-pop-out_var(--dur-1)_var(--ease-out)]"

/**
 * A tooltip, which moves on different terms from everything else here.
 *
 * In at `--dur-1`: the wait before a tooltip opens is the delay Radix
 * already imposes, and an animation on top of that makes a hint asked for
 * 300ms ago take another 140ms to become readable.
 *
 * Out at `--dur-2`, slower than it arrived, which is the one place this app
 * breaks its own rule that an exit is faster than an entrance. A tooltip
 * blocks nothing on its way out, and a hint that vanishes the instant the
 * pointer moves reads as a flicker to a reader running along a row of
 * icon-only buttons.
 */
export const tooltipPop =
  "data-[side=bottom]:[--pop-y:-4px] data-[side=top]:[--pop-y:4px] " +
  "data-[side=right]:[--pop-x:-4px] data-[side=left]:[--pop-x:4px] " +
  "data-[state=delayed-open]:animate-[ui-pop-in_var(--dur-1)_var(--ease-out)] " +
  "data-[state=instant-open]:animate-[ui-pop-in_var(--dur-1)_var(--ease-out)] " +
  "data-[state=closed]:animate-[ui-pop-out_var(--dur-2)_var(--ease-out)]"
