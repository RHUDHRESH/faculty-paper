import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { PageTitle, Sub } from "@/ui/text"

/**
 * The institution's own facts, editable by the office.
 *
 * A college's name is data, not code: this screen is where a second college
 * makes the same build theirs, and where the first one corrects a spelling
 * without a redeploy. The fields are the whole whitelist — identity strings
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
    invalidates: [["institution"], ["institution-admin"]],
  })

  const dirty =
    !!data &&
    (collegeName !== data.college_name ||
      signInNote !== data.sign_in_note ||
      supportEmail !== data.support_email)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    save.mutate(
      {
        college_name: collegeName.trim(),
        sign_in_note: signInNote.trim(),
        support_email: supportEmail.trim(),
      },
      {
        onSuccess: () => toast.success("Saved", { description: "The college's name is updated everywhere it is shown." }),
        onError: (err) => toast.error("Could not save", { description: err.message }),
      }
    )
  }

  if (isLoading) {
    return (
      <div className="page space-y-6">
        <header>
          <PageTitle>Institution</PageTitle>
        </header>
        <SkeletonRows rows={4} rowHeight={64} />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="page space-y-6">
        <header>
          <PageTitle>Institution</PageTitle>
        </header>
        {error?.status === 403 ? (
          <ErrorState
            art="closed-gate"
            title="Not open to this account"
            message="The institution's settings belong to the system admins."
          />
        ) : (
          <ErrorState
            title="Could not load the settings"
            message="The server did not answer. Nothing has been lost."
            onRetry={() => refetch()}
          />
        )}
      </div>
    )
  }

  return (
    <div className="page max-w-2xl space-y-6">
      <header>
        <PageTitle>Institution</PageTitle>
        <Sub className="mt-1">
          The name and contact details this installation shows people — on the
          sign-in screen, in the sidebar, and in the sentences the filing form
          uses to describe the affiliation rule.
        </Sub>
      </header>

      <form onSubmit={onSubmit} className="space-y-5">
        <label className="block space-y-1.5">
          <span className="block text-sm font-medium">College name</span>
          <Input
            value={collegeName}
            onChange={(e) => setCollegeName(e.target.value)}
            required
            minLength={2}
            maxLength={200}
            className="max-w-md"
          />
          <span className="block text-sm text-fg-muted">
            Appears on the sign-in screen, the sidebar, and every export.
          </span>
        </label>

        <label className="block space-y-1.5">
          <span className="block text-sm font-medium">Sign-in note (optional)</span>
          <Input
            value={signInNote}
            onChange={(e) => setSignInNote(e.target.value)}
            maxLength={300}
            placeholder="e.g. Passwords are issued by the research cell — call ext. 214 to reset"
            className="max-w-md"
          />
          <span className="block text-sm text-fg-muted">
            One sentence under the college name on the sign-in screen, for what
            everybody asks anyway.
          </span>
        </label>

        <label className="block space-y-1.5">
          <span className="block text-sm font-medium">Support email (optional)</span>
          <Input
            type="email"
            value={supportEmail}
            onChange={(e) => setSupportEmail(e.target.value)}
            placeholder="researchcell@college.edu"
            className="max-w-md"
          />
          <span className="block text-sm text-fg-muted">
            Shown where the app says to ask the research cell.
          </span>
        </label>

        <div className="flex items-center gap-3">
          <Button type="submit" kind="primary" disabled={!dirty || save.isPending}>
            Save changes
          </Button>
          {dirty && <span className="text-sm text-fg-muted">Unsaved changes</span>}
        </div>
      </form>
    </div>
  )
}
