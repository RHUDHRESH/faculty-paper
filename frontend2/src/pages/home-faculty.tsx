import { firstName } from "@/lib/names"
import { Link } from "react-router-dom"
import {
  ArrowRight,

  Check,

  FilePlus2,
  FilePlusCorner,
  FileSearch,
  FileText,
  Hourglass,
  IndianRupee,
  Plus,

  Upload,

  Wallet,
} from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { useApi, useApiMutation } from "@/lib/query"
import {
  KindBadge,
  STATUSES,
  StatusSelect,
  type AssignmentStatus,
  type MyAssignment,
} from "@/pages/assignment-parts"
import { Button } from "@/ui/button"
import { ErrorState, Skeleton } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { money } from "@/ui/paper"
import { Journey, facultyStage } from "@/ui/journey"
import { cn } from "@/lib/cn"
import { toast } from "@/ui/toast"
import { Due, When } from "@/ui/when"
import { Celebrations } from "@/ui/celebrations"
import { Picture, topicPicture } from "@/ui/picture"
import type { RecordPaper } from "@/pages/papers"
import { HeroBand } from "@/ui/hero"
import { HomeSearch } from "@/ui/big-search"
import type { StripMonth } from "@/ui/record-strip"

/**
 * What a claimant opens the app to find out: is my money coming, and is
 * anything waiting on me.
 *
 * The page answers in that order. Money first (never computed from an empty
 * list while the request is in flight), then anything that is the claimant's
 * own homework -- a paper sent back with its reason, a draft never filed --
 * then every paper still moving, drawn as a journey with how long it has
 * waited.
 *
 * It never says which desk holds a paper. The college decided that a
 * claimant learns how far a paper has come and how long it has waited, and
 * nothing that would send them to stand in front of one person's office.
 */

type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  doi?: string | null
  journal_title: string | null
  status: string
  status_note?: string | null
  faculty_stage?: string | null
  days_waiting?: number | null
  remuneration: number | null
  remuneration_is_estimate: boolean
  calc_error: string | null
  waiting_days: number | null
  publication_year: number | null
  updated_at: string | null
  paid_at: string | null
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
}

/** "2025-03" -> "Mar 2025". */
export function monthLabel(ym: string | null | undefined): string | null {
  if (!ym) return null
  const [y, m] = ym.split("-").map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" })
}

const MOVING = new Set(["Submitted", "Under review", "Approved for payment"])

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
  return c.faculty_stage || facultyStage(c.status)
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
  const paid = claims.filter((c) => c.status === "PAID")
  const moving = claims
    .filter((c) => MOVING.has(stageOfClaim(c)))
    .sort((a, b) => (daysOf(b) ?? -1) - (daysOf(a) ?? -1))
  const sentBack = claims.filter((c) => stageOfClaim(c) === "Sent back to you")
  const drafts = claims.filter((c) => c.status === "DRAFT")
  const received = paid.reduce((s, c) => s + (c.remuneration || 0), 0)
  const since = academicYearStart()
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
  }
}

export type OwnPapers = ReturnType<typeof useOwnPapers>

/** `/api/me/summary`: the hero in one call (docs/ux/01). */
export type MySummary = {
  papers: number
  papers_source: "record" | "claims"
  citations: number | null
  h_index: number | null
  dept_rank: { rank: number | null; of: number; dept: string; delta: number | null } | null
  strip: StripMonth[]
  /** null until the publication record exists: the row is hidden, never "0". */
  unclaimed: number | null
  returned: number
  drafts: number
  on_the_way: number
  money: { this_year: number; on_the_way: number; to_date: number }
}

/** "Good morning" before 12:00 IST, "Good afternoon" before 17:00, else "Good evening". */
export function greeting(now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(now)
  )
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
}

/**
 * Where do I stand, what needs me, what is new -- in that order
 * (docs/ux/01). The hero answers the first from `/api/me/summary`; the rest
 * reads the claimant's own papers as before. Money is one row near the foot
 * and never the first thing on the page.
 */
