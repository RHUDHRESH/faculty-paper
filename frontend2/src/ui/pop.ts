/**
 * The CSS half of the motion vocabulary (see `ui/motion.ts`).
 *
 * Kept apart from `motion.ts` because that file imports `motion/react`, and
 * the menu and the tooltip -- the account menu is in the sidebar from the
 * first paint -- need only these strings. Importing them from `motion.ts`
 * put the whole animation library on the path to the first screen.
 */

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
