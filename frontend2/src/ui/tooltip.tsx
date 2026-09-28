import * as RadixTooltip from "@radix-ui/react-tooltip"

import { popKeyframes, tooltipPop } from "@/ui/pop"
import { cn } from "@/lib/cn"

/**
 * A one-line hint anchored to whatever it explains — an icon-only button, an
 * abbreviation, a control that's disabled for a reason worth knowing.
 *
 * Never put anything here that is the only place a reader can learn it. A
 * tooltip does not print, is not read by a screen reader until the trigger
 * is focused, and is gone the instant a touch lifts — there is no hover on a
 * tablet. If the content matters on its own, it belongs in visible text, and
 * this becomes a repeat of that text for the pointer user, not the only copy
 * of it.
 *
 * One open delay (300ms) so a reader skimming past triggers doesn't get a
 * hint for every one of them; Radix's own `skipDelayDuration` (300ms by
 * default, set once via `TooltipProvider`) then removes that delay between
 * *adjacent* triggers, so hovering along a disabled toolbar reads each
 * reason immediately rather than waiting out the delay per icon.
 *
 * The animation is the one asymmetry in `ui/motion.ts`: in at `--dur-1` and
 * out at `--dur-2`, because a reader who has already waited 300ms for the
 * hint should not then wait for it to fade up, and a hint that disappears
 * the instant the pointer moves flickers as they run along a row of icons.
 */

export const TooltipProvider = RadixTooltip.Provider

export function Tooltip({
  content,
  children,
  side = "top",
  delayDuration = 300,
}: {
  content: React.ReactNode
  children: React.ReactElement
  side?: "top" | "right" | "bottom" | "left"
  delayDuration?: number
}) {
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      {/* Same technique as menu.tsx, and now the same keyframes: Radix only
          holds an element mounted for its close animation when that animation
          is a real @keyframes rule, not a CSS transition. */}
      <style>{popKeyframes}</style>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          // Grows from the corner nearest whatever it explains, so a hint on
          // a toolbar button reads as belonging to that button.
          style={{ transformOrigin: "var(--radix-tooltip-content-transform-origin)" }}
          className={cn(
            "z-50 max-w-64 rounded-sm bg-fg px-2 py-1 text-xs text-bg",
            tooltipPop
          )}
        >
          {content}
          <RadixTooltip.Arrow className="fill-fg" width={8} height={4} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
