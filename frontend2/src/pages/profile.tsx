import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { LoaderCircle, Lock, X } from "lucide-react"

import {
  ASSIGNABLE_ROLES,
  FACULTY_TYPE_LABEL,
  quotaLabel,
  requestValueLabel,
  roleLabel,
} from "@/app/account"
import { can, useAuth } from "@/app/auth"
import { loadGoogleIdentity, type GoogleConfig } from "@/app/google"
import { PasswordDialog } from "@/app/password"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
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
import { Field, Input, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import {
  Callout,
  EmptyState,
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

/** The stage buckets `/api/claims/counts` groups statuses into, server-side,
 *  so this screen and the papers list cannot disagree about what "filed"
 *  means. */
type ClaimCounts = {
  counts: {
    draft: number
    filed: number
    checked: number
    approved: number
    authorised: number
    paid: number
    sent_back: number
    all: number
  }
}

type Dashboard = { total_paid: number }

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
  | "research_quota"

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
  research_quota: { field: "research_quota", label: "Research quota", phrase: "research quota" },
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
  // `/claims/counts` and `/dashboard` are both scoped by `_claims_queryset`,
  // which is "my claims" only for a faculty member or a head — for an
  // oversight role it is the whole college, so those figures would be the
  // college's total wearing a heading that says "yours".
  const role = meQuery.data?.role ?? sessionMe?.role ?? null
  const filesOwnPapers = role === "FACULTY" || role === "HOD"
  // The one rule that is not a matter of taste. `/api/dashboard` returns
  // `total_paid` and refuses a head outright (403), so this is not merely a
  // hidden figure — asking at all is an error for them.
  const seeMoney = can(sessionMe?.role).seeMoney

  const countsQuery = useApi<ClaimCounts>(["profile", "counts"], "/api/claims/counts", {
    enabled: filesOwnPapers,
  })
  const paidQuery = useApi<Dashboard>(["profile", "dashboard"], "/api/dashboard", {
    enabled: filesOwnPapers && seeMoney,
  })

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
          title="Could not load your profile"
          message="The server did not answer. Your details are unchanged — nothing has been lost."
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

  const summary = [me.designation, me.department, roleLabel(me.role)].filter(Boolean).join(" · ")
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

  return (
    <div className="page space-y-10 py-8">
      <header>
        <PageTitle>Your profile</PageTitle>
        <Sub className="mt-1">
          {me.name} · {me.email}
        </Sub>
        {summary && <Meta className="mt-1 block">{summary}</Meta>}
      </header>

      {me.role === "FACULTY" && missing.length > 0 && (
        <Callout tone="caution" title="Your profile is missing what a claim needs">
          {missing.join(", ")} {missing.length === 1 ? "is" : "are"} not set. A claim is
          checked against these, so ask for {missing.length === 1 ? "it" : "them"} to be
          filled in below before you file.
        </Callout>
      )}

      {!me.active && (
        <Callout tone="critical" title="This account is deactivated">
          You can still read your own record, but you cannot file anything. The research
          cell reactivates an account; asking here will not.
        </Callout>
      )}

      {/* ---- details you can change -------------------------------------- */}

      <section className="space-y-6">
        <div>
          <SectionTitle>Details you can change</SectionTitle>
          <Sub className="mt-1">
            Nothing here is paid on or checked against a claim, so a change saves straight
            away.
          </Sub>
        </div>
        <PhoneForm phone={me.phone} />
        <Interests />
      </section>

      {/* ---- details the research office keeps --------------------------- */}

      <section className="space-y-4">
        <div>
          <SectionTitle>Details the research office keeps</SectionTitle>
          <Sub className="mt-1">
            These decide who gets paid and whose record a paper is checked against, so they
            are not typed here. Ask for a change and the research office decides — you are
            told either way.
          </Sub>
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
          <DetailRow
            label="Email"
            value={me.email}
            note="Your sign-in, and where every decision on a paper is sent. Changing it is an account change rather than a request — the research cell does it directly."
          />
          {requestable("staff_id")}
          {requestable("biometric_id")}
          <DetailRow
            label="Employee ID"
            value={me.employee_id || "Not set"}
            note="Comes off the ERP roster, not this system. A wrong one is fixed in the ERP and re-imported, so there is no request for it here."
          />
          {requestable("designation")}
          {requestable("department")}
          {requestable("role", {
            note: "Decides which screens you have. A super admin decides a request to change it.",
          })}
          {requestable("faculty_type", {
            note: "Set by a super admin, deliberately not by the research cell — the cell processes the claims this decides the outcome of.",
          })}
          {me.faculty_type === "RESEARCH" && (
            <DetailRow
              field="research_quota"
              label={REQUESTABLE.research_quota.label}
              value={me.research_quota != null ? quotaLabel(me.research_quota) : "No quota recorded"}
              note={me.research_quota_note || undefined}
              after={
                seeMoney && me.research_quota ? (
                  <p className="mt-2 max-w-md rounded-md bg-accent-wash px-3 py-2 text-sm text-fg">
                    The first {me.research_quota}{" "}
                    {plural(me.research_quota, "paper", "papers")} you file in a publication
                    year are what the post already expects, so they carry no incentive.
                    Anything beyond that is reimbursed in full.
                  </p>
                ) : null
              }
              requests={requestsByField.get("research_quota") || []}
              onAsk={() => setAsking("research_quota")}
            />
          )}
          {requestable("scopus_author_url")}
          {requestable("scopus_author_id")}
        </dl>
      </section>

      {/* ---- sign-in methods --------------------------------------------- */}

      <section className="space-y-4">
        <div>
          <SectionTitle>Sign-in methods</SectionTitle>
          <Sub className="mt-1">
            Your email and password always work. Google is an extra way in, if you link it.
          </Sub>
        </div>

        <dl className="divide-y divide-line border-y border-line">
          <div data-detail className="py-4">
            <dt className="text-sm font-medium text-fg-muted">Email and password</dt>
            <dd className="mt-1">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base break-words">{me.email}</p>
                  <p className="mt-1 max-w-md text-sm text-fg-muted">
                    Issued passwords are 24 random characters handed over on paper — use the
                    eye icon if you are not sure you typed the current one correctly.
                  </p>
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
          <GoogleRow link={me.google} />
        </dl>
      </section>

      {/* ---- your record ------------------------------------------------ */}

      <section className="space-y-4">
        <div>
          <SectionTitle>Your record</SectionTitle>
          <Sub className="mt-1">
            {filesOwnPapers
              ? "Every paper filed under your name, counted at the stage it has actually reached."
              : "Papers are counted against the person who filed them."}
          </Sub>
        </div>

        {filesOwnPapers ? (
          <Record
            counts={countsQuery.data}
            countsLoading={countsQuery.isLoading}
            countsError={countsQuery.isError}
            onRetryCounts={() => countsQuery.refetch()}
            seeMoney={seeMoney}
            totalPaid={paidQuery.data?.total_paid}
            paidLoading={paidQuery.isLoading}
            paidError={paidQuery.isError}
            onRetryPaid={() => paidQuery.refetch()}
            isHod={role === "HOD"}
          />
        ) : (
          <Meta className="block max-w-md">
            This account reads the whole college's pipeline rather than a queue of its
            own, so a personal filing record here would only ever be the college total
            under a heading that said “yours”.
          </Meta>
        )}
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
 * The phone number, saved through `PATCH /auth/profile/self` — the one route
 * a person writes their own account through. The server's refusal is shown
 * word for word under the box: "that does not look like a phone number, for
 * example +91 98400 12345" is the whole of the help anybody needs.
 */
function PhoneForm({ phone }: { phone: string | null }) {
  const saved = phone ?? ""
  const [value, setValue] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  // After a save the page refetches `/auth/me`; the box follows what the
  // server now holds (it tidies spacing) rather than what was typed.
  useEffect(() => {
    setValue(saved)
  }, [saved])

  const save = useApiMutation<{ phone: string }, { phone: string | null }>(
    "/api/auth/profile/self",
    { method: "PATCH", invalidates: [["profile", "me"]] }
  )
  const dirty = value.trim() !== saved

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    save.mutate(
      { phone: value.trim() },
      {
        onSuccess: (data) => {
          setValue(data.phone ?? "")
          toast.ok(data.phone ? "Phone number saved" : "Phone number removed")
        },
        onError: (err) => setError(err.message),
      }
    )
  }

  return (
    <form onSubmit={submit} className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        Phone
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          placeholder="+91 98400 12345"
          aria-describedby={`${id}-help`}
          aria-invalid={error ? true : undefined}
          className="min-w-0 max-w-xs flex-1"
        />
        <Button
          kind="primary"
          type="submit"
          disabled={!dirty || save.isPending}
          aria-label="Save phone number"
        >
          {save.isPending && <LoaderCircle className="animate-spin" />}
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {error ? (
        <p id={`${id}-help`} role="alert" className="text-xs text-critical">
          {error}
        </p>
      ) : (
        <p id={`${id}-help`} className="text-xs text-fg-muted">
          Optional. The research office uses it to reach you about a paper.
        </p>
      )}
    </form>
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
    <div data-detail className="py-4">
      <dt className="flex items-center gap-1.5 text-sm font-medium text-fg-muted">
        <Lock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        {label}
      </dt>
      <dd className="mt-1">
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
              kind="quiet"
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
            {pending.created_at ? ` since ${formatDate(pending.created_at)}` : ""} — “
            {shown(pending.current_value) || "not set"}” → “{shown(pending.proposed_value)}”
          </p>
        )}

        {lastDeclined && (
          <div className="mt-3 rounded-md bg-critical-wash px-3 py-2 text-sm text-critical">
            <p className="font-medium">
              Declined — you asked for “{shown(lastDeclined.proposed_value)}”
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
function GoogleRow({ link }: { link: GoogleLink | null }) {
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
                    `Google linked — ${data.google?.email || "that account"} can now sign you in`
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
              Link a Google account and you can sign in with it instead of typing your
              password. A personal Gmail is fine.
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
/* Your record                                                              */
/* ------------------------------------------------------------------------ */

/** A number that is an answer, not a tile. No box, no border — the label and
 *  the weight do the work a card was doing. */
function Figure({
  label,
  value,
  hint,
  muted,
}: {
  label: string
  value: string
  hint?: string
  muted?: boolean
}) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      <p className={cn("mt-0.5 text-2xl font-semibold tabular", muted && "text-fg-subtle")}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}

/**
 * What the college's ledger says about you, at the stage each paper has
 * actually reached.
 *
 * The counts and the money come from two different requests on purpose, and
 * each fails on its own: a failed `/dashboard` must not turn the paid total
 * into a confident ₹0 beside five counts that loaded fine, and a failed
 * `/claims/counts` must not read as "you have filed nothing".
 */
function Record({
  counts,
  countsLoading,
  countsError,
  onRetryCounts,
  seeMoney,
  totalPaid,
  paidLoading,
  paidError,
  onRetryPaid,
  isHod,
}: {
  counts: ClaimCounts | undefined
  countsLoading: boolean
  countsError: boolean
  onRetryCounts: () => void
  seeMoney: boolean
  totalPaid: number | undefined
  paidLoading: boolean
  paidError: boolean
  onRetryPaid: () => void
  isHod: boolean
}) {
  if (countsLoading) {
    return <SkeletonRows rows={2} rowHeight={48} />
  }

  if (countsError || !counts) {
    return (
      <ErrorState
        title="Could not count your papers"
        message="The server did not answer. This is not a statement that you have filed nothing — try again."
        onRetry={onRetryCounts}
      />
    )
  }

  const c = counts.counts
  const filed = c.all - c.draft
  const inReview = c.filed + c.checked + c.approved + c.authorised

  if (c.all === 0) {
    return (
      <EmptyState
        title="You have not filed a paper yet"
        message={
          isHod
            ? "Heads of department do not file claims. Your department's publications are under Department."
            : "Nothing has been submitted under your name. File a paper and it will be counted here from the moment it is submitted."
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
        <Figure
          label="Filed"
          value={String(filed)}
          hint="Submitted, at any stage"
          muted={filed === 0}
        />
        <Figure
          label="In review"
          value={String(inReview)}
          hint="Not yet paid or sent back"
          muted={inReview === 0}
        />
        <Figure label="Paid" value={String(c.paid)} muted={c.paid === 0} />
        <Figure
          label="Sent back"
          value={String(c.sent_back)}
          hint={c.sent_back > 0 ? "Needs something from you" : undefined}
          muted={c.sent_back === 0}
        />
        <Figure
          label="Drafts"
          value={String(c.draft)}
          hint="Yours only — nobody else sees a draft"
          muted={c.draft === 0}
        />

        {seeMoney &&
          (paidLoading ? (
            <div>
              <p className="text-sm text-fg-muted">Total received</p>
              <SkeletonRows rows={1} rowHeight={28} className="mt-1 max-w-32" />
            </div>
          ) : paidError || totalPaid == null ? null : (
            <Figure
              label="Total received"
              value={money(totalPaid)}
              hint="Settled payments only"
              muted={totalPaid === 0}
            />
          ))}
      </div>

      {seeMoney && paidError && (
        <InlineError
          message="Could not load what you have been paid. The counts above are still accurate."
          onRetry={onRetryPaid}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Research interests                                                       */
/* ------------------------------------------------------------------------ */

const MAX_INTERESTS = 20

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
function Interests() {
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

  function persist() {
    save.mutate(
      { domains: current },
      {
        onSuccess: (data) => {
          setSelected(data.domains)
          toast.ok(`Saved — ${data.domains.length} ${plural(data.domains.length, "domain", "domains")}`)
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
          message="The server did not answer. Any domains you have chosen are still saved — try again."
          onRetry={() => interests.refetch()}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {current.length === 0 && (
              <Meta>No domains chosen yet — nothing will be matched to you until there are.</Meta>
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

          <div className="flex flex-wrap items-center gap-3">
            <Combobox
              value={null}
              onChange={(v) => setSelected([...current, v])}
              options={options}
              placeholder={
                domains.isLoading
                  ? "Loading…"
                  : current.length >= MAX_INTERESTS
                    ? `${MAX_INTERESTS} chosen — remove one to add another`
                    : "Add a domain…"
              }
              disabled={domains.isLoading || domains.isError || current.length >= MAX_INTERESTS}
              aria-label="Add a domain"
              className="w-full max-w-xs"
            />
            <Button kind="primary" size="sm" onClick={persist} disabled={!dirty || save.isPending}>
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
          ? `Request changed — ${field.label} → “${shown}”`
          : `Request sent — ${field.label} → “${shown}”`
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
      ? "Optional — if a research quota was agreed, say what it is."
      : "Optional — anything that helps the research office decide."

  return (
    <Dialog open={!!field} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {field && (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>
                {pending ? "Change your request" : "Request a change"} — {field.label}
              </DialogTitle>
              <DialogDescription>
                Now: “{requestValueLabel(field.field, currentValue) || "not set"}”. The research
                office decides — you are told either way, and why if it is declined.
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
              ) : field.field === "research_quota" ? (
                <Field label="Proposed research quota" hint="Papers a year before any incentive is due.">
                  <Input
                    inputMode="numeric"
                    value={proposed}
                    onChange={(e) => setProposed(e.target.value)}
                    autoFocus
                    className="max-w-32"
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
