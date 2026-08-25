import * as RadixMenu from "@radix-ui/react-dropdown-menu"

import { cn } from "@/lib/cn"

/**
 * A small menu anchored to a point rather than a place: a row's overflow
 * button, a toolbar action with more than one option behind it.
 *
 * Radix supplies the positioning, the focus loop and type-ahead; it also
 * keeps `MenuContent` mounted for exactly as long as its close animation
 * takes, but only if that animation is a real CSS `@keyframes` — a plain
 * transition doesn't count, because Radix detects "still animating" by
 * listening for `animationend`, not by watching styles change. That's what
 * the inline `<style>` below is for: two keyframes, small enough not to
 * deserve a build step, parameterised by `--pop-x`/`--pop-y` so the same pair
 * serves all four sides. Dialog and sheet don't need this because their
 * motion (an 8px rise, a scale) is driven by `motion/react` instead.
 */

export const Menu = RadixMenu.Root
export const MenuTrigger = RadixMenu.Trigger

export function MenuContent({
  className,
  sideOffset = 6,
  align = "start",
  ...props
}: React.ComponentProps<typeof RadixMenu.Content>) {
  return (
    <>
      {/* Global by nature (keyframes can't be scoped) but only ever in the
          document while a menu is open or closing. */}
      <style>{`
@keyframes ui-pop-in { from { opacity: 0; transform: translate(var(--pop-x, 0), var(--pop-y, 0)); } to { opacity: 1; transform: translate(0, 0); } }
@keyframes ui-pop-out { from { opacity: 1; transform: translate(0, 0); } to { opacity: 0; transform: translate(var(--pop-x, 0), var(--pop-y, 0)); } }
`}</style>
      <RadixMenu.Portal>
        <RadixMenu.Content
          sideOffset={sideOffset}
          align={align}
          className={cn(
            "z-50 min-w-[10rem] overflow-hidden rounded-md bg-surface p-1",
            "shadow-pop",
            // Direction of the 4px rise follows whichever edge Radix actually
            // placed the menu on, which can differ from the requested side
            // once collision detection flips it.
            "data-[side=bottom]:[--pop-y:-4px] data-[side=top]:[--pop-y:4px]",
            "data-[side=right]:[--pop-x:-4px] data-[side=left]:[--pop-x:4px]",
            "data-[state=open]:animate-[ui-pop-in_120ms_var(--ease-out)]",
            "data-[state=closed]:animate-[ui-pop-out_120ms_var(--ease-out)]",
            className
          )}
          {...props}
        />
      </RadixMenu.Portal>
    </>
  )
}

/** A group heading inside the menu — "Account", not a column head, so it is
 *  not uppercase; see the rule against shouted labels in CONVENTIONS.md. */
export function MenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof RadixMenu.Label>) {
  return (
    <RadixMenu.Label
      className={cn("px-2 py-1 text-xs font-medium text-fg-subtle", className)}
      {...props}
    />
  )
}

export function MenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof RadixMenu.Separator>) {
  return <RadixMenu.Separator className={cn("my-1 h-px bg-line", className)} {...props} />
}

/** A row in the menu. `danger` carries the same meaning as `Button`'s
 *  `danger` kind — something that cannot be undone — so the two never
 *  disagree about which actions in this app are dangerous. `shortcut` is a
 *  hint, not a binding: it says what key does this, it doesn't register it. */
export function MenuItem({
  className,
  danger,
  shortcut,
  children,
  ...props
}: React.ComponentProps<typeof RadixMenu.Item> & { danger?: boolean; shortcut?: string }) {
  return (
    <RadixMenu.Item
      className={cn(
        "flex h-7 cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-sm outline-none",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        danger
          ? "text-critical data-[highlighted]:bg-critical-wash"
          : "text-fg data-[highlighted]:bg-hover",
        className
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && (
        <span className="shrink-0 text-xs text-fg-subtle" aria-hidden>
          {shortcut}
        </span>
      )}
    </RadixMenu.Item>
  )
}
