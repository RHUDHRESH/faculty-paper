import { useEffect, useState, type FormEvent, type ReactNode } from "react"

import { useAuth } from "@/app/auth"
import { PasswordDialog } from "@/app/password"
import { ApiError } from "@/lib/api"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input, Textarea } from "@/ui/field"
import { PageTitle, SectionTitle, Sub } from "@/ui/text"
import { ErrorState, InlineError, SkeletonRows, SkeletonText } from "@/ui/state"
import { toast } from "@/ui/toast"

/**
 * The account page at `/me` — who you are, what you can ask to change, and
 * the password.
 *
 * Nothing on a profile is self-service any more (`PATCH /api/auth/profile`
 * refuses everyone but a super admin), and a field that is simply greyed out
 * with no reason reads as a bug and generates a support email. So every
 * identity field carries the sentence that explains it, and the one lever a
 * claimant does have — asking for a correction — has to actually show what
 * came of asking, including a decline and why, or "the research cell owns
 * your profile" is back to meaning "email somebody and hope".
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

type FullMe = {
  id: string
  email: string
  name: string
  role: string
  department: string | null
  employee_id: string | null
  staff_id: string | null
  biometric_id: string | null
  designation: string | null
  scopus_author_url: string | null
  scopus_author_id: string | null
  must_change_password: boolean
  active: boolean
  portal: string
}

type CorrectionStatus = "PENDING" | "APPROVED" | "DECLINED"

type Correction = {
  id: string
  field: string
  label: string
  current_value: string
  proposed_value: string
  note: string
  status: CorrectionStatus
  decision_note: string
  created_at: string | null
  decided_at: string | null
  // The API doc calls this `decided_by_name`; `backend/core/api.py`'s
  // `_request_dict` actually sends the key as `decided_by` — read from the
  // source of truth rather than the doc where the two disagree.
  decided_by: string | null
}

type CorrectableFieldKey =
  | "name"
  | "department"
  | "designation"
  | "staff_id"
  | "biometric_id"
  | "scopus_author_url"
  | "scopus_author_id"

type CorrectableField = { field: CorrectableFieldKey; label: string; identity: boolean }

//  `department` is correctable but, per API.md, deliberately not an identity
//  field — the research cell moves people between departments as routine
//  business, not as a payment-and-attribution decision.
const CORRECTABLE_FIELDS: CorrectableField[] = [
  { field: "name", label: "Full name", identity: true },
  { field: "department", label: "Department", identity: false },
  { field: "designation", label: "Designation", identity: true },
  { field: "staff_id", label: "Staff ID", identity: true },
  { field: "biometric_id", label: "Biometric ID", identity: true },
  { field: "scopus_author_url", label: "Scopus author link", identity: true },
  { field: "scopus_author_id", label: "Scopus author ID", identity: true },
]

function valueFor(me: FullMe, field: CorrectableFieldKey): string {
  return me[field] || ""
}

function formatRole(role: string): string {
  return role
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ")
}

/* ------------------------------------------------------------------------ */
/* Profile                                                                   */
/* ------------------------------------------------------------------------ */

