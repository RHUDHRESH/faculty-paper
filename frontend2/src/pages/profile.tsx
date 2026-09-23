import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { LoaderCircle, X } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { PasswordDialog } from "@/app/password"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
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
 * The account page at `/me` — who you are, what you can ask to change, what
 * the college's record of you actually says, and the password.
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
  // Set only by a super admin, never by a claimant and never by the research
  // cell — being marked research faculty with a quota of four means four
  // papers a year are paid nothing.
  faculty_type: string | null
  research_quota: number | null
  research_quota_note: string | null
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

type CorrectableFieldKey =
  | "name"
  | "department"
  | "designation"
  | "staff_id"
  | "biometric_id"
  | "scopus_author_url"
  | "scopus_author_id"

type CorrectableField = { field: CorrectableFieldKey; label: string; identity: boolean }

//  Exactly the seven keys `CORRECTABLE` accepts in `backend/core/api.py`;
//  anything else posted to `/auth/profile/correction` is a 400, so a row that
//  offered the button for one would be a dead control.
//
//  `department` is correctable but, per API.md, deliberately not an identity
//  field — the research cell moves people between departments as routine
//  business, not as a payment-and-attribution decision.
const CORRECTABLE: Record<CorrectableFieldKey, CorrectableField> = {
  name: { field: "name", label: "Full name", identity: true },
  department: { field: "department", label: "Department", identity: false },
  designation: { field: "designation", label: "Designation", identity: true },
  staff_id: { field: "staff_id", label: "Staff ID", identity: true },
  biometric_id: { field: "biometric_id", label: "Biometric ID", identity: true },
  scopus_author_url: {
    field: "scopus_author_url",
    label: "Scopus author link",
    identity: true,
  },
  scopus_author_id: {
    field: "scopus_author_id",
    label: "Scopus author ID",
    identity: true,
  },
}

function valueFor(me: FullMe, field: CorrectableFieldKey): string {
  return me[field] || ""
}

/** The profile fields a claim is checked against, by the label shown below. */
function missingForClaims(me: FullMe): string[] {
  const out: string[] = []
  if (!me.staff_id) out.push("Staff ID")
  if (!me.department) out.push("Department")
  if (!me.scopus_author_id && !me.scopus_author_url) out.push("Scopus author profile")
  return out
}

