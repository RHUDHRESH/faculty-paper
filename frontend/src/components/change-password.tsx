"use client"

import { type FormEvent, useState } from "react"
import { toast } from "sonner"
import { useAuth } from "@/components/auth-provider"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import { Label } from "@/components/ui/label"

export function ChangePasswordDialog({
  open,
  onOpenChange,
  forced = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  forced?: boolean
}) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        json: { current_password: current, new_password: next },
      })
      toast.success("Password updated")
      setCurrent("")
      setNext("")
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update password")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={forced ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={forced ? (e) => e.preventDefault() : undefined}>
        <DialogHeader>
          <DialogTitle>{forced ? "Set a new password" : "Change password"}</DialogTitle>
          <DialogDescription>
            {forced
              ? "Your account requires a password change before continuing."
              : "Choose a new password for your account."}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="current">Current password</Label>
            <PasswordInput
              id="current"
                            value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="next">New password</Label>
            <PasswordInput
              id="next"
                            value={next}
              onChange={(e) => setNext(e.target.value)}
              minLength={8}
              required
              autoComplete="new-password"
            />
          </div>
          <DialogFooter>
            {!forced ? (
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            ) : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Update password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The dialog that will not go away.
 *
 * It was shown whenever `open || must_change_password`, and the close handler
 * for the forced case refreshed the account and returned without ever putting
 * `open` back to false. So the sequence was: the flag opens it, you set a new
 * password, the flag clears — and `open` is still true from when the flag set
 * it, so the dialog re-renders open on top of a success message saying it had
 * worked. The only way out was a reload.
 *
 * One source of truth now: the dialog is open when the account demands it or
 * when the reader asked for it, and closing clears both.
 */
export function ChangePasswordGate() {
  const { user, refresh } = useAuth()
  const [open, setOpen] = useState(false)
  const forced = !!user?.must_change_password

  if (!forced && !open) return null

  return (
    <ChangePasswordDialog
      open={forced || open}
      forced={forced}
      onOpenChange={async (nextOpen) => {
        // Closing means closed, whichever reason it was opened for. The
        // refresh is what clears `forced`; setOpen is what clears the rest,
        // and leaving the second one out is what pinned it to the screen.
        setOpen(nextOpen)
        if (!nextOpen) await refresh()
      }}
    />
  )
}
