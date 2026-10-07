import { firstName, unshout } from "@/lib/names"
import { Link } from "react-router-dom"
import { ArrowRight, FileText, FilePlus2, FileSearch, Plus, Upload, Wallet } from "lucide-react"

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
import { Answer, tieNumbers } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ErrorState, Skeleton, Delayed } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { money } from "@/ui/paper"
import { DetailLink, detailHref } from "@/ui/detail-sheet"
import { Journey, claimStatus, facultyStage } from "@/ui/journey"
import { ClaimTrack } from "@/ui/claim-track"
import { Chip } from "@/ui/chip"
import { DotField, type DotGroup } from "@/ui/dot-field"
import { Stamp } from "@/ui/stamp"
import { cn } from "@/lib/cn"
import { toast } from "@/ui/toast"
import { Due, When } from "@/ui/when"
import { Celebrations } from "@/ui/celebrations"
import { PageHeader } from "@/ui/page-header"
import { Avatar, type PersonBrief } from "@/ui/person"
import { Details, Rows, Section } from "@/ui/section"
import { CompassCard } from "@/pages/compass-parts"
import { EventsOnHome } from "@/pages/home-events"
import { ClaimThresholdNote, ThresholdCard, type ThresholdSummary } from "@/ui/research-threshold"

/**
 * What a faculty member opens the app to find out: is anything needed from
 * me, where are my claims and when does the money come, how is my research
 * going, and what should I do next.
 *
 * The page answers in that order. One sentence first, worked out from the
 * claims and the ledger ("1 claim needs a fix from you; about ₹2,000 is on
 * its way, expected in October"). Then what needs the person, each with the
 * button that does it. Then the money, the claims still moving, the research
 * in one line and a single suggestion. Nothing is drawn as a card inside a
 * card, and celebrations are one quiet line.
 *
 * It never says which desk holds a claim. The college decided that a
 * claimant learns how far a claim has come and how long it has waited, and
 * nothing that would send them to stand in front of one person's office.
 *
 * Its data is four requests the shell starts before this code has arrived
 * (`prefetchHome`), and the record ("/api/me/home") is one light call: the
 * old page waited on the department rank and every paper with every author.
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

/** `/api/discover/next`, the part Home uses. */
type NextThings = {
  people: (PersonBrief & { papers: number; reasons: string[] })[]
  journals: { title: string; quartile: string; colleagues: number; reason: string }[]
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
 * The page's answer in one sentence, worked out from what the page shows.
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

/**
 * Where do I stand, what needs me, what is new -- in that order
 * (docs/ux/22). One sentence answers; the sections below are the work.
 */
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

  const first = firstName(me?.name)
  const rec = home.data
  const empty = !own.isLoading && own.claims.length === 0 && rec?.papers === 0
  const ready = !own.isLoading && (home.data != null || home.isError)
  const sentence = ready
    ? homeSentence({
        sentBack: own.sentBack.length,
        drafts: own.drafts.length,
        moving: own.moving.length,
        coming: own.coming,
        estimate: own.moving.some((c) => c.remuneration_is_estimate),
        approved: own.moving.some((c) => stageOfClaim(c) === "Approved for payment"),
        nextRun: outlook.data?.next_run_label ?? null,
        unfiled: rec?.unfiled?.count ?? null,
        filedAny: own.claims.some((c) => claimStatus(c) !== "DRAFT") || own.paymentCount > 0,
      })
    : null

  return (
    <div className="page space-y-10 pb-16">
      <PageHeader
        title={`${greeting()}${first ? `, ${first}` : ""}`}
        sub={[me?.designation, me?.department].filter(Boolean).join(", ") || undefined}
        spot="spot-home-faculty"
        action={
          <Button asChild>
            <Link to="/papers/new">
              <FilePlus2 />
              File a paper
            </Link>
          </Button>
        }
      />

      <div className="space-y-3">
        {sentence ? (
          <p
            role="status"
            data-testid="home-answer"
            className="display display-xl max-w-[24ch] text-fg sm:max-w-[28ch]"
          >
            {tieNumbers(sentence)}
          </p>
        ) : (
          <Delayed>
            <Skeleton className="h-16 max-w-xl" />
          </Delayed>
        )}
        <Celebrations variant="line" />
      </div>

      {empty && <FirstSteps />}

      <JustPaid own={own} />

      <NeedsYouSection own={own} assigned={assigned.data ?? []} />

      {rec?.unfiled && rec.unfiled.count > 0 && <UnfiledPapers unfiled={rec.unfiled} />}

      <MoneySection own={own} outlook={outlook.data} />

      <OnTheWaySection own={own} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-2">
        <ResearchSection rec={rec} failed={home.isError} onRetry={() => void home.refetch()} />
        <div className="space-y-10">
          <Suggestion />
          <CompassCard variant="home" />
        </div>
      </div>

      {/* After the jobs: what is on at the college, and what colleagues have published. Each hides when it has nothing to say. */}
      <EventsOnHome />
    </div>
  )
}

