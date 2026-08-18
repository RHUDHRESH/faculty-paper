/**
 * A permanent, unmissable reminder of whose session this is.
 *
 * The whole risk of "view as another user" is forgetting you are in it. The
 * banner is fixed to the top of the viewport, cannot be dismissed, and says
 * plainly that nothing can be changed — the server refuses every write for the
 * duration, so this describes a real guarantee rather than an intention.
 */
import { Eye, LogOut } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"

export function ImpersonationBanner() {
  const { user, refresh } = useAuth()
  const [busy, setBusy] = useState(false)
  const by = (user as { impersonated_by?: { name?: string; email?: string } } | null)
    ?.impersonated_by

  if (!by) return null

  async function stop() {
    setBusy(true)
    try {
      await api("/api/admin/stop-impersonating", { method: "POST" })
      await refresh()
      toast.success("Back to your own account")
      // A full reload clears every cached query belonging to the other person.
      window.location.assign("/admin")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not stop")
      setBusy(false)
    }
  }

  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b border-warning/40 bg-warning/15 px-4 py-2.5 text-sm backdrop-blur"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Eye className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0">
          Viewing as <strong className="font-semibold">{user?.name || user?.email}</strong>{" "}
          — read only. Nothing can be changed while you are here.
        </span>
      </span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={stop} className="gap-1.5">
        <LogOut className="size-4" />
        {busy ? "Returning…" : `Back to ${by.name || by.email}`}
      </Button>
    </div>
  )
}