export function FacultyHome() {
  const { me } = useAuth()
  const own = useOwnPapers()
  const summary = useApi<MySummary>(HOME_DATA.mySummary.key, HOME_DATA.mySummary.path)
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
  const empty = !own.isLoading && own.claims.length === 0 && summary.data?.papers === 0

  return (
    <div className="page space-y-8 pb-24 md:pb-0">
      <HomeHero
        name={first}
        department={me?.department ?? null}
        designation={me?.designation ?? null}
        summary={summary.data}
        failed={summary.isError}
        onRetry={() => void summary.refetch()}
      />

      <HomeSearch />

      {empty && <FirstSteps />}

      {/* Moments: hidden when there is nothing to celebrate. */}
      <Celebrations />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <NeedsYouCard own={own} unclaimed={summary.data?.unclaimed ?? null} />
        {own.isLoading ? <Skeleton className="h-48 rounded-2xl" /> : <MoneyCard own={own} />}
      </div>

      {assigned.data && assigned.data.length > 0 && <AssignedToYou items={assigned.data} />}

      <OnTheWay moving={own.moving} />

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/90 p-3 backdrop-blur md:hidden print:hidden">
        <Button kind="primary" size="lg" asChild className="h-11 w-full">
          <Link to="/papers/new">
            <FilePlusCorner />
            File a paper
          </Link>
        </Button>
      </div>
    </div>
  )
}

function HomeHero({
  name,
  department,
  designation,
  summary: s,
  failed,
  onRetry,
}: {
  name: string | null | undefined
  department: string | null
  designation: string | null
  summary: MySummary | undefined
  failed: boolean
  onRetry: () => void
}) {
  const rank = s?.dept_rank
  const sub = [designation, department].filter(Boolean).join(", ")
  const unmatched = s != null && s.citations == null && s.papers > 0
  return (
    <HeroBand
      variant="solid"
      area="record"
      title={`${greeting()}${name ? `, ${name}` : ""}`}
      titleClassName="text-[2.25rem] leading-[1.1] sm:text-[3rem] sm:leading-[1.05] tracking-[-0.01em]"
      sentence={
        failed ? (
          <span role="alert">
            Could not load your record. Nothing has been lost — your papers and payments are safe.{" "}
            <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
              Try again
            </button>
          </span>
        ) : (
          <>
            {sub}
            {unmatched && (
              <span className="mt-1 block text-sm">
                We are still matching you to your Scopus profile — figures may be low.{" "}
                <Link to="/me" className="font-medium underline underline-offset-2">
                  Check my profile
                </Link>
              </span>
            )}
          </>
        )
      }
      actions={
        <Link
          to="/papers/new"
          className="hidden h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover md:inline-flex"
        >
          <FilePlusCorner aria-hidden className="size-5" strokeWidth={1.75} />
          File a paper
        </Link>
      }
      figures={[
        { value: s?.papers, label: s?.papers === 1 ? "paper" : "papers", to: "/papers", countKey: "home-papers" },
        { value: s?.citations, label: "citations", to: "/research#citations", countKey: "home-citations" },
        { value: s?.h_index, label: "h-index", to: "/research#metrics", countKey: "home-h" },
        {
          value: rank?.rank,
          prefix: "#",
          label: rank ? `in ${rank.dept}` : "department rank",
          to: "/leaderboard?dept=mine",
          srLabel: rank?.rank ? `Rank ${rank.rank} of ${rank.of} in ${rank.dept}` : "Department rank not known yet",
          note:
            rank?.delta != null && rank.delta !== 0
              ? `${rank.delta > 0 ? "↑" : "↓"}${Math.abs(rank.delta)} this academic year`
              : undefined,
          countKey: "home-rank",
        },
      ]}
      aside={<Picture name="spot-home-faculty" eager className="-my-4 hidden w-[280px] lg:block xl:w-[320px]" />}
    />
  )
}

/**
 * Returned claims, then drafts, then papers on the record not yet claimed,
 * then what is on the way. One line when there is nothing.
 */
