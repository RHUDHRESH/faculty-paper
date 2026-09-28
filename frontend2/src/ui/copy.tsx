import { useState } from "react"
import { Check, Copy } from "lucide-react"

import { cn } from "@/lib/cn"

/**
 * A ticket number is read aloud on the phone and pasted into emails; a
 * one-press copy beside it saves selecting a hyphenated string by hand.
 */
export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true)
          window.setTimeout(() => setDone(false), 1400)
        })
      }}
      aria-label={done ? "Copied" : `Copy ${label ?? value}`}
      title={done ? "Copied" : "Copy"}
      className={cn(
        "inline-grid size-6 place-items-center rounded-sm align-middle text-fg-subtle hover:bg-hover hover:text-fg",
        className
      )}
    >
      {done ? <Check className="size-3.5 text-positive" /> : <Copy className="size-3.5" />}
    </button>
  )
}