/**
 * The end of the journey (peak-end): money that reached the person this month
 * or last is said once, plainly, with the college's own mark for a payment.
 * The Stamp is the app's one authored moment and "Pay" is one of the four
 * decisions it stands for. It comes from the ledger (the record of what was
 * actually paid, including everything paid before this app existed), and it
 * leaves on its own when the month is two months old; the statement is the
 * record after that. Nothing to dismiss, nothing asked in return.
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
  const when = new Date(y, m - 1, 1)
  const month = when.toLocaleDateString("en-IN", { month: "long" })
  return (
    <section aria-label="Paid" className="flex flex-wrap items-center gap-x-6 gap-y-3" data-testid="just-paid">
      <Stamp verb="Paid" date={when.toLocaleDateString("en-IN", { month: "short", year: "numeric" })} className="shrink-0" />
      <p className="min-w-0 max-w-prose text-base text-fg">
        {recent.length === 1 && first.paper_title ? (
          <>
            <span className="font-medium">{money(total)}</span> for{" "}
            {first.claim_id ? (
              <Link to={`/papers/${first.claim_id}`} className="underline underline-offset-4 hover:text-accent">
                {unshout(first.paper_title)}
              </Link>
            ) : (
              unshout(first.paper_title)
            )}{" "}
            reached you in {month}.
          </>
        ) : (
          <>
            <span className="font-medium">{money(total)}</span> for {plural(recent.length, "paper", "papers")} reached you in{" "}
            {month}.
          </>
        )}{" "}
        <Link to="/papers/statement" className="whitespace-nowrap text-accent hover:underline">
          See your payment statement
        </Link>
      </p>
    </section>
  )
}

/** What is asked of the person: sent-back claims, drafts, and work their head set. */
function NeedsYouSection({ own, assigned }: { own: OwnPapers; assigned: MyAssignment[] }) {
  const { sentBack, drafts, isLoading } = own
  if (isLoading) {
    return (
      <Delayed>
        <Skeleton className="h-24" />
      </Delayed>
    )
  }
  const open = assigned.filter((a) => a.status !== "DONE")
  // Nothing to do is said once, by the sentence at the top; an empty
  // "Needs you" heading under it would say it a second time.
  if (sentBack.length === 0 && drafts.length === 0 && assigned.length === 0) return null
  return (
    <div className="space-y-10">
      {(sentBack.length > 0 || drafts.length > 0) && (
        <Section title="Needs you" aria-label="Needs you" data-area="record">
          <Rows>
            {sentBack.map((c) => {
              const why = reasonOf(c.status_note)
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-caution">Sent back to you</p>
                    <p className="mt-0.5 line-clamp-2 text-base font-medium">{unshout(c.paper_title)}</p>
                    <p className="mt-1 max-w-prose text-sm text-fg-muted">
                      {why ? (
                        <>
                          <span className="text-fg">The college asked: </span>
                          {why}
                        </>
                      ) : (
                        "Open it to see what the college asked for."
                      )}
                    </p>
                  </div>
                  <Button kind="primary" asChild>
                    <Link to={`/papers/${c.id}#fix`}>
                      Fix this claim
                      <ArrowRight />
                    </Link>
                  </Button>
                </li>
              )
            })}
            {drafts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                  <div className="min-w-0">
                    <p className="text-sm text-fg-muted">
                      Draft{c.updated_at ? <> · last edited <When iso={c.updated_at} /></> : ""}
                    </p>
                    <p className="font-medium">{c.paper_title || (c.doi ? `DOI ${c.doi}` : "Untitled paper")}</p>
                  </div>
                </div>
                <Button asChild>
                  <Link to={`/papers/${c.id}/edit`}>Finish and file</Link>
                </Button>
              </li>
            ))}
          </Rows>
        </Section>
      )}
      {assigned.length > 0 && <AssignedToYou items={assigned} open={open.length} />}
    </div>
  )
}