export function NeedsYouCard({ own, unclaimed }: { own: OwnPapers; unclaimed: number | null }) {
  const { sentBack, drafts, moving, isLoading } = own
  const longest = moving.reduce((m, c) => Math.max(m, daysOf(c) ?? 0), 0)
  const count = sentBack.length + drafts.length + (unclaimed ? 1 : 0) + (moving.length ? 1 : 0)
  if (isLoading) return <Skeleton className="h-32 rounded-lg" />
  if (count === 0) {
    return (
      <section aria-label="Needs you" className="panel flex items-center gap-2 px-4 py-3 text-sm text-fg-muted">
        <Check aria-hidden className="size-4 text-positive" />
        Nothing needs you.
      </section>
    )
  }
  return (
    <section aria-label="Needs you" className="panel p-5 sm:p-6" data-area="record">
      <h2 className="text-lg font-semibold">
        Needs you <span className="text-fg-muted">({count})</span>
      </h2>
      <ul className="mt-3 divide-y divide-line">
        {sentBack.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-caution">Sent back to you</p>
              <p className="mt-0.5 truncate font-medium">{c.paper_title}</p>
              {c.status_note && (
                <p className="mt-1 text-sm text-fg-muted">
                  <span className="text-fg">Why: </span>
                  {c.status_note}
                </p>
              )}
            </div>
            <Button kind="primary" asChild>
              <Link to={`/papers/${c.id}/edit`}>
                Fix and send again
                <ArrowRight />
              </Link>
            </Button>
          </li>
        ))}
        {drafts.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-(--area)" />
              <div className="min-w-0">
                <p className="text-sm text-fg-muted">
                  Draft{c.updated_at ? <> · last edited <When iso={c.updated_at} /></> : ""}
                </p>
                <p className="truncate font-medium">{c.paper_title || (c.doi ? `DOI ${c.doi}` : "Untitled paper")}</p>
                {!c.remuneration && <p className="text-sm text-fg-muted">Amount not worked out yet</p>}
              </div>
            </div>
            <Button asChild>
              <Link to={`/papers/${c.id}/edit`}>Carry on</Link>
            </Button>
          </li>
        ))}
        {unclaimed ? <UnfiledPapers count={unclaimed} /> : null}
        {moving.length > 0 && (
          <li className="py-3">
            <Link to="/papers" className="flex items-center gap-2 text-sm text-fg-muted hover:text-fg">
              <Hourglass aria-hidden className="size-4 shrink-0 text-(--area)" />
              {moving.length} {moving.length === 1 ? "paper" : "papers"} on the way
              {longest > 0 && ` · longest ${longest} days`}
            </Link>
          </li>
        )}
      </ul>
    </section>
  )
}

/**
 * The newest papers on the record that could still be filed, each one click
 * from its claim. Shares My papers' request, so opening My papers after Home
 * costs nothing.
 */