function formatRole(role: string): string {
  return role
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ")
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/** What "research faculty with a quota of four" says on one line. Read from
 *  `/auth/me`, which carries `faculty_type` and `research_quota` — this is
 *  not derivable from the role and a claimant has no other way to see it. */
function standingLine(me: FullMe): string {
  const quota = me.research_quota
  if (me.faculty_type === "RESEARCH") {
    return quota
      ? `Research faculty — a quota of ${quota} ${plural(quota, "paper", "papers")} a year`
      : "Research faculty — no quota recorded"
  }
  if (me.faculty_type === "REGULAR") return "Regular faculty — no research quota"
  return "Not recorded"
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
        <ErrorState
          title="Could not load your profile"
          message="The server did not answer. Your details are unchanged — nothing has been lost."
          onRetry={() => meQuery.refetch()}
        />
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

  const pendingCount = (correctionsQuery.data?.results || []).filter(
    (c) => c.status === "PENDING"
  ).length

  const departmentOptions: ComboboxOption[] = (departmentsQuery.data || []).map((d) => ({
    value: d,
    label: d,
  }))

  const correctingMeta = correctingField ? CORRECTABLE[correctingField] : null
  const correctingPending = correctingField
    ? correctionsByField.get(correctingField)?.find((c) => c.status === "PENDING")
    : undefined

  const summary = [me.designation, me.department, formatRole(me.role)].filter(Boolean).join(" · ")

  function correctable(key: CorrectableFieldKey) {
    return (
      <CorrectableRow
        meta={CORRECTABLE[key]}
        value={valueFor(me, key) || "Not set"}
        corrections={correctionsByField.get(key) || []}
        onAsk={() => setCorrectingField(key)}
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

      {me.role === "FACULTY" && missingForClaims(me).length > 0 && (
        <Callout tone="caution" title="Your profile is missing what a claim needs">
          {missingForClaims(me).join(", ")}{" "}
          {missingForClaims(me).length === 1 ? "is" : "are"} not set. A claim is checked against
          these, so ask for {missingForClaims(me).length === 1 ? "it" : "them"} to be filled in
          below before you file.
        </Callout>
      )}

      {!me.active && (
        <Callout tone="critical" title="This account is deactivated">
          You can still read your own record, but you cannot file anything. The research
          cell reactivates an account; asking here will not.
        </Callout>
      )}

      {/* ---- who you are ------------------------------------------------ */}

      <section className="space-y-4">
        <div>
          <SectionTitle>Who you are</SectionTitle>
          <Sub className="mt-1">
            The research cell owns every line of this. None of it is typed here, because
            these are the details that decide who gets paid and whose record a paper is
            checked against — ask for a correction and an admin actions it.
          </Sub>
        </div>

        {correctionsQuery.isError && (
          <InlineError
            message="Could not load your correction requests. Anything already pending may not show here."
            onRetry={() => correctionsQuery.refetch()}
          />
        )}

        {pendingCount > 0 && (
          <Meta className="block">
            {pendingCount} {plural(pendingCount, "correction is", "corrections are")} with an
            admin.
          </Meta>
        )}

        <dl className="divide-y divide-line border-y border-line">
          {correctable("name")}
          <StaticField
            label="Email"
            value={me.email}
            note="Your sign-in, and where every decision on a paper is sent. Changing it is an account change, not a profile correction — the research cell does it directly."
          />
          {correctable("staff_id")}
          {correctable("biometric_id")}
          <StaticField
            label="Employee ID"
            value={me.employee_id || "Not set"}
            note="Comes off the ERP roster, not this system. There is no correction request for it — a wrong one is fixed in the ERP and re-imported."
          />
          {correctable("designation")}
          {correctable("department")}
          <StaticField
            label="Role"
            value={formatRole(me.role)}
            note="Decides which screens you have. Only a super admin sets it, and there is no correction request for it."
          />
          <StaticField
            label="Research standing"
            value={standingLine(me)}
            note={
              me.research_quota_note ||
              "Set by a super admin, deliberately not by the research cell — the cell processes the claims this decides the outcome of, so it cannot also set it."
            }
            extra={
              seeMoney && me.faculty_type === "RESEARCH" && me.research_quota ? (
                <p className="mt-2 max-w-md rounded-md bg-accent-wash px-3 py-2 text-sm text-fg">
                  The first {me.research_quota}{" "}
                  {plural(me.research_quota, "paper", "papers")} you file in a publication
                  year are what the post already expects, so they carry no incentive.
                  Anything beyond that is reimbursed in full.
                </p>
              ) : null
            }
          />
          {correctable("scopus_author_url")}
          {correctable("scopus_author_id")}
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

      {/* ---- research interests ----------------------------------------- */}

      <Interests />

      {/* ---- password ---------------------------------------------------- */}

      <section className="space-y-3">
        <SectionTitle>Password</SectionTitle>
        <Sub>
          Issued passwords are 24 random characters handed over on paper — use the eye
          icon if you are not sure you typed the current one correctly.
        </Sub>
        {me.must_change_password && (
          <Callout tone="caution" title="You are still on the issued password">
            It was handed over on paper and more than one person has seen it. Change it
            before you file anything.
          </Callout>
        )}
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

/**
 * A detail with no correction request behind it — the email, the ERP employee
 * number, the role, the research quota. `note` is not decoration: a value the
 * reader cannot change and cannot ask about needs to say where it does come
 * from, or the only remaining move is a support email asking exactly that.
 */
function StaticField({
  label,
  value,
  note,
  extra,
}: {
  label: string
  value: string
  note?: string
  extra?: ReactNode
}) {
  return (
    <div className="py-4">
      <FieldLabel>{label}</FieldLabel>
      <p className="mt-1 text-base">{value}</p>
      {note && <p className="mt-1 max-w-md text-sm text-fg-muted">{note}</p>}
      {extra}
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
          {value.startsWith("http://") || value.startsWith("https://") ? (
            <a href={value} target="_blank" rel="noreferrer" className="mt-1 block break-all text-base text-accent hover:underline">
              {value}
            </a>
          ) : (
            <p className="mt-1 text-base break-words">{value}</p>
          )}
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
    <section className="space-y-3">
      <div>
        <SectionTitle>What you work on</SectionTitle>
        <Sub className="mt-1">
          Unlike everything above, this is yours to set. It decides who you are matched
          with and what gets suggested to you. Up to {MAX_INTERESTS}.
        </Sub>
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
    </section>
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
