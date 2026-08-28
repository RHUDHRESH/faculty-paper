import * as RadixMenu from "@radix-ui/react-dropdown-menu"

import { menuPop, popKeyframes } from "@/ui/motion"
import { cn } from "@/lib/cn"

/**
 * A small menu anchored to a point rather than a place: a row's overflow
 * button, a toolbar action with more than one option behind it.
 *
 * Radix supplies the positioning, the focus loop and type-ahead; it also
 * keeps `MenuContent` mounted for exactly as long as its close animation
 * takes, but only if that animation is a real CSS `@keyframes` — a plain
 * transition doesn't count, because Radix detects "still animating" by
 * listening for `animationend`, not by watching styles change. That is why
 * this surface is animated by the CSS half of `ui/motion.ts` (`popKeyframes`
 * and `menuPop`) rather than by `motion/react`, which drives the dialog and
 * the sheet. Same durations, same curve, different mechanism, because Radix
 * owns when this element leaves the tree and `AnimatePresence` owns when
 * those two do.
 */

export const Menu = RadixMenu.Root
export const MenuTrigger = RadixMenu.Trigger

export function MenuContent({
  className,
  sideOffset = 6,
  align = "start",
  style,
  ...props
}: React.ComponentProps<typeof RadixMenu.Content>) {
  return (
    <>
      {/* Global by nature — keyframes cannot be scoped — and shared with the
          tooltip, so several copies of the identical rule can be in the
          document at once. That is not a conflict; see `popKeyframes`. */}
      <style>{popKeyframes}</style>
      <RadixMenu.Portal>
        <RadixMenu.Content
          sideOffset={sideOffset}
          align={align}
          // Radix puts the corner nearest the trigger in this variable, so
          // the menu grows out of the button that opened it rather than out
          // of its own middle. Without it, a menu that opens upwards appears
          // to come from the wrong direction.
          style={{
            transformOrigin: "var(--radix-dropdown-menu-content-transform-origin)",
            ...style,
          }}
          className={cn(
            "z-50 min-w-[10rem] overflow-hidden rounded-md bg-surface p-1",
            "shadow-pop",
            menuPop,
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