/**
 * The newest papers on the record that could still be filed, each one click
 * from its claim. The count is My papers' "Not claimed" count; the rows are
 * one per title, so a paper the record holds twice is offered once.
 */
function UnfiledPapers({ unfiled }: { unfiled: NonNullable<HomeRecord["unfiled"]> }) {
  const { count, items } = unfiled
  return (
    <Section
      title="Papers you can still file"
      action={
        <Button kind="default" size="sm" asChild>
          <Link to="/papers?filter=unclaimed">
            {count > items.length ? `All ${formatCount(count)} unfiled papers` : "Open in My papers"}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      }
    >
      <Rows>
        {items.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 font-medium">
                <DetailLink kind="paper" id={p.id}>
                  {unshout(p.title)}
                </DetailLink>
              </p>
              <p className="truncate text-sm text-fg-muted">
                {p.venue && <DetailLink kind="journal" name={p.venue} />}
                {p.venue && p.year ? ", " : ""}
                {p.year}
                {!p.venue && !p.year && "Journal not recorded"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {p.quartile && (
                <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"} title="The journal's quartile on the college's record">
                  {p.quartile} journal
                </Chip>
              )}
              <Button asChild>
                <Link to={`/papers/new?publication=${p.id}`}>File it</Link>
              </Button>
            </div>
          </li>
        ))}
      </Rows>
    </Section>
  )
}

/** Money as three figures, each a link, and when the next payment run is. */
function MoneySection({ own, outlook }: { own: OwnPapers; outlook: PayoutOutlook | undefined }) {
  const { thisYear, coming, received, since, paymentCount, lastPaidOn, moving, research, isLoading } = own
  const load = isLoading
  return (
    <Section
      title="Your money"
      aria-label="Your money"
      action={
        <Button kind="default" size="sm" asChild>
          <Link to="/papers/statement">Payment statement</Link>
        </Button>
      }
    >
      <Answer className="max-sm:grid-cols-1"
        items={[
          {
            value: load ? null : money(received),
            label: paymentCount
              ? `paid to you so far, ${plural(paymentCount, "payment", "payments")}${lastPaidOn ? `, latest ${lastPaidOn}` : ""}`
              : "paid to you so far",
            to: "/papers/statement",
          },
          {
            value: load ? null : money(thisYear),
            label: `paid since ${sinceLabel(since)}`,
            // The statement is by financial year, so this opens the year that
            // date falls in: one click from the figure to the lines behind it.
            to: `/papers/statement?fy=${since.getMonth() >= 3 ? since.getFullYear() : since.getFullYear() - 1}`,
          },
          {
            value: load ? null : money(coming),
            label: moving.length ? `on its way, from ${plural(moving.length, "claim", "claims")}` : "on its way, nothing is waiting to be paid",
            to: "/papers/claims",
          },
        ]}
      />
      {outlook?.sentence && (
        <Details label="when the next payment is" className="mt-3">
          <p className="max-w-prose text-sm text-fg-muted">{outlook.sentence}</p>
        </Details>
      )}
      <ThresholdCard s={research} link={false} className="mt-4 max-w-prose" />
    </Section>
  )
}

