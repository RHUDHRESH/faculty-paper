"use client"

import { type FormEvent, useEffect, useState } from "react"
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
            <Input
              id="current"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="next">New password</Label>
            <Input
              id="next"
              type="password"
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

export function ChangePasswordGate() {
  const { user, refresh } = useAuth()
  const [open, setOpen] = useState(false)

  // Sync forced dialog when user requires password change
  useEffect(() => {
    if (user?.must_change_password) setOpen(true)
  }, [user?.must_change_password])

  if (!user?.must_change_password && !open) return null

  return (
    <ChangePasswordDialog
      open={open || !!user?.must_change_password}
      forced={!!user?.must_change_password}
      onOpenChange={async (nextOpen) => {
        if (user?.must_change_password && !nextOpen) {
          await refresh()
          return
        }
        setOpen(nextOpen)
        if (!nextOpen) await refresh()
      }}
    />
  )
}
