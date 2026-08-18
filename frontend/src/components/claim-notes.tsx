"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Check, MessageSquare } from "lucide-react"

import { useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { formatDateTime } from "@/components/ticket-ui"
import { api } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * Notes raised on one ticket, between the principal and the research cell.
 *
 * Tied to a ticket on purpose. A general question about "the February batch"
 * becomes a mail in somebody's inbox and dies there; a note on the ticket is
 * in front of whoever picks that ticket up, and stays with it afterwards.
 *
 * Never shown to the claimant and never to finance — the server enforces
 * that, and this panel only renders for the two roles that may read it.
 * A claimant reading "why is this person claiming three of these" would be a
 * different and much worse product.
 */

type Note = {
  id: string
  body: string
  author_name: string | null
  author_role: string | null
  created_at: string
  resolved_at: string | null
  resolved_by_name: string | null
}

const ADMIN_ROLES = ["SUPER_ADMIN", "RESEARCH_CELL"]

export function ClaimNotes({ claimId }: { claimId: string }) {
  const { user } = useAuth()
  const role = String(user?.role || "")
  const isAdmin = ADMIN_ROLES.includes(role)
  const isPrincipal = role === "PRINCIPAL"
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)

  const { data, refetch, isError } = useApiQuery<{ results: Note[] }>(
    ["claim-notes", claimId],
    `/api/claims/${claimId}/notes`,
    { enabled: isAdmin || isPrincipal }
  )

  if (!isAdmin && !isPrincipal) return null

  const notes = data?.results || []
  const open = notes.filter((n) => !n.resolved_at).length

  async function send() {
    const text = body.trim()
    if (text.length < 3) {
      toast.error("Write the note first")
      return
    }
    setBusy(true)
    try {
      await api(`/api/claims/${claimId}/notes`, { method: "POST", json: { body: text } })
      setBody("")
      await refetch()
      toast.success("Raised with the research cell")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the note")
    } finally {
      setBusy(false)
    }
  }

  async function resolve(id: string) {
    try {
      await api(`/api/claims/notes/${id}/resolve`, { method: "POST" })
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not close the note")
    }
  }

  return (
    <section className="rounded-[var(--radius)] border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
          Notes on this ticket
          {open ? (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning-foreground">
              {open} open
            </span>
          ) : null}
        </h3>
        <span className="text-xs text-muted-foreground">
          Principal and research cell only
        </span>
      </div>

      {isError ? (
        <p className="text-xs text-destructive">Could not load the notes.</p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing raised on this ticket.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li
              key={n.id}
              className={cn(
                "rounded-xl border px-3 py-2.5",
                n.resolved_at
                  ? "border-border bg-muted/30"
                  : "border-warning/40 bg-warning/5"
              )}
            >
              <p className="whitespace-pre-wrap text-sm text-foreground">{n.body}</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>{n.author_name || "Unknown"}</span>
                <span aria-hidden>·</span>
                <span>{formatDateTime(n.created_at)}</span>
                {n.resolved_at ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-success">
                      Closed by {n.resolved_by_name || "the research cell"}
                    </span>
                  </>
                ) : isAdmin ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => resolve(n.id)}
                  >
                    <Check className="size-3.5" />
                    Mark handled
                  </Button>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-2">
        <Textarea
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            isPrincipal
              ? "Ask the research cell about this ticket"
              : "Add a note for the principal and the research cell"
          }
          aria-label="New note on this ticket"
        />
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={busy || body.trim().length < 3} onClick={send}>
            {busy ? "Saving…" : "Raise a note"}
          </Button>
        </div>
      </div>
    </section>
  )
}
