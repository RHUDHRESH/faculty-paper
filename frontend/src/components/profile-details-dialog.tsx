import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Copy, ExternalLink } from "lucide-react"

import { useAuth } from "@/components/auth-provider"
import { Callout, ChoiceCards, Field, ReadOnlyField } from "@/components/form/fields"
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
import { api, type User } from "@/lib/api"
import { DESIGNATIONS, extractScopusAuthorId } from "@/lib/claim-fields"

/** Fields the research cell owns — a faculty edit here would move the money. */
const LOCKED_HINT =
  "Held on your staff record by the research cell. It decides which department a ticket is filed under and which account is paid, so it cannot be edited here."

function correctionRequest(user: User | null): string {
  return [
    `Profile correction request — ${user?.name || ""} (${user?.email || ""})`,
    `Department: ${user?.department || "not set"}`,
    `Staff ID: ${user?.staff_id || "not set"}`,
    `Biometric ID: ${user?.biometric_id || "not set"}`,
    "",
    "Please correct: ",
  ].join("\n")
}

/**
 * Edit your own profile without leaving the claim wizard.
 *
 * Sending the user to /profile mid-form would throw away everything typed so
 * far — the wizard keeps its state in memory — so the same details are editable
 * here and saved straight to the account.
 */
export function ProfileDetailsDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: (user: User) => void
}) {
  const { user, refresh } = useAuth()
  const [form, setForm] = useState({
    name: "",
    designation: "",
    scopus_author_url: "",
    scopus_author_id: "",
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !user) return
    setForm({
      name: user.name || "",
      designation: user.designation || "",
      scopus_author_url: user.scopus_author_url || "",
      scopus_author_id: user.scopus_author_id || "",
    })
  }, [open, user])

  async function save() {
    setBusy(true)
    try {
      const updated = await api<User>("/api/auth/profile", { method: "PATCH", json: form })
      await refresh()
      toast.success("Profile updated")
      onSaved?.(updated)
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save your profile")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Your profile details</DialogTitle>
          <DialogDescription>
            Saved to your account and reused on every ticket you file. Nothing you have typed into
            the claim is lost.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Field label="Full name" htmlFor="pd-name" required>
            <Input
              id="pd-name"
              className="h-9"
              autoComplete="name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>

          <Field label="Designation" required>
            <ChoiceCards
              name="Designation"
              columns={2}
              value={form.designation}
              onChange={(v) => setForm({ ...form, designation: v })}
              options={DESIGNATIONS.map((d) => ({ value: d, label: d }))}
            />
          </Field>

          <Field
            label="Scopus author profile link"
            htmlFor="pd-scopus-url"
            required
            hint={
              <>
                The article must be indexed and linked to this profile.{" "}
                <a
                  href="https://www.scopus.com/feedback/author/home.uri"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                >
                  Author Feedback Wizard
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </>
            }
          >
            <Input
              id="pd-scopus-url"
              className="h-9"
              inputMode="url"
              placeholder="https://www.scopus.com/authid/detail.uri?authorId=…"
              value={form.scopus_author_url}
              onChange={(e) => {
                const url = e.target.value
                const derived = extractScopusAuthorId(url)
                setForm((f) => ({
                  ...f,
                  scopus_author_url: url,
                  // Only fill a blank — never overwrite an ID the user typed.
                  scopus_author_id: derived && !f.scopus_author_id ? derived : f.scopus_author_id,
                }))
              }}
            />
          </Field>

          <Field
            label="Scopus author ID"
            htmlFor="pd-scopus-id"
            hint="Read from the link above when it is left empty. Used to check the article is on your profile."
          >
            <Input
              id="pd-scopus-id"
              className="h-9 font-mono tabular-nums"
              inputMode="numeric"
              placeholder="57200000000"
              value={form.scopus_author_id}
              onChange={(e) => setForm({ ...form, scopus_author_id: e.target.value })}
            />
          </Field>

          <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Held by the research cell</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Ask them to correct anything wrong here before you submit.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(correctionRequest(user))
                    .then(() => toast.success("Correction request copied"))
                    .catch(() => toast.error("Could not copy — select the values manually"))
                }}
              >
                <Copy className="size-3.5" />
                Copy request
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ReadOnlyField label="Email" value={user?.email} />
              <ReadOnlyField label="Department" value={user?.department} manageHint={LOCKED_HINT} />
              <ReadOnlyField label="Staff ID" value={user?.staff_id} mono manageHint={LOCKED_HINT} />
              <ReadOnlyField
                label="Biometric ID"
                value={user?.biometric_id}
                mono
                manageHint={LOCKED_HINT}
              />
            </div>
            {!user?.biometric_id ? (
              <Callout tone="warning" title="Biometric ID is missing">
                A claim cannot be submitted without it — the payment has no account to land in.
              </Callout>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !form.name.trim()} onClick={save}>
            {busy ? "Saving…" : "Save to profile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
