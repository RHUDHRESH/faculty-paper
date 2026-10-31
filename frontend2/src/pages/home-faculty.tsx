import { unshout } from "@/lib/names"
import { Link } from "react-router-dom"
import { FilePlus2, Wallet } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { formatCount } from "@/lib/count"
import { useApi, useApiMutation } from "@/lib/query"
import {
  KindBadge,
  STATUSES,
  StatusSelect,
  type AssignmentStatus,
  type MyAssignment,
} from "@/pages/assignment-parts"
import { amountView, filedSentence, SLOW_DAYS, stageWord, type PayoutOutlook } from "@/pages/claims-track"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ErrorState, Skeleton } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { money } from "@/ui/paper"
import { DetailLink } from "@/ui/detail-sheet"
import { Journey, claimStatus, facultyStage } from "@/ui/journey"
import { Chip } from "@/ui/chip"
import { cn } from "@/lib/cn"
import { toast } from "@/ui/toast"
import { Due, When } from "@/ui/when"
import { PageHeader } from "@/ui/page-header"
import { Avatar } from "@/ui/person"
import { Rows, Section } from "@/ui/section"
import { Table, type Column } from "@/ui/table"
import { ComingUpEvents } from "@/pages/home-events"
import { ClaimThresholdNote, ThresholdCard, type ThresholdSummary } from "@/ui/research-threshold"

/**
 * What a faculty member opens the app to find out: is anything needed from
 * me, where are my claims and when does the money come, and which of my
 * papers can I still file.
 *
 * Four numbers first (papers to file, claims in progress, paid this year,
 * h-index), then two plain tables: the papers on the record that could still
 * be filed, each with a File button, and the person's own claims, with the
 * ones that need them first.
 *
 * It never says which desk holds a claim. The college decided that a
 * claimant learns how far a claim has come and how long it has waited, and
 * nothing that would send them to stand in front of one person's office.
 */

type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  doi?: string | null
  journal_title: string | null
  /** Absent on a claimant's own copy: use claimStatus(). */
  status?: string
  status_note?: string | null
  faculty_stage?: string | null
  days_waiting?: number | null
  remuneration: number | null
  remuneration_is_estimate: boolean
  calc_error: string | null
  waiting_days: number | null
  publication_year: number | null
  updated_at: string | null
  submitted_at?: string | null
  paid_at: string | null
  /** The research threshold's effect on this claim (research faculty only). */
  threshold_absorbed?: number | null
  threshold_full_amount?: number | null
}

type Payload = { results: Claim[]; total: number }

/** The ledger's view of what this person has been paid (`/api/me/payments`). */
export type Payment = {
  id: number
  claim_id: string | null
  payout_month: string | null
  paper_title: string | null
  journal_title: string | null
  amount: number
  voucher_number: string | null
}
type MyPayments = {
  total: number
  this_year: number
  since: string
  count: number
  latest_month: string | null
  rows: Payment[]
  /** Research faculty only: the yearly threshold and how much of it is used. */
  research?: ThresholdSummary
}

/** "2025-03" -> "Mar 2025". */
export function monthLabel(ym: string | null | undefined): string | null {
  if (!ym) return null
  const [y, m] = ym.split("-").map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" })
}

const MOVING = new Set(["Submitted", "Under review", "Approved for payment"])

/** "1 June 2026". */
function sinceLabel(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
}

/** The Indian academic year this date falls in starts on 1 June. */
function academicYearStart(now = new Date()): Date {
  const y = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1
  return new Date(y, 5, 1)
}

function onDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

function stageOfClaim(c: Claim): string {
  return c.faculty_stage || facultyStage(claimStatus(c))
}

function daysOf(c: Claim): number | null {
  return c.days_waiting ?? c.waiting_days ?? null
}

/**
 * The signed-in claimant's own papers, and the money on them, worked out once
 * for whichever home draws them: a faculty member's, a head of department's,
 * or an officer's -- the Principal, the research cell, the Director, Finance
 * -- who is an academic too, and files their own.
 *
 * `mine=1`, because for an officer `/api/claims` is the college's papers;
 * for a faculty member or a head it changes nothing. The amounts are theirs:
 * the server strips a figure from anything a head does not own
 * (`hod.for_head`), and shapes the viewer's own papers as the claimant's.
 */
