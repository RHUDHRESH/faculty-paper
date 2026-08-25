import * as RadixTooltip from "@radix-ui/react-tooltip"

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
      {/* Same technique as menu.tsx: Radix only holds an element mounted for
          its close animation when that animation is a real @keyframes rule,
          not a CSS transition. */}
      <style>{`
@keyframes ui-tip-in { from { opacity: 0; transform: translate(var(--pop-x, 0), var(--pop-y, 0)); } to { opacity: 1; transform: translate(0, 0); } }
@keyframes ui-tip-out { from { opacity: 1; transform: translate(0, 0); } to { opacity: 0; transform: translate(var(--pop-x, 0), var(--pop-y, 0)); } }
`}</style>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-50 max-w-64 rounded-sm bg-fg px-2 py-1 text-xs text-bg",
            "data-[side=bottom]:[--pop-y:-4px] data-[side=top]:[--pop-y:4px]",
            "data-[side=right]:[--pop-x:-4px] data-[side=left]:[--pop-x:4px]",
            "data-[state=delayed-open]:animate-[ui-tip-in_120ms_var(--ease-out)]",
            "data-[state=instant-open]:animate-[ui-tip-in_120ms_var(--ease-out)]",
            "data-[state=closed]:animate-[ui-tip-out_120ms_var(--ease-out)]"
          )}
        >
          {content}
          <RadixTooltip.Arrow className="fill-fg" width={8} height={4} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
