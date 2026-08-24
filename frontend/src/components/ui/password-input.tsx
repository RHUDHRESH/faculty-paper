"use client"

import { forwardRef, useId, useState } from "react"
import { Eye, EyeOff } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * A password field you can check before you commit to it.
 *
 * Five of these existed across the app and not one could be read back. That
 * is not a small thing here: the passwords this system issues look like
 * `RzSRfIOD%V*uQYfw2_j0L#2M`, they are handed over on paper or in a
 * spreadsheet, and they are typed by people who cannot see whether the caps
 * lock is down or whether the `l` they typed was a `1`. A failed sign-in tells
 * them nothing about which. After five failures the account locks.
 *
 * So: a reveal toggle, a caps-lock warning, and a real focus ring. The toggle
 * is a button rather than a checkbox because it does something rather than
 * records a preference, it announces its state to a screen reader, and it sits
 * outside the tab order between the field and the submit button — pressing Tab
 * from the password box should reach the button you came to press.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  React.ComponentProps<typeof Input> & {
    /** Shown under the field while caps lock is on. */
    capsWarning?: boolean
  }
>(function PasswordInput({ className, capsWarning = true, ...props }, ref) {
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const hintId = useId()

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Input
          ref={ref}
          {...props}
          type={shown ? "text" : "password"}
          className={cn("pr-11", className)}
          aria-describedby={caps ? hintId : props["aria-describedby"]}
          onKeyUp={(e) => {
            if (capsWarning) setCaps(e.getModifierState?.("CapsLock") ?? false)
            props.onKeyUp?.(e)
          }}
          onBlur={(e) => {
            setCaps(false)
            props.onBlur?.(e)
          }}
        />
        <button
          type="button"
          // Out of the tab order on purpose: Tab from the password field
          // should reach Sign in, not a decoration in between.
          tabIndex={-1}
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          className={cn(
            "absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center",
            "rounded-md text-muted-foreground transition-colors hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {shown ? (
            <EyeOff className="size-4" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
        </button>
      </div>
      {caps ? (
        <p id={hintId} role="status" className="text-xs text-warning-foreground">
          Caps lock is on.
        </p>
      ) : null}
    </div>
  )
})