export function useOwnPapers() {
  const query = useApi<Payload>(HOME_DATA.ownClaims.key, HOME_DATA.ownClaims.path)
  // Money comes from the ledger, which also holds everything paid before this
  // app existed. Claims alone told people with years of payments "₹0".
  const ledger = useApi<MyPayments>(HOME_DATA.myPayments.key, HOME_DATA.myPayments.path)

  const claims = query.data?.results || []
  const paid = claims.filter((c) => claimStatus(c) === "PAID")
  const moving = claims
    .filter((c) => MOVING.has(stageOfClaim(c)))
    .sort((a, b) => (daysOf(b) ?? -1) - (daysOf(a) ?? -1))
  const sentBack = claims.filter((c) => stageOfClaim(c) === "Sent back to you")
  const drafts = claims.filter((c) => claimStatus(c) === "DRAFT")
  const received = paid.reduce((s, c) => s + (c.remuneration || 0), 0)
  // The college's year comes from the server (one policy setting); the local
  // 1 June guess is only for the moment before it has answered.
  const since = ledger.data?.since ? new Date(`${ledger.data.since}T00:00:00`) : academicYearStart()
  const thisYear = paid
    .filter((c) => c.paid_at && new Date(c.paid_at) >= since)
    .reduce((s, c) => s + (c.remuneration || 0), 0)
  const coming = moving.reduce((s, c) => s + (c.remuneration || 0), 0)
  const fromClaims = onDate(
    paid
      .map((c) => c.paid_at)
      .filter((d): d is string => Boolean(d))
      .sort()
      .pop()
  )
  const pay = ledger.data
  return {
    isLoading: query.isLoading || ledger.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    claims,
    paid,
    moving,
    sentBack,
    drafts,
    received: pay ? pay.total : received,
    since,
    thisYear: pay ? pay.this_year : thisYear,
    coming,
    lastPaidOn: pay ? monthLabel(pay.latest_month) : fromClaims,
    paymentCount: pay ? pay.count : paid.filter((c) => (c.remuneration || 0) > 0).length,
    payments: pay?.rows || [],
    research: pay?.research,
  }
}

export type OwnPapers = ReturnType<typeof useOwnPapers>

/** `/api/me/home`: the record part of Home in one light call. */
export type HomeRecord = {
  papers: number
  citations: number | null
  h_index: number | null
  /** The record by journal quartile; the groups add up to `papers`. */
  quartiles?: { Q1: number; Q2: number; Q3: number; Q4: number; none: number }
  /** null until the publication record exists: the row is hidden, never "0". */
  unfiled: {
    count: number
    items: { id: string; title: string; venue: string | null; year: number | null; quartile?: string | null }[]
  } | null
}

/**
 * The college's reason a claim was sent back, in the college's words, or null
 * when the note is only a trace of how the claim came into the system (a
 * claim carried over from the old workbook says "Imported from Raw_Data"),
 * which a claimant must never be shown as a reason.
 */
export function reasonOf(note: string | null | undefined): string | null {
  const t = (note || "").trim()
  if (!t || /^imported\b/i.test(t) || /^erp[-_ ]/i.test(t)) return null
  return t
}

/** "Good morning" before 12:00 IST, "Good afternoon" before 17:00, else "Good evening". */
export function greeting(now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(now)
  )
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
}

