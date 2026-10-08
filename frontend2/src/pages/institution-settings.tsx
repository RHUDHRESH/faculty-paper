import { useEffect, useState } from "react"

import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Field, Input } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { Section } from "@/ui/section"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { toast } from "@/ui/toast"

import { ChangeHistory } from "./admin-b-parts"

/**
 * The institution's own facts, editable by the office.
 *
 * A college's name is data, not code: this screen is where a second college
 * makes the same build theirs, and where the first one corrects a spelling
 * without a redeploy. The fields are the whole whitelist: identity strings
 * the interface shows people. Secrets stay in the environment and the payout
 * rules stay in the versioned policy, because neither belongs to a form.
 */

type Institution = {
  college_name: string
  sign_in_note: string
  support_email: string
}

export function InstitutionSettings() {
  const { data, isLoading, isError, error, refetch } = useApi<Institution>(
    ["institution-admin"],
    "/api/admin/settings"
  )

  const [collegeName, setCollegeName] = useState("")
  const [signInNote, setSignInNote] = useState("")
  const [supportEmail, setSupportEmail] = useState("")

  useEffect(() => {
    if (!data) return
    setCollegeName(data.college_name)
    setSignInNote(data.sign_in_note)
    setSupportEmail(data.support_email)
  }, [data])

  const save = useApiMutation<Institution, Institution>("/api/admin/settings", {
    method: "PUT",
    invalidates: [["institution"], ["institution-admin"], ["history"]],
  })

  const dirty =
    !!data &&
    (collegeName !== data.college_name || signInNote !== data.sign_in_note || supportEmail !== data.support_email)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    save.mutate(
      {
        college_name: collegeName.trim(),
        sign_in_note: signInNote.trim(),
        support_email: supportEmail.trim(),
      },
      {
        onSuccess: () => toast.ok("Saved"),
        onError: (err) => toast.fail(err, "Could not save. Nothing was changed."),
      }
    )
  }

  const header = (
    <PageHeader title="Institution" sub="The college's name and contact details." spot="spot-settings" />
  )

  if (isLoading) {
    return (
      <div className="page space-y-10">
        {header}
        <SkeletonRows rows={4} rowHeight={64} />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="page space-y-10">
        {header}
        {error?.status === 403 ? (
          <ErrorState
            art="closed-gate"
            title="Not open to this account"
            message="The institution's settings belong to the system admins."
          />
        ) : (
          <ErrorState
            title="Could not load the settings"
            message="The server did not answer. Nothing has been lost. Try again."
            onRetry={() => refetch()}
          />
        )}
      </div>
    )
  }

  const shownName = collegeName.trim() || "Your college"

  return (
    <div className="page space-y-10">
      {header}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)]">
        <form onSubmit={onSubmit} className="space-y-5">
          <Field label="College name">
            <Input
              value={collegeName}
              onChange={(e) => setCollegeName(e.target.value)}
              required
              minLength={2}
              maxLength={200}
            />
          </Field>
          <Field label="Sign-in note (optional)" hint="Shown under the name on the sign-in screen.">
            <Input
              value={signInNote}
              onChange={(e) => setSignInNote(e.target.value)}
              maxLength={300}
              placeholder="Passwords are issued by the research office. Call ext. 214 to reset."
            />
          </Field>
          <Field label="Support email (optional)">
            <Input
              type="email"
              value={supportEmail}
              onChange={(e) => setSupportEmail(e.target.value)}
              placeholder="researchcell@college.edu"
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" kind="primary" disabled={!dirty || save.isPending}>
              {save.isPending ? "Saving" : "Save changes"}
            </Button>
            {dirty && <span className="text-sm text-fg-muted">Unsaved changes</span>}
          </div>
        </form>

        <Section title="How the sign-in screen reads">
          <div className="rounded-panel bg-sunken p-6 text-center shadow-well">
            <p className="display text-display">{shownName}</p>
            {signInNote.trim() && <p className="mt-2 text-sm text-fg-muted">{signInNote.trim()}</p>}
            <p className="mt-4 text-sm text-fg-muted">
              {supportEmail.trim() ? `Need help? Write to ${supportEmail.trim()}.` : "No support email is set."}
            </p>
          </div>
        </Section>
      </div>

      <ChangeHistory entity="system_setting" id="institution" />
    </div>
  )
}