export function Profile() {
  const { me: sessionMe, refresh } = useAuth()
  const meQuery = useApi<FullMe>(["profile", "me"], "/api/auth/me")
  const correctionsQuery = useApi<{ results: Correction[] }>(
    ["profile", "corrections"],
    "/api/auth/profile/corrections"
  )
  const departmentsQuery = useApi<string[]>(["meta", "departments"], "/api/meta/departments")

  const [manualPasswordOpen, setManualPasswordOpen] = useState(false)
  const [correctingField, setCorrectingField] = useState<CorrectableFieldKey | null>(null)

  // The forced path is driven by the session context, not this page's own
  // fetch of `/auth/me` — that context is what the rest of the app already
  // gates on, and reading a second, page-local copy of the same flag is how
  // the two could disagree about whether the dialog should be open.
  const forcedPasswordChange = !!sessionMe?.must_change_password

  if (meQuery.isLoading) {
    return (
      <div className="page space-y-8 py-8">
        <SkeletonText lines={2} className="max-w-xs" />
        <SkeletonRows rows={6} />
      </div>
    )
  }

  if (meQuery.isError || !meQuery.data) {
    return (
      <div className="page py-8">
        <ErrorState onRetry={() => meQuery.refetch()} />
      </div>
    )
  }

  const me = meQuery.data

  const correctionsByField = new Map<string, Correction[]>()
  for (const c of correctionsQuery.data?.results || []) {
    const list = correctionsByField.get(c.field)
    if (list) list.push(c)
    else correctionsByField.set(c.field, [c])
  }

  const departmentOptions: ComboboxOption[] = (departmentsQuery.data || []).map((d) => ({
    value: d,
    label: d,
  }))

  const correctingMeta = CORRECTABLE_FIELDS.find((m) => m.field === correctingField) ?? null
  const correctingPending = correctingField
    ? correctionsByField.get(correctingField)?.find((c) => c.status === "PENDING")
    : undefined

  return (
    <div className="page space-y-10 py-8">
      <header>
        <PageTitle>Your profile</PageTitle>
        <Sub className="mt-1">{me.email}</Sub>
      </header>

      <section className="space-y-4">
        <SectionTitle>Who you are</SectionTitle>

        {correctionsQuery.isError && (
          <InlineError
            message="Could not load your correction requests. Anything already pending may not show here."
            onRetry={() => correctionsQuery.refetch()}
          />
        )}

        <dl className="divide-y divide-line border-y border-line">
          <StaticField label="Email" value={me.email} />
          <StaticField label="Role" value={formatRole(me.role)} />
          {CORRECTABLE_FIELDS.map((meta) => (
            <CorrectableRow
              key={meta.field}
              meta={meta}
              value={valueFor(me, meta.field) || "Not set"}
              corrections={correctionsByField.get(meta.field) || []}
              onAsk={() => setCorrectingField(meta.field)}
            />
          ))}
        </dl>
      </section>

      <section className="space-y-3">
        <SectionTitle>Password</SectionTitle>
        <Sub>
          Issued passwords are 24 random characters handed over on paper — use the eye
          icon if you are not sure you typed the current one correctly.
        </Sub>
        <Button kind="default" onClick={() => setManualPasswordOpen(true)}>
          Change password
        </Button>
      </section>

      <PasswordDialog
        forced={forcedPasswordChange}
        manualOpen={manualPasswordOpen}
        onManualOpenChange={setManualPasswordOpen}
        onSuccess={async () => {
          await refresh()
          void meQuery.refetch()
        }}
      />

      <CorrectionDialog
        field={correctingMeta}
        currentValue={correctingField ? valueFor(me, correctingField) : ""}
        pending={correctingPending}
        departmentOptions={departmentOptions}
        departmentsLoading={departmentsQuery.isLoading}
        departmentsError={departmentsQuery.isError}
        onRetryDepartments={() => departmentsQuery.refetch()}
        onOpenChange={(open) => {
          if (!open) setCorrectingField(null)
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Identity rows                                                            */
/* ------------------------------------------------------------------------ */

/**
 * A label on this page names a field in a list, not a column over a grid of
 * values, so it is sentence case rather than the uppercase column-head style.
 * Seven of these set in caps turn a page about one person into a report.
 */
function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="block text-sm font-medium text-fg-muted">{children}</span>
}

function StaticField({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-4">
      <FieldLabel>{label}</FieldLabel>
      <p className="mt-1 text-base">{value}</p>
    </div>
  )
}

/**
 * One identity or routing field: its value, why it is not typed here, and —
 * the whole point of this screen — whatever came of the last time somebody
 * asked for it to change. A pending request and a declined one read as
 * different sentences on purpose; a claimant who was told no needs to see
 * the reason, not just that the value did not move.
 */
function CorrectableRow({
  meta,
  value,
  corrections,
  onAsk,
}: {
  meta: CorrectableField
  value: string
  corrections: Correction[]
  onAsk: () => void
}) {
  const pending = corrections.find((c) => c.status === "PENDING")
  // Only shown while there is nothing newer in flight — once a fresh ask is
  // pending, the old decision is not the news on this row any more.
  const lastDeclined = !pending ? corrections.find((c) => c.status === "DECLINED") : undefined

  return (
    <div className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <FieldLabel>{meta.label}</FieldLabel>
          <p className="mt-1 text-base">{value}</p>
          <p className="mt-1 max-w-md text-sm text-fg-muted">
            {meta.identity
              ? "Set by the research cell — this decides who gets paid and whose record a paper is checked against."
              : "Routing, not identity, but still set by the research cell rather than typed here."}
          </p>
        </div>
        <Button kind="quiet" size="sm" onClick={onAsk} className="shrink-0">
          {pending ? "Change what you asked for" : "Request a correction"}
        </Button>
      </div>

      {pending && (
        <p className="mt-3 rounded-md bg-accent-wash px-3 py-2 text-sm text-fg">
          <span className="font-medium">Pending —</span> “{pending.current_value || "not set"}”
          {" → "}
          “{pending.proposed_value}”
        </p>
      )}

      {lastDeclined && (
        <div className="mt-3 rounded-md bg-critical-wash px-3 py-2 text-sm text-critical">
          <p className="font-medium">Declined — you asked for “{lastDeclined.proposed_value}”</p>
          <p className="mt-1">{lastDeclined.decision_note || "No reason was recorded."}</p>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Correction dialog                                                        */
/* ------------------------------------------------------------------------ */

/**
 * The one form behind every "Request a correction" / "Change what you asked
 * for" button.
 *
 * The server keeps at most one open request per field and folds a second ask
 * into the first (`POST /auth/profile/correction` updates the existing
 * `PENDING` row rather than queueing a duplicate), so this dialog pre-fills
 * from the pending request when there is one — re-asking has to read as
 * editing what you already asked for, not starting over.
 */
function CorrectionDialog({
  field,
  currentValue,
  pending,
  departmentOptions,
  departmentsLoading,
  departmentsError,
  onRetryDepartments,
  onOpenChange,
}: {
  field: CorrectableField | null
  currentValue: string
  pending?: Correction
  departmentOptions: ComboboxOption[]
  departmentsLoading: boolean
  departmentsError: boolean
  onRetryDepartments: () => void
  onOpenChange: (open: boolean) => void
}) {
  const [proposed, setProposed] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)

  // Every open of this dialog — a different field, or the same field a
  // second time — starts from what is actually pending, not from whatever
  // was left in the boxes the last time it closed.
  useEffect(() => {
    if (field) {
      setProposed(pending?.proposed_value ?? "")
      setNote(pending?.note ?? "")
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field?.field, pending?.id])

  const mutation = useApiMutation<
    { field: string; proposed: string; note?: string },
    { ok: boolean }
  >("/api/auth/profile/correction", { invalidates: [["profile", "corrections"]] })

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!field) return
    setError(null)
    const value = proposed.trim()
    if (!value) {
      setError("Say what it should be.")
      return
    }
    try {
      await mutation.mutateAsync({ field: field.field, proposed: value, note: note.trim() || undefined })
      toast.ok(
        pending
          ? `Changed what you asked for — ${field.label} → “${value}”`
          : `Correction requested — ${field.label} → “${value}”`
      )
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the request")
    }
  }

  return (
    <Dialog open={!!field} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {field && (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>
                {pending ? `Change what you asked for` : `Request a correction`} — {field.label}
              </DialogTitle>
              <DialogDescription>
                Current: “{currentValue || "not set"}”. An admin decides — you will be told
                either way, including if it is declined.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-3.5">
              {field.field === "department" ? (
                departmentsError ? (
                  <InlineError
                    message="Could not load the department list."
                    onRetry={onRetryDepartments}
                  />
                ) : (
                  <Field label="Proposed department">
                    <Combobox
                      value={proposed || null}
                      onChange={setProposed}
                      options={departmentOptions}
                      placeholder={departmentsLoading ? "Loading…" : "Select a department…"}
                      disabled={departmentsLoading}
                    />
                  </Field>
                )
              ) : (
                <Field label={`Proposed ${field.label.toLowerCase()}`}>
                  <Input value={proposed} onChange={(e) => setProposed(e.target.value)} autoFocus />
                </Field>
              )}

              <Field label="Note" hint="Optional — anything that helps the admin decide.">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>

              {error && (
                <p role="alert" className="rounded-md bg-critical-wash px-3 py-2 text-sm text-critical">
                  {error}
                </p>
              )}
            </DialogBody>

            <DialogFooter>
              <Button kind="quiet" type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button kind="primary" type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Sending…" : pending ? "Update request" : "Send request"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