const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`

/** "October 2026" is "October" when it is this year: how a person says it. */
export function monthOnly(label: string | null | undefined, now = new Date()): string | null {
  if (!label) return null
  const [name, year] = label.split(" ")
  return year && Number(year) !== now.getFullYear() ? label : name
}

export type SentenceInput = {
  sentBack: number
  drafts: number
  /** Claims still moving, and what they would pay. */
  moving: number
  coming: number
  /** Some of what is coming is a calculator's estimate, not a fixed amount. */
  estimate: boolean
  /** At least one moving claim is already approved for payment. */
  approved: boolean
  /** "October 2026", from the college's payment pattern. */
  nextRun: string | null
  unfiled: number | null
  filedAny: boolean
  now?: Date
}

/**
 * The page's state in one sentence, worked out from what the page shows.
 * A clause is only said when it is true, and "expected in October" is only
 * said when a claim is already approved for payment, because before that the
 * college has not said it will pay it.
 */
export function homeSentence(s: SentenceInput): string {
  if (!s.filedAny && s.sentBack === 0 && s.drafts === 0) {
    return s.unfiled ? `You have not filed a claim yet, and ${plural(s.unfiled, "paper", "papers")} on your record could be filed.` : "You have not filed a claim yet."
  }
  const needs: string[] = []
  if (s.sentBack) needs.push(`${plural(s.sentBack, "claim needs", "claims need")} a fix from you`)
  if (s.drafts) needs.push(`${plural(s.drafts, "draft is", "drafts are")} not filed`)
  let waiting = ""
  if (s.moving && s.coming > 0) {
    const amount = `${s.estimate ? "about " : ""}${money(s.coming)}`
    const month = monthOnly(s.nextRun, s.now)
    waiting = s.approved
      ? `${amount} is on its way${month ? `, expected in ${month}` : ""}`
      : `${amount} is with the college, being checked`
  } else if (s.moving) {
    waiting = `${plural(s.moving, "claim is", "claims are")} being checked`
  }
  const needed = needs.join(" and ")
  let out: string
  if (needed && waiting) out = `${needed}; ${waiting}.`
  else if (needed) out = `${needed}.`
  else if (waiting) out = `Nothing needs you; ${waiting}.`
  else out = "Nothing needs you, and nothing is waiting to be paid."
  if (s.unfiled && !needed && !waiting) out += ` ${plural(s.unfiled, "paper", "papers")} on your record ${s.unfiled === 1 ? "is" : "are"} not filed yet.`
  return out.charAt(0).toUpperCase() + out.slice(1)
}

/** How many rows a Home table shows; the rest are one link away. */
const SHOWN = 10

export function FacultyHome() {
  const { me } = useAuth()
  const own = useOwnPapers()
  const home = useApi<HomeRecord>(HOME_DATA.myHome.key, HOME_DATA.myHome.path)
  const outlook = useApi<PayoutOutlook>(HOME_DATA.nextPayout.key, HOME_DATA.nextPayout.path)
  // Secondary to the record, so a failure here draws nothing rather than a
  // second error box on the page every claimant lands on.
  const assigned = useApi<MyAssignment[]>(HOME_DATA.myAssignments.key, HOME_DATA.myAssignments.path)

  // A failed request is not an empty record: telling somebody with a year of
  // payments behind them that they have "₹0" is the worst thing this page
  // could do with a dropped request.
  if (own.isError) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Could not load your record"
          message="The server did not answer. Nothing has been lost — your papers and payments are safe."
          onRetry={() => void own.refetch()}
        />
      </div>
    )
  }

  const rec = home.data
  const load = own.isLoading
  const inProgress = own.moving.length + own.sentBack.length
  const toFile = rec ? (rec.unfiled?.count ?? 0) : null

  return (
    <div className="page space-y-8 pb-16">
      <PageHeader
        title="Home"
        sub={[me?.designation, me?.department].filter(Boolean).join(", ") || "Your papers, claims and payments."}
        action={
          <Button kind="primary" asChild>
            <Link to="/papers/new">
              <FilePlus2 />
              File a paper
            </Link>
          </Button>
        }
      />

      <Answer
        items={[
          {
            value: toFile,
            label: "papers you can still file",
            zero: "No paper is waiting to be filed",
            to: "/papers?filter=unclaimed",
            tone: toFile ? "caution" : "neutral",
          },
          {
            value: load ? null : inProgress,
            label: `${inProgress === 1 ? "claim" : "claims"} in progress${own.coming > 0 ? `, ${money(own.coming)} on the way` : ""}`,
            zero: "No claim in progress",
            to: "/papers/claims",
            tone: own.sentBack.length ? "caution" : "neutral",
          },
          {
            value: load ? null : money(own.thisYear),
            label: `paid since ${sinceLabel(own.since)}`,
            // The statement is by financial year, so this opens the year that
            // date falls in: one click from the figure to the lines behind it.
            to: `/papers/statement?fy=${own.since.getMonth() >= 3 ? own.since.getFullYear() : own.since.getFullYear() - 1}`,
          },
          {
            value: rec ? (rec.h_index ?? "Not known yet") : null,
            label: rec
              ? rec.citations != null
                ? `h-index, ${formatCount(rec.citations)} citations on ${plural(rec.papers, "paper", "papers")}`
                : `h-index, ${plural(rec.papers, "paper", "papers")} on record`
              : "h-index",
            to: "/research#metrics",
          },
        ]}
      />

      {home.isError && (
        <p role="alert" className="text-sm text-fg-muted">
          Could not load your record. Nothing has been lost — your papers and payments are safe.{" "}
          <button type="button" onClick={() => void home.refetch()} className="font-medium text-accent underline underline-offset-2">
            Try again
          </button>
        </p>
      )}
      {rec && rec.citations == null && rec.papers > 0 && (
        <p className="text-sm text-fg-muted">
          We are still matching you to your Scopus profile, so citations are not shown yet.{" "}
          <Link to="/me" className="font-medium text-accent underline-offset-2 hover:underline">
            Check my profile
          </Link>
        </p>
      )}

      {rec?.unfiled && rec.unfiled.count > 0 && <UnfiledTable unfiled={rec.unfiled} />}

      <ClaimsTable own={own} />

      {assigned.data && assigned.data.length > 0 && (
        <AssignedToYou items={assigned.data} open={assigned.data.filter((a) => a.status !== "DONE").length} />
      )}

      <MoneyNote own={own} outlook={outlook.data} />

      <ComingUpEvents />
    </div>
  )
}

/** What has been paid, in a line or two, and the research threshold where there is one. */
function MoneyNote({ own, outlook }: { own: OwnPapers; outlook: PayoutOutlook | undefined }) {
  const { received, paymentCount, lastPaidOn, research, isLoading } = own
  return (
    <section aria-label="Your money" className="space-y-3">
      {!isLoading && (
        <p className="max-w-prose text-sm text-fg-muted">
          {money(received)} paid to you so far
          {paymentCount ? `, ${plural(paymentCount, "payment", "payments")}${lastPaidOn ? `, latest ${lastPaidOn}` : ""}` : ""}.{" "}
          {outlook?.sentence}{" "}
          <Link to="/papers/statement" className="font-medium text-accent underline-offset-2 hover:underline">
            Payment statement
          </Link>
        </p>
      )}
      <JustPaid own={own} />
      <ThresholdCard s={research} link={false} className="max-w-prose" />
    </section>
  )
}

/**
 * Money that reached the person this month or last, said once and plainly. It
 * comes from the ledger (the record of what was actually paid, including
 * everything paid before this app existed), and it leaves on its own when the
 * month is two months old; the statement is the record after that.
 */
function JustPaid({ own, now = new Date() }: { own: OwnPapers; now?: Date }) {
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
  const thisMonth = ym(now)
  const lastMonth = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1))
  const recent = own.payments.filter(
    (p) => p.amount > 0 && p.payout_month && (p.payout_month.slice(0, 7) === thisMonth || p.payout_month.slice(0, 7) === lastMonth)
  )
  if (recent.length === 0) return null
  const total = recent.reduce((s, p) => s + p.amount, 0)
  const first = recent[0]
  const [y, m] = (first.payout_month as string).split("-").map(Number)
  const month = new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long" })
  return (
    <p className="max-w-prose text-sm text-fg" data-testid="just-paid">
      <span className="font-medium text-positive">{money(total)}</span> for{" "}
      {recent.length === 1 && first.paper_title ? (
        first.claim_id ? (
          <Link to={`/papers/${first.claim_id}`} className="underline underline-offset-4 hover:text-accent">
            {unshout(first.paper_title)}
          </Link>
        ) : (
          unshout(first.paper_title)
        )
      ) : (
        plural(recent.length, "paper", "papers")
      )}{" "}
      reached you in {month}.
    </p>
  )
}

/**
 * The newest papers on the record that could still be filed, each one click
 * from its claim. The count is My papers' "Not claimed" count; the rows are
 * one per title, so a paper the record holds twice is offered once.
 */
type Unfiled = NonNullable<HomeRecord["unfiled"]>["items"][number]

function UnfiledTable({ unfiled }: { unfiled: NonNullable<HomeRecord["unfiled"]> }) {
  const { count, items } = unfiled
  const rows = items.slice(0, SHOWN)
  const columns: Column<Unfiled>[] = [
    {
      key: "title",
      header: "Paper",
      truncate: true,
      exportValue: (p) => unshout(p.title),
      cell: (p) => <DetailLink kind="paper" id={p.id}>{unshout(p.title)}</DetailLink>,
    },
    {
      key: "venue",
      header: "Journal",
      empty: "Journal not recorded",
      exportValue: (p) => p.venue,
      cell: (p) => (p.venue ? <DetailLink kind="journal" name={p.venue} /> : null),
    },
    { key: "year", header: "Year", exportValue: (p) => p.year, cell: (p) => p.year },
    {
      key: "quartile",
      header: "Quartile",
      empty: "None",
      exportValue: (p) => p.quartile ?? null,
      cell: (p) =>
        p.quartile ? (
          <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"} title="The journal's quartile on the college's record">
            {p.quartile} journal
          </Chip>
        ) : null,
    },
    {
      key: "file",
      header: "File",
      label: "File this paper",
      cell: (p) => (
        <Button asChild>
          <Link to={`/papers/new?publication=${p.id}`} aria-label={`File it: ${unshout(p.title)}`}>
            File it
          </Link>
        </Button>
      ),
    },
  ]
  return (
    <Section title="Papers you can still file">
      <Table
        rows={rows}
        columns={columns}
        getKey={(p) => p.id}
        tools={{ id: "faculty-home-unfiled", title: "Papers you can still file" }}
      />
      <p className="mt-2 text-sm">
        <Link to="/papers?filter=unclaimed" className="text-accent underline-offset-4 hover:underline">
          {count > rows.length ? `View all ${formatCount(count)} unfiled papers` : "View in My papers"}
        </Link>
      </p>
    </Section>
  )
}

type ClaimRow = { claim: Claim; kind: "sent" | "draft" | "moving" }

/**
 * The person's own claims, what needs them first: sent back with the college's
 * reason, drafts never filed, then every claim still moving with how long it
 * has waited. Never which desk holds one.
 */
function ClaimsTable({ own }: { own: OwnPapers }) {
  const { sentBack, drafts, moving, isLoading, claims } = own
  if (isLoading) return <Skeleton className="h-40" />
  const all: ClaimRow[] = [
    ...sentBack.map((claim) => ({ claim, kind: "sent" as const })),
    ...drafts.map((claim) => ({ claim, kind: "draft" as const })),
    ...moving.map((claim) => ({ claim, kind: "moving" as const })),
  ]
  const rows = all.slice(0, SHOWN)
  const text = (r: ClaimRow) => {
    const c = r.claim
    if (r.kind === "sent") return "Sent back to you"
    if (r.kind === "draft") return "Draft"
    const t = { ...c, faculty_stage: stageOfClaim(c), days_waiting: daysOf(c) }
    return `${stageWord(t)} · ${filedSentence(t)}`
  }
  const columns: Column<ClaimRow>[] = [
    {
      key: "paper",
      header: "Paper",
      truncate: true,
      exportValue: (r) => r.claim.paper_title || "Untitled paper",
      cell: ({ claim: c, kind }) => (
        <Link to={kind === "draft" ? `/papers/${c.id}/edit` : `/papers/${c.id}`} className="font-medium text-accent underline-offset-4 hover:underline">
          {unshout(c.paper_title) || (c.doi ? `DOI ${c.doi}` : "Untitled paper")}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Where it is",
      exportValue: text,
      cell: (r) => {
        const c = r.claim
        if (r.kind === "sent") {
          const why = reasonOf(c.status_note)
          return (
            <>
              <p className="font-medium text-caution">Sent back to you</p>
              <p className="text-sm text-fg-muted">
                {why ? (
                  <>
                    <span className="text-fg">The college asked: </span>
                    {why}
                  </>
                ) : (
                  "Open it to see what the college asked for."
                )}
              </p>
            </>
          )
        }
        if (r.kind === "draft") {
          return (
            <p className="text-fg-muted">
              Draft{c.updated_at ? <> · last edited <When iso={c.updated_at} /></> : ""}
            </p>
          )
        }
        const days = daysOf(c)
        const t = { ...c, faculty_stage: stageOfClaim(c), days_waiting: days }
        return (
          <>
            <p>
              {stageWord(t)}
              {" · "}
              {filedSentence(t)}
            </p>
            {days != null && days > SLOW_DAYS && <p className="text-sm text-caution">Taking longer than usual</p>}
            {c.ticket_number?.startsWith("FP-") && <p className="text-sm text-fg-muted">Claim no. {c.ticket_number}</p>}
            <ClaimThresholdNote c={c} mine className="mt-1 text-xs" />
          </>
        )
      },
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      exportKind: "money",
      exportValue: (r) => r.claim.remuneration,
      cell: ({ claim: c, kind }) => {
        if (kind !== "moving") return c.remuneration ? money(c.remuneration) : <span className="text-fg-muted">Not worked out yet</span>
        const view = amountView({ ...c, faculty_stage: stageOfClaim(c), days_waiting: daysOf(c) })
        return view.amount != null ? (
          <>
            {money(view.amount)}
            <span className="block text-xs font-normal text-fg-muted">
              {view.caption}
              {c.remuneration_is_estimate ? ", an estimate" : ""}
            </span>
          </>
        ) : (
          <span className="text-sm font-normal text-fg-muted">{view.note}</span>
        )
      },
    },
    {
      key: "next",
      header: "Next step",
      cell: ({ claim: c, kind }) =>
        kind === "sent" ? (
          <Button asChild>
            <Link to={`/papers/${c.id}#fix`}>Fix this claim</Link>
          </Button>
        ) : kind === "draft" ? (
          <Button asChild>
            <Link to={`/papers/${c.id}/edit`}>Finish and file</Link>
          </Button>
        ) : (
          <span className="text-fg-muted">Nothing needed from you</span>
        ),
    },
  ]
  const more = sentBack.length + drafts.length + moving.length
  return (
    <Section title="Your claims">
      <Table
        rows={rows}
        columns={columns}
        getKey={(r) => `${r.kind}-${r.claim.id}`}
        tools={{ id: "faculty-home-claims", title: "Your claims" }}
        empty={{
          title: claims.length === 0 ? "You have not filed a claim yet" : "Nothing needs you",
          message:
            claims.length === 0
              ? "File a paper with its DOI and PDFs, then follow it here until it is paid."
              : "Nothing is waiting to be paid. Every claim you filed is complete.",
        }}
      />
      <p className="mt-2 text-sm">
        <Link to="/papers/claims" className="text-accent underline-offset-4 hover:underline">
          {more > rows.length ? `View all ${formatCount(more)} claims` : "View all my claims"}
        </Link>
      </p>
    </Section>
  )
}