/** Claims still moving: the longest-waiting first, four at most, the rest one click away. */
function OnTheWaySection({ own }: { own: OwnPapers }) {
  const { moving, isLoading } = own
  if (isLoading || moving.length === 0) return null
  const shown = moving.slice(0, 4)
  return (
    <Section
      title="Claims on the way"
      action={
        <Button kind="default" size="sm" asChild>
          <Link to="/papers/claims">
            {moving.length > shown.length ? `All ${formatCount(moving.length)} on the way` : "My claims"}
          </Link>
        </Button>
      }
    >
      <Rows>
        {shown.map((c) => {
          const days = daysOf(c)
          const t = { ...c, faculty_stage: stageOfClaim(c), days_waiting: days }
          const view = amountView(t)
          const slow = days != null && days > SLOW_DAYS
          return (
            <li key={c.id}>
              <Link
                to={`/papers/${c.id}`}
                className="row -mx-2 block rounded-control px-2 py-4"
              >
                <span className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <span className="line-clamp-2 min-w-0 flex-1 font-medium">{unshout(c.paper_title)}</span>
                  <span className="shrink-0 text-right">
                    {view.amount != null ? (
                      <>
                        <span className="figure block">{money(view.amount)}</span>
                        <span className="block text-xs text-fg-muted">
                          {view.caption}
                          {c.remuneration_is_estimate ? ", an estimate" : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-sm text-fg-subtle">{view.note}</span>
                    )}
                  </span>
                </span>
                <ClaimTrack stage={stageOfClaim(c)} filedOn={c.submitted_at} size="sm" className="mt-3 max-w-lg" />
                <span className="mt-2 block text-sm text-fg-muted">
                  {stageWord(t)}
                  {" · "}
                  {filedSentence(t)}
                  {slow && <span className="text-caution">{" · "}Taking longer than usual</span>}
                  {c.ticket_number?.startsWith("FP-") ? ` · Claim no. ${c.ticket_number}` : ""}
                </span>
                <ClaimThresholdNote c={c} mine className="mt-1 text-xs" />
              </Link>
            </li>
          )
        })}
      </Rows>
    </Section>
  )
}

/** The one paper count, the same as My papers and My research, and two figures beside it. */
function ResearchSection({
  rec,
  failed,
  onRetry,
}: {
  rec: HomeRecord | undefined
  failed: boolean
  onRetry: () => void
}) {
  return (
    <Section
      title="Your research"
      action={
        <Button kind="default" size="sm" asChild>
          <Link to="/research">My research</Link>
        </Button>
      }
    >
      {failed ? (
        <p role="alert" className="text-sm text-fg-muted">
          Could not load your record. Nothing has been lost — your papers and payments are safe.{" "}
          <button type="button" onClick={onRetry} className="font-medium text-accent underline underline-offset-2">
            Try again
          </button>
        </p>
      ) : !rec ? (
        <Delayed>
          <Skeleton className="h-16" />
        </Delayed>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <Fact to="/papers" metric="papers" value={rec.papers} label={rec.papers === 1 ? "paper" : "papers"} />
            <Fact to="/research#citations" metric="citations" value={rec.citations} label="citations" />
            <Fact to="/research#metrics" metric="h_index" value={rec.h_index} label="h-index" />
          </p>
          {rec.quartiles && rec.papers > 0 && (
            <DotField
              className="mt-5"
              dot={9}
              max={160}
              unit="papers"
              groups={([
                { key: "q1", label: "in Q1 journals", count: rec.quartiles.Q1, tone: "gold", to: detailHref({ kind: "metric", metric: "quartile", value: "Q1" }) },
                {
                  key: "q2-4",
                  label: "in Q2 to Q4 journals",
                  count: rec.quartiles.Q2 + rec.quartiles.Q3 + rec.quartiles.Q4,
                  tone: "navy",
                },
                { key: "other", label: "with no quartile", count: rec.quartiles.none, tone: "slate", to: "/papers?quartile=none" },
              ] as DotGroup[]).filter((g) => g.count > 0)}
            />
          )}
          {rec.citations == null && rec.papers > 0 && (
            <p className="mt-2 max-w-prose text-sm text-fg-muted">
              We are still matching you to your Scopus profile, so citations are not shown yet.{" "}
              <Link to="/me" className="font-medium text-accent underline-offset-2 hover:underline">
                Check my profile
              </Link>
            </p>
          )}
        </>
      )}
    </Section>
  )
}

function Fact({ to, metric, value, label }: { to: string; metric: string; value: number | null; label: string }) {
  // A known number opens the papers behind it; one not known yet still goes
  // to the page that explains why.
  if (value)
    return (
      <DetailLink kind="metric" metric={metric} label={`${formatCount(value)} ${label}`} className="group">
        <span aria-hidden className="figure text-figure underline decoration-dotted decoration-fg-subtle decoration-1 underline-offset-[6px] group-hover:decoration-solid">
          {formatCount(value)}
        </span>{" "}
        <span aria-hidden className="text-sm text-fg-muted group-hover:text-fg">
          {label}
        </span>
      </DetailLink>
    )
  return (
    <Link to={to} aria-label={value == null ? `${label}: not known yet` : `${formatCount(value)} ${label}`} className="group">
      <span aria-hidden className="figure text-figure">
        {value == null ? "–" : formatCount(value)}
      </span>{" "}
      <span aria-hidden className="text-sm text-fg-muted group-hover:text-fg">
        {label}
      </span>
    </Link>
  )
}

/**
 * One suggestion, not a feed: the colleague the college's own record says is
 * the best person to write with, or failing that a journal colleagues use.
 * More is one click away on Who to work with. Draws nothing when the record
 * has nothing to go on, or when the request fails: a suggestion is never
 * worth an error box on the page everyone lands on.
 */
function Suggestion() {
  const q = useApi<NextThings>(["discover", "next"], "/api/discover/next", { retry: false })
  const person = q.data?.people?.[0]
  const journal = q.data?.journals?.[0]
  if (!person && !journal) return null
  return (
    <Section
      title="Something to try next"
      action={
        <Button kind="default" size="sm" asChild>
          <Link to="/collaborate">Who to work with</Link>
        </Button>
      }
    >
      {person ? (
        <div className="flex items-start gap-3">
          <Avatar person={person} size="lg" />
          <div className="min-w-0">
            <p className="text-base">
              Write with{" "}
              <Link to={`/u/${person.id}`} className="font-medium underline-offset-4 hover:underline">
                {person.name}
              </Link>
            </p>
            <p className="text-sm text-fg-muted">
              {[person.designation, person.department].filter(Boolean).join(", ")}
              {person.papers ? ` · ${plural(person.papers, "recent paper", "recent papers")}` : ""}
            </p>
            {person.reasons[0] && <p className="mt-1 text-sm text-fg-muted">{person.reasons[0]}</p>}
          </div>
        </div>
      ) : journal ? (
        <div>
          <p className="text-base">
            Aim for <span className="font-medium">{journal.title}</span>
            {journal.quartile ? ` (${journal.quartile})` : ""}
          </p>
          <p className="mt-1 text-sm text-fg-muted">{journal.reason}</p>
        </div>
      ) : null}
    </Section>
  )
}

/** The three steps, for somebody who has filed nothing yet. */
function FirstSteps() {
  const steps = [
    { icon: FileSearch, title: "Paste the DOI", text: "Most of the claim fills itself in from the paper's record." },
    { icon: Upload, title: "Attach the PDFs", text: "The published article and the cited references with the college's affiliation." },
    { icon: FilePlus2, title: "Send it and watch", text: "You see how far it has come and how long it has waited, until it is paid." },
  ]
  return (
    <section className="panel-lead p-6 sm:p-8">
      <h2 className="text-lg font-semibold">File your first paper</h2>
      <p className="mt-1 max-w-prose text-fg-muted">About five minutes, with the DOI and the PDFs to hand.</p>
      <ol className="mt-6 grid gap-6 sm:grid-cols-3">
        {steps.map(({ icon: Icon, title, text }, i) => (
          <li key={title} className="flex gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-wash text-sm font-semibold text-accent">
              {i + 1}
            </span>
            <div>
              <p className="flex items-center gap-1.5 font-medium">
                <Icon className="size-4 text-fg-subtle" aria-hidden />
                {title}
              </p>
              <p className="mt-0.5 text-sm text-fg-muted">{text}</p>
            </div>
          </li>
        ))}
      </ol>
      <Button kind="primary" size="lg" asChild className="mt-7">
        <Link to="/papers/new">
          <Plus />
          File your first paper
        </Link>
      </Button>
    </section>
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
    <section
      aria-label="Your money"
      className="grid gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line sm:grid-cols-3"
    >
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
        {sentBack.map((c) => (
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
              <Button kind="primary" asChild>
                <Link to={`/papers/${c.id}`}>
                  Fix this claim
                  <ArrowRight />
                </Link>
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
      <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
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
    <div className="bg-surface p-5">
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="figure mt-1 text-2xl">{value}</p>
      {hint && <p className="mt-1 text-sm text-fg-muted">{hint}</p>}
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