function UnfiledPapers({ count }: { count: number }) {
  const q = useApi<{ publications: RecordPaper[] }>(["me-publications", "year"], "/api/me/publications?sort=year")
  const rows = (q.data?.publications ?? []).filter((p) => !p.claim && p.eligible).slice(0, 3)
  return (
    <li className="py-3">
      <p className="text-sm text-fg-muted">
        {count} {count === 1 ? "paper" : "papers"} on your record {count === 1 ? "is" : "are"} not filed yet
      </p>
      {rows.length > 0 && (
        <ul className="mt-3 space-y-1">
          {rows.map((p) => (
            <li key={p.id}>
              <Link
                to={`/papers/new?publication=${p.id}`}
                className="group -mx-2 flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-hover"
              >
                <Picture
                  name={topicPicture(p.title, p.venue) ?? "onboard-first-paper"}
                  className="size-11 shrink-0 rounded-lg bg-hover p-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 font-medium">{p.title}</span>
                  <span className="block truncate text-sm text-fg-muted">
                    {[p.venue, p.year].filter(Boolean).join(", ")}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-medium text-accent group-hover:underline">File</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/papers?filter=unclaimed" className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline">
        {count > rows.length && rows.length > 0 ? `All ${count} unfiled papers` : "Open My papers"}
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </li>
  )
}

/** The claimant's money on one card: paid to date is the headline, the year and what is moving beneath. */
export function MoneyCard({ own }: { own: OwnPapers }) {
  const { thisYear, coming, received, since, paymentCount, lastPaidOn, moving } = own
  return (
    <section aria-label="Your money" className="panel relative overflow-hidden p-5 sm:p-6">
      <Picture name="spot-payouts" className="absolute right-3 top-2 w-28 opacity-95 max-sm:w-20" />
      <h2 className="text-sm text-fg-muted">Paid to you so far</h2>
      <p className="figure mt-1 text-[2rem] leading-tight">{money(received)}</p>
      <p className="mt-1 text-sm text-fg-muted">
        {paymentCount
          ? `${paymentCount} payment${paymentCount === 1 ? "" : "s"}${lastPaidOn ? `, latest ${lastPaidOn}` : ""}`
          : "Nothing paid out yet"}
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4 text-sm">
        <div>
          <dt className="text-fg-muted">Since 1 June {since.getFullYear()}</dt>
          <dd className="figure mt-0.5 text-lg">{money(thisYear)}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">On the way</dt>
          <dd className="figure mt-0.5 text-lg">{money(coming)}</dd>
          {moving.length > 0 && (
            <dd className="text-xs text-fg-subtle">
              {moving.length} paper{moving.length === 1 ? "" : "s"} moving
            </dd>
          )}
        </div>
      </dl>
      <Link to="/papers?filter=paid" className="mt-4 inline-flex text-sm text-accent hover:underline">
        See every payment
      </Link>
    </section>
  )
}

/** Money, compact: one row, linking to My papers. */
export function MoneyRow({ own }: { own: OwnPapers }) {
  const { thisYear, coming, received } = own
  return (
    <section aria-label="Your money" className="panel flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
      <IndianRupee aria-hidden className="size-4 text-fg-subtle" />
      <span>
        <span className="figure">{money(thisYear)}</span> <span className="text-fg-muted">received this year</span>
      </span>
      <span>
        <span className="figure">{money(coming)}</span> <span className="text-fg-muted">on the way</span>
      </span>
      <span>
        <span className="figure">{money(received)}</span> <span className="text-fg-muted">to date</span>
      </span>
      <Link to="/papers" className="ml-auto inline-flex items-center gap-1 text-accent hover:underline">
        My papers
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </section>
  )
}

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
        hint={`Since 1 June ${since.getFullYear()}`}
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
                <p className="mt-0.5 truncate font-medium">{c.paper_title}</p>
                {c.status_note && (
                  <p className="mt-1 text-sm text-fg-muted">
                    <span className="text-fg">Why: </span>
                    {c.status_note}
                  </p>
                )}
              </div>
              <Button kind="primary" asChild>
                <Link to={`/papers/${c.id}/edit`}>
                  Fix and send again
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
                  <p className="line-clamp-2 font-medium">{c.paper_title}</p>
                  <p className="mt-0.5 truncate text-sm text-fg-muted">
                    {c.journal_title || "Journal not given"}
                    {c.ticket_number ? ` · ${c.ticket_number}` : ""}
                  </p>
                </div>
                <Amount claim={c} />
              </div>
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
                <span className="block truncate">{p.paper_title || "Payment"}</span>
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
function AssignedToYou({ items }: { items: MyAssignment[] }) {
  return (
    <section className="space-y-3" aria-label="Assigned to you">
      <div>
        <SectionTitle>Assigned to you</SectionTitle>
        <Meta className="block">Work you have been asked to take on. Move it along as you go.</Meta>
      </div>
      <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
        {items.map((a) => (
          <AssignedRow key={a.id} assignment={a} />
        ))}
      </ul>
    </section>
  )
}

function AssignedRow({ assignment: a }: { assignment: MyAssignment }) {
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
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
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
      <p className="mt-1 max-w-prose text-fg-muted">
        It takes about five minutes if you have the DOI and the PDFs to hand.
      </p>
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
    <span className={cn("figure shrink-0 text-base", claim.status === "PAID" && "text-positive")}>
      {claim.remuneration_is_estimate && <span className="mr-1 text-xs font-normal text-fg-subtle">about</span>}
      {money(claim.remuneration)}
    </span>
  )
}