/**
 * Work somebody has been asked to take on: a task, a colleague to write
 * with, or a research area.
 *
 * Only drawn when there is some. It sits with the claimant's own homework
 * rather than among the papers, and the status is moved here, where it is
 * read -- work nobody could mark as started or finished would be work the
 * head had to chase in person to hear about. It names the other person on a
 * pairing and nothing else: no desk, and no money.
 */
function AssignedToYou({ items, open }: { items: MyAssignment[]; open: number }) {
  return (
    <Section
      title="Assigned to you"
      aria-label="Assigned to you"
      sub={
        open
          ? `${plural(open, "piece", "pieces")} of work you have been asked to take on. Move it along as you go.`
          : "Everything you were asked to do is done."
      }
    >
      <Rows>
        {items.map((a) => (
          <AssignedRow key={a.id} assignment={a} />
        ))}
      </Rows>
    </Section>
  )
}

function AssignedRow({ assignment: a }: { assignment: MyAssignment & { partner_photo_url?: string | null } }) {
  const move = useApiMutation<{ status: AssignmentStatus }, MyAssignment>(
    `/api/hod/assignments/${a.id}`,
    { method: "PATCH", invalidates: [["my-assignments"]] }
  )

  async function changeStatus(status: AssignmentStatus) {
    try {
      await move.mutateAsync({ status })
      const label = STATUSES.find((s) => s.value === status)?.label ?? status
      toast.ok(`“${a.title}” marked ${label.toLowerCase()}`)
    } catch (err) {
      toast.fail(err)
    }
  }

  const done = a.status === "DONE"

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      {a.with_name && (
        <Avatar
          person={{ name: a.with_name, initials: "", photo_url: a.partner_photo_url ?? null }}
          size="md"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          <KindBadge label={a.kind_label} />
          <span className={cn("truncate font-medium", done && "text-fg-muted")}>{a.title}</span>
        </p>
        {(a.with_name || a.due_date) && (
          <p className="mt-0.5 text-sm text-fg-muted">
            {a.with_name && `with ${a.with_name}`}
            {a.with_name && a.due_date && " · "}
            {a.due_date && <Due day={a.due_date} done={done} />}
          </p>
        )}
        {a.notes && <p className="mt-0.5 text-sm text-fg-muted">{a.notes}</p>}
      </div>
      <StatusSelect
        value={a.status}
        title={a.title}
        disabled={move.isPending}
        onChange={(status) => void changeStatus(status)}
      />
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Pieces the other homes (head, officers) still draw for their own papers   */
/* ------------------------------------------------------------------------ */

/** Received this year, received to date, and on the way -- all the claimant's own. */
export function MoneyStrip({ own }: { own: OwnPapers }) {
  const { claims, paymentCount, moving, received, since, thisYear, coming, lastPaidOn } = own
  return (
    <section aria-label="Your money">
      <dl className="grid gap-6 sm:grid-cols-3">
        <Stat
          label="Received this academic year"
          value={money(thisYear)}
          hint={`Since ${sinceLabel(since)}`}
        />
        <Stat
          label="Received to date"
          value={money(received)}
          hint={
            paymentCount
              ? `${paymentCount} payment${paymentCount === 1 ? "" : "s"}${lastPaidOn ? `, latest ${lastPaidOn}` : ""}`
              : claims.length
                ? "Nothing paid out yet"
                : "New account — nothing filed yet"
          }
        />
        <Stat
          label="On the way"
          value={money(coming)}
          hint={
            moving.length
              ? `${moving.length} paper${moving.length === 1 ? "" : "s"} moving${moving.some((c) => c.remuneration_is_estimate) ? " · includes estimates" : ""}`
              : "Nothing filed, so nothing is due"
          }
        />
      </dl>
    </section>
  )
}

/** A paper sent back with its reason, and drafts never filed. Draws nothing when there are none. */
export function NeedsYou({ sentBack, drafts }: { sentBack: Claim[]; drafts: Claim[] }) {
  if (sentBack.length === 0 && drafts.length === 0) return null
  return (
    <section className="space-y-3">
      <div>
        <SectionTitle>Needs you</SectionTitle>
        <Meta className="block">Nothing happens to these until you act on them.</Meta>
      </div>
      <ul className="space-y-2">
        {sentBack.map((c, i) => (
          <li
            key={c.id}
            className="rounded-lg bg-caution-wash p-4 ring-1 ring-inset ring-caution/25"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-caution">Sent back to you</p>
                <p className="mt-0.5 truncate font-medium">{unshout(c.paper_title)}</p>
                {c.status_note && (
                  <p className="mt-1 text-sm text-fg-muted">
                    <span className="text-fg">Why: </span>
                    {c.status_note}
                  </p>
                )}
              </div>
              <Button kind={i === 0 ? "primary" : "default"} asChild>
                <Link to={`/papers/${c.id}`}>Fix this claim</Link>
              </Button>
            </div>
          </li>
        ))}
        {drafts.map((c) => (
          <li key={c.id} className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg-muted">
                Draft{c.updated_at ? <> · last edited <When iso={c.updated_at} /></> : ""}
              </p>
              <p className="mt-0.5 truncate font-medium">{c.paper_title || (c.doi ? `DOI ${c.doi}` : "Untitled paper")}</p>
              {!c.remuneration && (
                <p className="text-sm text-fg-muted">Amount not worked out yet</p>
              )}
            </div>
            <Button asChild>
              <Link to={`/papers/${c.id}/edit`}>Carry on</Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Every paper still moving, drawn as a journey with how long it has waited. */
export function OnTheWay({ moving }: { moving: Claim[] }) {
  if (moving.length === 0) return null
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle>On the way</SectionTitle>
        <Link to="/papers" className="text-sm text-accent hover:underline">
          All your papers
        </Link>
      </div>
      <ul className="grid gap-3 md:grid-cols-2">
        {moving.map((c) => (
          <li key={c.id} className="min-w-0">
            <Link
              to={`/papers/${c.id}`}
              className="panel block p-4 transition-colors hover:bg-hover"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="line-clamp-2 font-medium">{unshout(c.paper_title)}</p>
                  <p className="mt-0.5 truncate text-sm text-fg-muted">
                    {c.journal_title || "Journal not given"}
                    {c.ticket_number ? ` · ${c.ticket_number}` : ""}
                  </p>
                </div>
                <Amount claim={c} />
              </div>
              <ClaimThresholdNote c={c} mine className="mt-2 text-xs" />
              <Journey className="mt-4" stage={stageOfClaim(c)} daysWaiting={daysOf(c)} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The most recent payments from the ledger. */
export function PaidList({ payments }: { payments: Payment[] }) {
  if (payments.length === 0) return null
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle>Paid</SectionTitle>
        <Meta>From the college ledger, newest first</Meta>
      </div>
      <ul className="divide-y divide-line border-y border-line">
        {payments.slice(0, 8).map((p) => {
          const body = (
            <>
              <Wallet className="size-4 shrink-0 text-positive" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{unshout(p.paper_title) || "Payment"}</span>
                {p.journal_title && (
                  <span className="block truncate text-sm text-fg-muted">{p.journal_title}</span>
                )}
              </span>
              <span className="hidden shrink-0 text-sm text-fg-muted sm:block">
                {monthLabel(p.payout_month)}
              </span>
              <span className="shrink-0 font-medium tabular-nums">{money(p.amount)}</span>
            </>
          )
          return (
            <li key={p.id}>
              {p.claim_id ? (
                <Link to={`/papers/${p.claim_id}`} className="row flex items-center gap-4 px-4 py-3">
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-4 px-4 py-3">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {payments.length > 8 && (
        <Meta className="block">
          {payments.length - 8} earlier payment{payments.length - 8 === 1 ? "" : "s"} not shown.
        </Meta>
      )}
    </section>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt>
        <Meta>{label}</Meta>
      </dt>
      <dd className="figure tabular text-figure">{value}</dd>
      {hint && (
        <dd>
          <Meta>{hint}</Meta>
        </dd>
      )}
    </div>
  )
}

export function MoneySkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-3" aria-busy="true" aria-label="Loading your money">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-28 rounded-lg" />
      ))}
    </div>
  )
}

function Amount({ claim }: { claim: Claim }) {
  if (claim.remuneration == null) {
    return <span className="w-24 shrink-0 text-right text-sm leading-snug text-fg-subtle">Not worked out yet</span>
  }
  return (
    <span className={cn("figure shrink-0 text-base", claimStatus(claim) === "PAID" && "text-positive")}>
      {claim.remuneration_is_estimate && <span className="mr-1 text-xs font-normal text-fg-subtle">about</span>}
      {money(claim.remuneration)}
    </span>
  )
}
