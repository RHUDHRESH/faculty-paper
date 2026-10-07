import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Camera, Check, Circle, LoaderCircle, Lock, Plus, X } from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import {
  ASSIGNABLE_ROLES,
  FACULTY_TYPE_LABEL,
  requestValueLabel,
  roleLabel,
} from "@/app/account"
import { can, useAuth } from "@/app/auth"
import { loadGoogleIdentity, type GoogleConfig } from "@/app/google"
import { PasswordDialog } from "@/app/password"
import { api, ApiError } from "@/lib/api"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Link } from "react-router-dom"

import { BadgeStrip } from "@/pages/person-social"
import { Avatar, initialsOf } from "@/ui/person"
import { Field, Input, Textarea } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { ThresholdCard, useMyThreshold } from "@/ui/research-threshold"
import { Details } from "@/ui/section"
import { money } from "@/ui/paper"
import { ScopusProfileCard, type ScopusProfile } from "@/ui/scopus"
import { Meta, SectionTitle, Sub } from "@/ui/text"
import {
  Callout,
  ErrorState,
  InlineError,
  SkeletonRows,
  SkeletonText,
} from "@/ui/state"
import { toast } from "@/ui/toast"

/**
 * The account page at `/me`, in the product owner's terms: every account has
 * an email and a password; Google can be linked for sign-in; some details you
 * change yourself, and the rest go to the research office as a request.
 *
 * So the page has two kinds of detail and says which is which. The few that
 * are nobody's business but the person's own (a phone number, the domains
 * they work in) are plain inputs that save straight away. Everything that
 * decides who gets paid or whose record a paper is checked against is shown
 * locked, with a "Request a change" on each line — and the request has to
 * show what came of it, including a decline and why, or "the research office
 * keeps it" is back to meaning "email somebody and hope".
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

/** Which Google account signs in to this one — `/auth/me` carries it only
 *  for the person themselves. */
type GoogleLink = { email: string | null; linked_at: string | null }

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
  // Set only by a super admin, never by a claimant and never by the research
  // cell — being marked research faculty with a quota of four means four
  // papers a year are paid nothing.
  faculty_type: string | null
  research_quota: number | null
  research_quota_note: string | null
  must_change_password: boolean
  active: boolean
  portal: string
  phone: string | null
  orcid_id?: string | null
  google: GoogleLink | null
}

type RequestStatus = "PENDING" | "APPROVED" | "DECLINED"

type ChangeRequest = {
  id: string
  field: string
  label: string
  current_value: string
  proposed_value: string
  note: string
  status: RequestStatus
  decision_note: string
  created_at: string | null
  decided_at: string | null
  // `_request_dict` sends the approver's name under `decided_by`.
  decided_by: string | null
}

type RequestableKey =
  | "name"
  | "department"
  | "designation"
  | "staff_id"
  | "biometric_id"
  | "scopus_author_url"
  | "scopus_author_id"
  | "role"
  | "faculty_type"

//  `phrase` is the label as it reads mid-sentence: "Proposed staff ID", not
//  "Proposed staff id", and never "scopus".
type Requestable = { field: RequestableKey; label: string; phrase: string }

//  Exactly the keys `REQUESTABLE` accepts in `backend/core/api/auth.py`;
//  anything else posted to `/auth/profile/correction` is a 400, so a line
//  that offered the button for one would be a dead control.
const REQUESTABLE: Record<RequestableKey, Requestable> = {
  name: { field: "name", label: "Full name", phrase: "full name" },
  department: { field: "department", label: "Department", phrase: "department" },
  designation: { field: "designation", label: "Designation", phrase: "designation" },
  staff_id: { field: "staff_id", label: "Staff ID", phrase: "staff ID" },
  biometric_id: { field: "biometric_id", label: "Biometric ID", phrase: "biometric ID" },
  scopus_author_url: {
    field: "scopus_author_url",
    label: "Scopus author link",
    phrase: "Scopus author link",
  },
  scopus_author_id: {
    field: "scopus_author_id",
    label: "Scopus author ID",
    phrase: "Scopus author ID",
  },
  role: { field: "role", label: "Role", phrase: "role" },
  faculty_type: { field: "faculty_type", label: "Faculty type", phrase: "faculty type" },
}

function valueFor(me: FullMe, field: RequestableKey): string {
  const value = me[field]
  return value == null ? "" : String(value)
}

/** The profile fields a claim is checked against, by the label shown below. */
function missingForClaims(me: FullMe): string[] {
  const out: string[] = []
  if (!me.staff_id) out.push("Staff ID")
  if (!me.department) out.push("Department")
  if (!me.scopus_author_id && !me.scopus_author_url) out.push("Scopus author profile")
  return out
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

/* ------------------------------------------------------------------------ */
/* Profile                                                                   */
/* ------------------------------------------------------------------------ */

export function Profile() {
  const { me: sessionMe, refresh } = useAuth()
  const meQuery = useApi<FullMe>(["profile", "me"], "/api/auth/me")
  const requestsQuery = useApi<{ results: ChangeRequest[] }>(
    ["profile", "corrections"],
    "/api/auth/profile/corrections"
  )
  const departmentsQuery = useApi<string[]>(["meta", "departments"], "/api/meta/departments")

  // Two things decide whether a personal record can be shown at all, and both
  // are read before the early returns below so the hook order never changes.
  //
  // Everybody who files their own papers has a record here: faculty, a head,
  // and an officer who is an academic too. `mine=1` because for an oversight
  // role `/claims/counts` is otherwise the whole college, which would be the
  // college's total wearing a heading that says "yours"; the money is the
  // ledger's `/me/payments`, which is only ever the viewer's own.
  const filesOwnPapers = can(sessionMe?.role).fileOwnPapers
  // The one rule that is not a matter of taste: a head is shown no figure on
  // this page, their own included, so the request is not even made.
  const seeMoney = can(sessionMe?.role).seeMoney
  const threshold = useMyThreshold()

  const [manualPasswordOpen, setManualPasswordOpen] = useState(false)
  const [asking, setAsking] = useState<RequestableKey | null>(null)

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
        <ErrorState
          title="Could not load your account"
          message="The server did not answer. Your details are unchanged and nothing has been lost."
          onRetry={() => meQuery.refetch()}
        />
      </div>
    )
  }

  const me = meQuery.data

  const requestsByField = new Map<string, ChangeRequest[]>()
  for (const r of requestsQuery.data?.results || []) {
    const list = requestsByField.get(r.field)
    if (list) list.push(r)
    else requestsByField.set(r.field, [r])
  }

  const pendingCount = (requestsQuery.data?.results || []).filter(
    (r) => r.status === "PENDING"
  ).length

  const departmentOptions: ComboboxOption[] = (departmentsQuery.data || []).map((d) => ({
    value: d,
    label: d,
  }))

  const askingMeta = asking ? REQUESTABLE[asking] : null
  const askingPending = asking
    ? requestsByField.get(asking)?.find((r) => r.status === "PENDING")
    : undefined

  // "Research Cell · Research cell": a designation that is the role's own name says it twice.
  const headline = [me.designation, me.department, roleLabel(me.role)]
    .filter((v, i, all): v is string => !!v && all.findIndex((x) => x?.toLowerCase() === v.toLowerCase()) === i)
    .join(" · ")
  const missing = missingForClaims(me)

  function requestable(key: RequestableKey, extra: { note?: string; after?: ReactNode } = {}) {
    return (
      <DetailRow
        field={key}
        label={REQUESTABLE[key].label}
        value={requestValueLabel(key, valueFor(me, key)) || "Not set"}
        note={extra.note}
        after={extra.after}
        requests={requestsByField.get(key) || []}
        onAsk={() => setAsking(key)}
      />
    )
  }

  const officeDetails = ["biometric_id", "role", "faculty_type", "scopus_author_url"] as const
  // A request in flight or turned down on a folded detail is news: keep it open.
  const officeOpen = officeDetails.some((k) => requestsByField.get(k)?.some((r) => r.status !== "APPROVED"))

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Your profile"
        sub="Your photo, IDs and password."
        action={
          <Button kind="default" asChild>
            <Link to="/u/me">See your public profile</Link>
          </Button>
        }
      >
        <PhotoRow name={me.name} email={me.email} summary={headline} photoUrl={sessionMe?.photo_url ?? null} />
      </PageHeader>

      {filesOwnPapers && (
        <Readiness
          hasPhoto={!!sessionMe?.photo_url}
          hasScopusId={!!me.scopus_author_id}
          hasPhone={!!me.phone}
          hasOrcid={!!me.orcid_id}
        />
      )}

      {filesOwnPapers && missing.length > 0 && (
        <Callout tone="caution" title="Your profile is missing what a claim needs">
          {missing.join(", ")} {missing.length === 1 ? "is" : "are"} not set. A claim is
          checked against these, so ask for {missing.length === 1 ? "it" : "them"} to be
          filled in below before you file.
        </Callout>
      )}

      {!me.active && (
        <Callout tone="critical" title="This account is deactivated">
          You can still read your own record, but you cannot file anything. The research
          office reactivates an account; asking here will not.
        </Callout>
      )}

      {/* ---- details you can change -------------------------------------- */}

      <section className="space-y-6">
        <div>
          <SectionTitle>Details you can change</SectionTitle>
        </div>
        <YourDetails phone={me.phone} orcid={me.orcid_id ?? null} />
        <Interests />
      </section>

      {/* ---- details the research office keeps --------------------------- */}

      <section className="space-y-4">
        <div>
          <SectionTitle>Details the research office keeps</SectionTitle>
          <Sub className="mt-1">Ask for a change and the research office decides. You are told either way.</Sub>
        </div>

        {requestsQuery.isError && (
          <InlineError
            message="Could not load your requests. Anything already pending may not show here."
            onRetry={() => requestsQuery.refetch()}
          />
        )}

        {pendingCount > 0 && (
          <Meta className="block">
            {pendingCount} {plural(pendingCount, "request is", "requests are")} with the
            research office.
          </Meta>
        )}

        <dl className="divide-y divide-line border-y border-line">
          {requestable("name")}
          {requestable("staff_id")}
          {requestable("scopus_author_id", {
            after: me.scopus_author_id ? (
              <a
                href={`https://www.scopus.com/authid/detail.uri?authorId=${encodeURIComponent(me.scopus_author_id)}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block text-sm text-accent hover:underline"
              >
                Open your Scopus author page
              </a>
            ) : undefined,
          })}
          {requestable("department")}
          {requestable("designation")}
          {me.faculty_type === "RESEARCH" && seeMoney && (
            <DetailRow
              label="Research threshold"
              value={
                threshold.data?.threshold != null
                  ? `${money(threshold.data.threshold)} a year`
                  : threshold.data?.needs_rupee_threshold
                    ? "Not set yet. The old papers-a-year rule no longer applies."
                    : "Not set yet"
              }
              note="Set by the research coordinator. Ask the research office if it looks wrong."
              after={<ThresholdCard s={threshold.data} link={false} className="mt-2 max-w-md" />}
            />
          )}
        </dl>

        <Details label="more details" count={officeDetails.length + 2} defaultOpen={officeOpen}>
          <dl className="divide-y divide-line border-y border-line">
            <DetailRow
              label="Email"
              value={me.email}
              note="Your sign-in, and where every decision on a paper is sent. To change it, ask the research office."
            />
            {requestable("biometric_id")}
            <DetailRow
              label="Employee ID"
              value={me.employee_id || "Not set"}
              note="Comes off the ERP roster, not this system. A wrong one is fixed in the ERP and re-imported, so there is no request for it here."
            />
            {requestable("role", {
              note: "Decides which screens you have. A super admin decides a request to change it.",
            })}
            {requestable("faculty_type", {
              note: "Regular or research faculty. It changes how much a paper pays, so the college administrator sets it.",
            })}
            {requestable("scopus_author_url")}
          </dl>
        </Details>
      </section>

      {/* ---- sign-in methods --------------------------------------------- */}

      <section className="space-y-4">
        <div>
          <SectionTitle>Sign-in methods</SectionTitle>
        </div>

        <dl className="divide-y divide-line border-y border-line">
          <div data-detail className="py-4">
            <dt className="text-sm font-medium text-fg-muted">Email and password</dt>
            <dd className="mt-1">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base break-words">{me.email}</p>

                </div>
                <Button
                  kind="default"
                  size="sm"
                  onClick={() => setManualPasswordOpen(true)}
                  className="shrink-0"
                >
                  Change password
                </Button>
              </div>
              {me.must_change_password && (
                <Callout tone="caution" title="You are still on the issued password" className="mt-3">
                  It was handed over on paper and more than one person has seen it. Change it
                  before you file anything.
                </Callout>
              )}
            </dd>
          </div>
          <GoogleRow link={me.google} email={me.email} />
        </dl>
      </section>

      {/* ---- scopus -------------------------------------------------------- */}

      {filesOwnPapers && <ScopusSection />}

      {/* What colleagues see of you, last: it is not what this page is for.
          The yearly target lives on My research, where the pace is. */}
      <BadgeStrip userId={me.id} own />

      <PasswordDialog
        forced={forcedPasswordChange}
        manualOpen={manualPasswordOpen}
        onManualOpenChange={setManualPasswordOpen}
        onSuccess={async () => {
          await refresh()
          void meQuery.refetch()
        }}
      />

      <RequestDialog
        field={askingMeta}
        currentValue={asking ? valueFor(me, asking) : ""}
        pending={askingPending}
        departmentOptions={departmentOptions}
        departmentsLoading={departmentsQuery.isLoading}
        departmentsError={departmentsQuery.isError}
        onRetryDepartments={() => departmentsQuery.refetch()}
        onOpenChange={(open) => {
          if (!open) setAsking(null)
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Details you can change                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The phone number and the ORCID iD, in one form with one Save.
 *
 * They go through `PATCH /auth/profile/self`, the one route a person writes
 * their own account through, and only the fields that changed are sent. The
 * server's refusal is shown word for word beside the field it is about
 * ("that does not look like a phone number, for example +91 98400 12345"); a
 * refusal for either means nothing was saved, and it says so.
 */
function YourDetails({ phone, orcid }: { phone: string | null; orcid: string | null }) {
  const savedPhone = phone ?? ""
  const savedOrcid = orcid ?? ""
  const [phoneValue, setPhoneValue] = useState(savedPhone)
  const [orcidValue, setOrcidValue] = useState(savedOrcid)
  const [error, setError] = useState<{ field: "phone" | "orcid" | "both"; message: string } | null>(null)
  const phoneId = useId()
  const orcidId = useId()

  // After a save the page refetches `/auth/me`; the boxes follow what the
  // server now holds (it tidies spacing) rather than what was typed.
  useEffect(() => setPhoneValue(savedPhone), [savedPhone])
  useEffect(() => setOrcidValue(savedOrcid), [savedOrcid])

  const save = useApiMutation<
    { phone?: string; orcid_id?: string },
    { phone: string | null; orcid_id: string | null }
  >("/api/auth/profile/self", { method: "PATCH", invalidates: [["profile", "me"]] })
  const phoneDirty = phoneValue.trim() !== savedPhone
  const orcidDirty = orcidValue.trim() !== savedOrcid

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const body: { phone?: string; orcid_id?: string } = {}
    if (phoneDirty) body.phone = phoneValue.trim()
    if (orcidDirty) body.orcid_id = orcidValue.trim()
    save.mutate(body, {
      onSuccess: (data) => {
        setPhoneValue(data.phone ?? "")
        setOrcidValue(data.orcid_id ?? "")
        toast.ok(
          body.orcid_id && data.orcid_id
            ? "Saved. Papers carrying your ORCID iD will be matched to you"
            : "Details saved"
        )
      },
      onError: (err) => {
        const only = phoneDirty && !orcidDirty ? "phone" : orcidDirty && !phoneDirty ? "orcid" : "both"
        setError({ field: only, message: err.message })
      },
    })
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={phoneId} className="block text-sm font-medium">
            Phone
          </label>
          <Input
            id={phoneId}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phoneValue}
            onChange={(e) => {
              setPhoneValue(e.target.value)
              setError(null)
            }}
            placeholder="+91 98400 12345"
            aria-describedby={`${phoneId}-help`}
            aria-invalid={error?.field === "phone" ? true : undefined}
          />
          {error?.field === "phone" ? (
            <p id={`${phoneId}-help`} role="alert" className="text-xs text-critical">
              {error.message}
            </p>
          ) : (
            <p id={`${phoneId}-help`} className="text-xs text-fg-muted">
              Optional. The research office uses it to reach you about a paper.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={orcidId} className="block text-sm font-medium">
            ORCID iD
          </label>
          <Input
            id={orcidId}
            value={orcidValue}
            onChange={(e) => {
              setOrcidValue(e.target.value)
              setError(null)
            }}
            placeholder="0000-0002-1825-0097"
            aria-describedby={`${orcidId}-help`}
            aria-invalid={error?.field === "orcid" ? true : undefined}
          />
          {error?.field === "orcid" ? (
            <p id={`${orcidId}-help`} role="alert" className="text-xs text-critical">
              {error.message}
            </p>
          ) : (
            <p id={`${orcidId}-help`} className="text-xs text-fg-muted">
              Optional. Paste the iD or the orcid.org link; papers carrying it are matched to you.
            </p>
          )}
        </div>
      </div>
      {error?.field === "both" && (
        <p role="alert" className="text-sm text-critical">
          Nothing was saved. {error.message}
        </p>
      )}
      <Button kind="primary" type="submit" disabled={(!phoneDirty && !orcidDirty) || save.isPending}>
        {save.isPending && <LoaderCircle className="animate-spin" />}
        {save.isPending ? "Saving…" : "Save details"}
      </Button>
    </form>
  )
}

/**
 * What would make the record easy to match, said as one sentence: a face, the
 * Scopus ID the office holds, a phone, an ORCID iD. Not a score and not a
 * nag: a thing that is missing is a plain "add" the person can act on below.
 * The areas they work on are counted from the same list Discover writes.
 */
function Readiness({
  hasPhoto,
  hasScopusId,
  hasPhone,
  hasOrcid,
}: {
  hasPhoto: boolean
  hasScopusId: boolean
  hasPhone: boolean
  hasOrcid: boolean
}) {
  const interests = useApi<{ domains: string[] }>(["me", "interests"], "/api/me/interests")
  const items = [
    { key: "photo", label: "A photo", done: hasPhoto },
    { key: "scopus", label: "Your Scopus ID", done: hasScopusId },
    { key: "phone", label: "A phone number", done: hasPhone },
    { key: "orcid", label: "An ORCID iD", done: hasOrcid },
    ...(interests.data ? [{ key: "areas", label: "Your research areas", done: interests.data.domains.length > 0 }] : []),
  ]
  const left = items.filter((i) => !i.done)
  return (
    <section aria-label="How complete your profile is" className="space-y-3" data-testid="profile-readiness">
      <p className="max-w-prose text-base text-fg">
        {left.length === 0
          ? "Your profile is complete. Every paper that carries your name or your ORCID iD is matched to you."
          : `${items.length - left.length} of ${items.length} are set. Add ${left.length === 1 ? "this" : "these"} and your papers are matched to you without anybody having to ask.`}
      </p>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {items.map((i) => (
          <li key={i.key} className={i.done ? "text-fg-muted" : "font-medium text-fg"}>
            {i.done ? (
              <Check aria-hidden className="mr-1 inline size-4 -translate-y-px text-positive" />
            ) : (
              <Circle aria-hidden className="mr-1 inline size-4 -translate-y-px text-fg-subtle" />
            )}
            {i.label}
            <span className="sr-only">{i.done ? ", set" : ", not set yet"}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Details the research office keeps                                        */
/* ------------------------------------------------------------------------ */

/**
 * One detail the research office keeps: its value, why it is not typed here,
 * and — the whole point of this screen — whatever came of the last time
 * somebody asked for it to change. A pending request and a declined one read
 * as different sentences on purpose; a claimant who was told no needs to see
 * the reason, not just that the value did not move.
 *
 * Without `field` it is a detail with no request behind it (the email, the
 * ERP employee number), and `note` is then not decoration: a value the reader
 * cannot change and cannot ask about has to say where it does come from, or
 * the only move left is a support email asking exactly that.
 */
function DetailRow({
  field,
  label,
  value,
  note,
  after,
  requests = [],
  onAsk,
}: {
  field?: RequestableKey
  label: string
  value: string
  note?: string
  after?: ReactNode
  requests?: ChangeRequest[]
  onAsk?: () => void
}) {
  const pending = requests.find((r) => r.status === "PENDING")
  // Only shown while there is nothing newer in flight — once a fresh ask is
  // pending, the old decision is not the news on this line any more.
  const lastDeclined = !pending ? requests.find((r) => r.status === "DECLINED") : undefined
  const shown = (v: string) => (field ? requestValueLabel(field, v) : v)

  return (
    // Label at the left, value in the middle, the one action at the right: a
    // stacked row ten times over made this list two screens tall.
    <div data-detail className="py-3 sm:grid sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-x-4 sm:py-4">
      <dt className="flex items-center gap-1.5 text-sm font-medium text-fg-muted sm:pt-0.5">
        <Lock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        {label}
      </dt>
      <dd className="mt-1 sm:mt-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {value.startsWith("http://") || value.startsWith("https://") ? (
              <a
                href={value}
                target="_blank"
                rel="noreferrer"
                className="block break-all text-base text-accent hover:underline"
              >
                {value}
              </a>
            ) : (
              <p className="text-base break-words">{value}</p>
            )}
            {note && <p className="mt-1 max-w-md text-sm text-fg-muted">{note}</p>}
            {after}
          </div>
          {onAsk && (
            <Button
              kind="default"
              size="sm"
              onClick={onAsk}
              className="shrink-0"
              aria-label={`${pending ? "Change your request" : "Request a change"} to ${field ? REQUESTABLE[field].phrase : label}`}
            >
              {pending ? "Change your request" : "Request a change"}
            </Button>
          )}
        </div>

        {pending && (
          <p className="mt-3 rounded-md bg-accent-wash px-3 py-2 text-sm text-fg">
            <span className="font-medium">Pending</span>
            {pending.created_at ? ` since ${formatDate(pending.created_at)}` : ""}. From “
            {shown(pending.current_value) || "not set"}” to “{shown(pending.proposed_value)}”.
          </p>
        )}

        {lastDeclined && (
          <div className="mt-3 rounded-md bg-critical-wash px-3 py-2 text-sm text-critical">
            <p className="font-medium">
              Not accepted. You asked for “{shown(lastDeclined.proposed_value)}”
            </p>
            <p className="mt-1">{lastDeclined.decision_note || "No reason was recorded."}</p>
          </div>
        )}
      </dd>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Sign-in methods — Google                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Linking a Google account, so it can sign in to this one.
 *
 * The button is Google's own: an ID token only comes back from Google's
 * rendered button, so "Link Google account" opens a small panel holding it
 * rather than being a button that pretends to be one. No domain hint is sent
 * to Google — the point of linking is that the fourteen staff with only a
 * personal Gmail can choose it, and the server allows that because this
 * session was opened with the account's own password.
 *
 * With Google sign-in off on the server the line says so, instead of drawing
 * a button that renders, is pressed, and does nothing.
 */
function GoogleRow({ link, email }: { link: GoogleLink | null; email: string }) {
  const config = useApi<GoogleConfig>(["auth", "google-config"], "/api/auth/google/config")
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unlinkOpen, setUnlinkOpen] = useState(false)
  // Google's button arrives a beat after the panel opens (its script, then
  // its own request); an empty box in between reads as broken.
  const [drawn, setDrawn] = useState(false)
  const slot = useRef<HTMLDivElement>(null)

  const linkMutation = useApiMutation<{ credential: string }, { google: GoogleLink | null }>(
    "/api/auth/google/link",
    { invalidates: [["profile", "me"]] }
  )
  const unlink = useApiMutation<void, { google: null }>("/api/auth/google/link", {
    method: "DELETE",
    invalidates: [["profile", "me"]],
  })
  const { mutate: linkWith } = linkMutation
  const clientId = config.data?.client_id

  useEffect(() => {
    if (!picking || !clientId) return
    let live = true
    setDrawn(false)
    loadGoogleIdentity()
      .then((google) => {
        if (!live || !slot.current) return
        google.accounts.id.initialize({
          client_id: clientId,
          callback: ({ credential }) => {
            setError(null)
            linkWith(
              { credential },
              {
                onSuccess: (data) => {
                  setPicking(false)
                  toast.ok(
                    `Google linked. ${data.google?.email || "That account"} can now sign you in`
                  )
                },
                onError: (err) => setError(err.message),
              }
            )
          },
        })
        slot.current.replaceChildren()
        google.accounts.id.renderButton(slot.current, {
          theme: "outline",
          size: "large",
          width: 280,
          text: "continue_with",
        })
        setDrawn(true)
      })
      .catch(() => {
        if (live) {
          setError(
            "Google's sign-in did not load, so nothing can be linked right now. Try again in a moment."
          )
        }
      })
    return () => {
      live = false
    }
  }, [picking, clientId, linkWith])

  // Switched off here and nothing linked: there is nothing to do and nothing
  // to explain, so the row is not drawn (a line saying "not available" is a
  // sentence about the server, to a person who came to fix their own details).
  if (!link && config.data && !config.data.enabled) return null

  let body: ReactNode
  if (link) {
    body = (
      <>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base break-words">
              Linked to {link.email || "a Google account"}
              {link.linked_at ? ` since ${formatDate(link.linked_at)}` : ""}
            </p>
            <p className="mt-1 max-w-md text-sm text-fg-muted">
              {config.data && !config.data.enabled
                ? "Google sign-in is switched off on this server, so the link does nothing until it is back on."
                : "Either that Google account or your password signs you in. Unlinking leaves your password as it is."}
            </p>
          </div>
          <Button kind="quiet" size="sm" onClick={() => setUnlinkOpen(true)} className="shrink-0">
            Unlink
          </Button>
        </div>
        <ConfirmDialog
          open={unlinkOpen}
          onOpenChange={setUnlinkOpen}
          title="Unlink this Google account?"
          description={`${link.email || "It"} will no longer sign you in. Your email and password keep working.`}
          confirmLabel="Unlink"
          danger
          onConfirm={async () => {
            try {
              await unlink.mutateAsync(undefined)
              toast.ok("Google account unlinked")
            } catch (err) {
              toast.fail(err)
              // Re-thrown so the dialog stays open on a request that failed.
              throw err
            }
          }}
        />
      </>
    )
  } else if (config.isLoading) {
    body = <SkeletonRows rows={1} rowHeight={20} className="max-w-48" />
  } else if (config.isError) {
    body = (
      <InlineError
        message="Could not check whether Google sign-in is on here. Your password still works."
        onRetry={() => config.refetch()}
      />
    )
  } else if (!config.data?.enabled) {
    body = (
      <p className="text-base text-fg-muted">Google sign-in is not available on this server.</p>
    )
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base">Not linked</p>
            <p className="mt-1 max-w-md text-sm text-fg-muted">
              If {email} is a Google account, “Continue with Google” on the sign-in
              page already works and links it the first time. To use a different Google
              account, link it here. A personal Gmail is fine.
            </p>
          </div>
          {!picking && (
            <Button
              kind="default"
              size="sm"
              onClick={() => {
                setError(null)
                setPicking(true)
              }}
              className="shrink-0"
            >
              Link Google account
            </Button>
          )}
        </div>
        {picking && (
          <div className="well mt-3 space-y-3 p-3">
            <p className="text-sm">Choose the Google account that should sign you in.</p>
            {/* Google draws its own button in here. */}
            <div ref={slot} className="min-h-10" />
            {!drawn && !error && <Meta className="block">Loading Google's sign-in…</Meta>}
            <div className="flex items-center gap-3">
              <Button kind="quiet" size="sm" onClick={() => setPicking(false)}>
                Cancel
              </Button>
              {linkMutation.isPending && <Meta>Linking…</Meta>}
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <div data-detail className="py-4">
      <dt className="text-sm font-medium text-fg-muted">Google</dt>
      <dd className="mt-1">
        {body}
        {error && (
          <p role="alert" className="mt-3 rounded-md bg-critical-wash px-3 py-2 text-sm text-critical">
            {error}
          </p>
        )}
      </dd>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The photo                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The face, with the words to change it. A photo used to be addable only from
 * the public profile's edit dialog, so the person who opened "Your profile" to
 * fix how they appear had no photo control on it and the college saw initials.
 * Same endpoint as that dialog.
 */
function PhotoRow({
  name,
  email,
  summary,
  photoUrl,
}: {
  name: string
  email: string
  summary: string
  photoUrl: string | null
}) {
  const qc = useQueryClient()
  const { refresh } = useAuth()
  const input = useRef<HTMLInputElement>(null)
  const photo = useMutation<{ photo_url: string | null }, ApiError, File | null>({
    mutationFn: (file) => {
      if (!file) return api("/api/people/me/photo", { method: "DELETE" })
      const form = new FormData()
      form.set("file", file)
      // Multipart: the cast `api()` needs for a FormData body (file-paper.tsx).
      return api("/api/people/me/photo", { method: "POST", body: form } as unknown as Parameters<typeof api>[1])
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["person"] })
      void qc.invalidateQueries({ queryKey: ["faculty-record"] })
      void refresh()
      toast.ok(r.photo_url ? "Photo updated." : "Photo removed.")
    },
    onError: (err) => toast.fail(err),
  })
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
      <Avatar person={{ name, initials: initialsOf(name), photo_url: photoUrl }} size="xl" className="size-20 shrink-0 text-2xl" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-lg font-semibold text-fg break-words">{name}</p>
        <p className="text-sm text-fg-muted break-words">{email}</p>
        {summary && <p className="text-sm text-fg-muted">{summary}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            data-testid="photo-input"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ""
              if (f) photo.mutate(f)
            }}
          />
          <Button size="sm" onClick={() => input.current?.click()} disabled={photo.isPending}>
            <Camera />
            {photo.isPending ? "Uploading…" : photoUrl ? "Change photo" : "Add a photo"}
          </Button>
          {photoUrl && (
            <Button kind="quiet" size="sm" onClick={() => photo.mutate(null)} disabled={photo.isPending}>
              Remove photo
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Research interests                                                       */
/* ------------------------------------------------------------------------ */

const MAX_INTERESTS = 20

/**
 * What Scopus held for this person when the office last imported the profile
 * workbook. Its own query and its own failure: a Scopus hiccup must not take
 * the rest of the profile down with it.
 */
function ScopusSection() {
  const q = useApi<{ scopus_ids: string[]; profile: ScopusProfile | null }>(
    ["profile", "scopus"],
    "/api/me/scopus"
  )
  const ids = q.data?.scopus_ids ?? []
  return (
    <section className="space-y-4" aria-labelledby="your-scopus">
      <div>
        <SectionTitle>
          <span id="your-scopus">Your Scopus profile</span>
        </SectionTitle>
        <Sub className="mt-1">As Scopus had it when the research office last imported it.</Sub>
      </div>
      {q.isLoading ? (
        <SkeletonText lines={2} className="max-w-sm" />
      ) : q.isError ? (
        <InlineError
          message="Could not load your Scopus profile. Nothing else on this page is affected."
          onRetry={() => q.refetch()}
        />
      ) : (
        <ScopusProfileCard
          profile={q.data?.profile}
          emptyMessage={
            ids.length
              ? `Nothing has been loaded from Scopus for ID ${ids.join(", ")} yet. Your papers are still matched by that ID.`
              : "Your account carries no Scopus ID, so no profile can be matched to it. Ask for the Scopus author ID above to be set."
          }
        />
      )}
    </section>
  )
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

/**
 * The domains you say you work in — the same `/api/me/interests` set the
 * Discover screen writes, offered here because this is the page somebody
 * opens when they want to correct what the college thinks about them, and
 * sending them to a suggestions screen to fix it is a detour nobody makes.
 *
 * A `Combobox` over the server's own vocabulary rather than a text box: a
 * domain outside that list can never be matched against a colleague or a
 * venue later, so a free-typed one is silently worth nothing.
 */
export function Interests() {
  const interests = useApi<{ domains: string[] }>(["me", "interests"], "/api/me/interests")
  const domains = useApi<{ domains: string[] }>(
    ["research-domains"],
    "/api/meta/research-domains?limit=302"
  )

  const [selected, setSelected] = useState<string[] | null>(null)
  useEffect(() => {
    if (interests.data && selected === null) setSelected(interests.data.domains)
  }, [interests.data, selected])

  const current = selected ?? []
  const dirty = interests.data ? !sameSet(current, interests.data.domains) : false

  const save = useApiMutation<{ domains: string[] }, { domains: string[] }>("/api/me/interests", {
    method: "PUT",
    invalidates: [["me", "interests"]],
  })

  // What your own papers are about, offered while nothing is chosen: an
  // empty "what you work on" matched nobody, though the record knew.
  const research = useApi<{ topics: { id: string; label: string }[] }>(["research", "me"], "/api/me/research", {
    enabled: !!interests.data && interests.data.domains.length === 0,
    retry: false,
  })
  const fromPapers = (research.data?.topics ?? [])
    .map((t) => t.label)
    .filter((t) => !current.includes(t))
    .slice(0, 8)

  function persist(next: string[] = current) {
    save.mutate(
      { domains: next },
      {
        onSuccess: (data) => {
          setSelected(data.domains)
          toast.ok(`Saved. ${data.domains.length} ${plural(data.domains.length, "domain", "domains")}`)
        },
        onError: (err) => toast.fail(err),
      }
    )
  }

  const options: ComboboxOption[] = (domains.data?.domains ?? [])
    .filter((d) => !current.includes(d))
    .map((d) => ({ value: d, label: d }))

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">What you work on</h3>
        <p className="mt-0.5 text-xs text-fg-muted">
          Decides who you are matched with and what gets suggested to you. Up to{" "}
          {MAX_INTERESTS}.
        </p>
      </div>

      {interests.isLoading ? (
        <SkeletonRows rows={2} rowHeight={32} />
      ) : interests.isError ? (
        <ErrorState
          title="Could not load your domains"
          message="The server did not answer. Any domains you have chosen are still saved. Try again."
          onRetry={() => interests.refetch()}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {current.length === 0 && (
              <Meta>No domains chosen yet. Nothing will be matched to you until there are.</Meta>
            )}
            {current.map((d) => (
              <span
                key={d}
                className="inline-flex max-w-full items-center gap-1 rounded-sm bg-accent-wash py-1 pl-2.5 pr-1.5 text-sm text-accent"
              >
                <span className="truncate">{d}</span>
                <button
                  type="button"
                  onClick={() => setSelected(current.filter((x) => x !== d))}
                  aria-label={`Remove ${d}`}
                  className="shrink-0 rounded-sm p-0.5 hover:bg-accent-line"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </span>
            ))}
          </div>

          {current.length === 0 && fromPapers.length > 0 && (
            <div className="space-y-2" role="group" aria-label="From your papers">
              <p className="text-sm text-fg-muted">From your papers:</p>
              <div className="flex flex-wrap gap-2">
                {fromPapers.map((t) => (
                  <button
                    key={t}
                    type="button"
                    disabled={save.isPending}
                    onClick={() => persist([...current, t])}
                    aria-label={`Add ${t}`}
                    className="inline-flex max-w-full items-center gap-1 rounded-sm bg-surface py-1 pl-1.5 pr-2.5 text-sm text-fg shadow-[inset_0_0_0_1px_var(--color-control-edge)] hover:bg-accent-wash hover:text-accent"
                  >
                    <Plus className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{t}</span>
                  </button>
                ))}
                <Button size="sm" disabled={save.isPending} onClick={() => persist(fromPapers)}>
                  Add all
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Combobox
              value={null}
              onChange={(v) => setSelected([...current, v])}
              options={options}
              placeholder={
                domains.isLoading
                  ? "Loading…"
                  : current.length >= MAX_INTERESTS
                    ? `${MAX_INTERESTS} chosen. Remove one to add another`
                    : "Add a domain…"
              }
              disabled={domains.isLoading || domains.isError || current.length >= MAX_INTERESTS}
              aria-label="Add a domain"
              className="w-full max-w-xs"
            />
            <Button kind="primary" size="sm" onClick={() => persist()} disabled={!dirty || save.isPending}>
              {save.isPending && <LoaderCircle className="animate-spin" />}
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>

          {domains.isError && (
            <InlineError
              message="Could not load the domain list, so nothing new can be added right now."
              onRetry={() => domains.refetch()}
            />
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Request dialog                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The one form behind every "Request a change" / "Change your request"
 * button.
 *
 * The server keeps at most one open request per field and folds a second ask
 * into the first (`POST /auth/profile/correction` updates the existing
 * `PENDING` row rather than queueing a duplicate), so this dialog pre-fills
 * from the pending request when there is one — re-asking has to read as
 * editing what you already asked for, not starting over.
 *
 * A department, a role and a faculty type are picked from a list rather than
 * typed: each is a code on the server, and a typed "Head of Dept." is a
 * request that can never be approved.
 */
function RequestDialog({
  field,
  currentValue,
  pending,
  departmentOptions,
  departmentsLoading,
  departmentsError,
  onRetryDepartments,
  onOpenChange,
}: {
  field: Requestable | null
  currentValue: string
  pending?: ChangeRequest
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
      const shown = requestValueLabel(field.field, value)
      toast.ok(
        pending
          ? `Request changed: ${field.label} → “${shown}”`
          : `Request sent: ${field.label} → “${shown}”`
      )
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the request")
    }
  }

  const choices: ComboboxOption[] | null = !field
    ? null
    : field.field === "department"
      ? departmentOptions
      : field.field === "role"
        ? ASSIGNABLE_ROLES.filter((r) => r !== currentValue).map((r) => ({
            value: r,
            label: roleLabel(r),
          }))
        : field.field === "faculty_type"
          ? Object.entries(FACULTY_TYPE_LABEL)
              .filter(([value]) => value !== currentValue)
              .map(([value, label]) => ({ value, label }))
          : null

  const noteHint =
    field?.field === "faculty_type"
      ? "Optional. Anything that helps the research office decide."
      : "Optional. Anything that helps the research office decide."

  return (
    <Dialog open={!!field} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {field && (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>
                {pending ? "Change your request" : "Request a change"}: {field.label}
              </DialogTitle>
              <DialogDescription>
                Now: “{requestValueLabel(field.field, currentValue) || "not set"}”. The research
                office decides. You are told either way, and why if it is declined.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-3.5">
              {field.field === "department" && departmentsError ? (
                <InlineError message="Could not load the department list." onRetry={onRetryDepartments} />
              ) : choices ? (
                <Field label={`Proposed ${field.phrase}`}>
                  <Combobox
                    value={proposed || null}
                    onChange={setProposed}
                    options={choices}
                    placeholder={
                      field.field === "department" && departmentsLoading ? "Loading…" : "Choose…"
                    }
                    disabled={field.field === "department" && departmentsLoading}
                  />
                </Field>
              ) : (
                <Field label={`Proposed ${field.phrase}`}>
                  <Input value={proposed} onChange={(e) => setProposed(e.target.value)} autoFocus />
                </Field>
              )}

              <Field label="Note" hint={noteHint}>
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
