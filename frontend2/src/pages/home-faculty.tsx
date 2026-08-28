import { Link } from "react-router-dom"
import { motion } from "motion/react"
import { AlertTriangle, ArrowUpRight, Plus } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { ErrorState, Skeleton } from "@/ui/state"
import { Figure, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { money, Stage, stageOf } from "@/ui/paper"
import { cn } from "@/lib/cn"

/**
 * What a claimant opens the app to find out.
 *
 * 499 of the 525 accounts are faculty, and the question every one of them
 * arrives with is a version of "where is my money, and is anything stuck".
 * A bare "On the way ₹1,05,000" does not answer it — it is a number with no
 * *when* attached, and somebody who has waited three weeks reads exactly the
 * same sentence they read three weeks ago. So the money in flight is the one
 * raised region on the page, and it carries, per paper, the desk holding it
 * and how long it has sat there. That is the whole of what the record knows
 * about "when", and saying it is better than implying a date nothing here can
 * keep.
 *
 * Two things this page must never do, both about a number that is somebody's
 * livelihood: show figures computed from an empty list while the request is
 * still in flight, and show a true-but-bare ₹0 with nothing beside it saying
 * which kind of zero it is.
 *
 * Anything that needs them comes before anything that does not: a draft they
 * never filed and a ticket sent back for changes are the only two things on
 * this page that are somebody's homework, so they are called out above the
 * list rather than left to be found in it.
 */

type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  status: string
  remuneration: number | null
  remuneration_is_estimate: boolean
  calc_error: string | null
  waiting_days: number | null
  publication_year: number | null
  updated_at: string | null
  paid_at: string | null
}

type Payload = { results: Claim[]; total: number }

// The staff queues (`clearing.tsx`, `approvals.tsx`) flag a ticket that has
// stood at one desk for more than a week. The person waiting for the money
// deserves the same fact about their own claim rather than having to guess
// what "normal" looks like, so the threshold is the same number here.
const SLOW_DAYS = 7

/**
 * Who is holding it, in two words.
 *
 * `stageOf().who` is a whole sentence written for the ticket page ("Waiting
 * for the Principal to approve it."), which is right there and wrong in a row
 * repeated eight times down a panel. Same desks, said short. Keyed by status
 * rather than by stage so the imported legacy statuses resolve too.
 */
const DESK: Record<string, string> = {
  SUBMITTED: "the research cell",
  HOD_APPROVED: "the research cell",
  CLEARED: "the Principal",
  RESEARCH_APPROVED: "the Principal",
  PRINCIPAL_APPROVED: "the Director",
  DIRECTOR_APPROVED: "Finance",
  FINANCE_APPROVED: "Finance",
}

// Past the point where the amount has been agreed rather than merely
// proposed. Read off the stage, so the legacy statuses come with it.
const AGREED = new Set(["Approved", "Authorised"])

function dayCount(days: number): string {
  if (days <= 0) return "arrived today"
  if (days === 1) return "1 day at this desk"
  return `${days} days at this desk`
}

function onDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

export function FacultyHome() {
  const { me } = useAuth()
  const { data, isLoading, isError, refetch } = useApi<Payload>(
    ["my-claims"],
    "/api/claims?limit=200"
  )

  const claims = data?.results || []
  const paid = claims.filter((c) => c.status === "PAID")
  // Everything that is actually moving, read off `stageOf` rather than off a
  // second list of statuses maintained here. The old list left SUBMITTED out,
  // so a paper filed yesterday counted as neither "on the way" nor "needs
  // you" and the top of the page said nothing whatsoever about it; it also
  // did not know the imported ERP statuses, which `stageOf` does.
  const inFlight = claims
    .filter((c) => stageOf(c.status).tone === "progress")
    // Longest wait first: the one somebody is worried about is the one that
    // has not budged, not the one they filed this morning.
    .sort((a, b) => (b.waiting_days ?? -1) - (a.waiting_days ?? -1))
  const needsYou = claims.filter((c) => c.status === "DRAFT" || c.status === "REJECTED")
  // Whatever is not already called out above. Newest first, because a
  // settled paper from two years ago is not what somebody came to look at.
  const needsIds = new Set(needsYou.map((c) => c.id))
  const rest = claims
    .filter((c) => !needsIds.has(c.id))
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
  const received = paid.reduce((s, c) => s + (c.remuneration || 0), 0)
  const lastPaidOn = onDate(
    paid
      .map((c) => c.paid_at)
      .filter((d): d is string => Boolean(d))
      .sort()
      .pop()
  )

  const firstName = (me?.name || "").replace(/^(Dr|Mr|Ms|Mrs|Prof)\.?\s*/i, "").split(" ")[0]

  // A failed request is not an empty record.
  //
  // Without this the page rendered "0 papers on record", "Received ₹0", and
  // "Nothing filed yet. File your first paper." to somebody with twenty
  // papers and a year of payments behind them, because `isError` was never
  // read and `data?.results || []` turns any failure into an empty list. This
  // is the highest-traffic screen in the app and 499 of 508 accounts land on
  // it. Telling one of them their money is gone is the worst thing this
  // application can do with a dropped request.
  if (isError) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Could not load your record"
          message="The server did not answer. Nothing has been lost — your papers and payments are safe."
          onRetry={() => void refetch()}
        />
      </div>
    )
  }

  return (
    <div className="page space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>{firstName ? `Hello, ${firstName}` : "Your papers"}</PageTitle>
          <Sub className="mt-1">
            {isLoading
              ? "Loading your record…"
              : `${claims.length} paper${claims.length === 1 ? "" : "s"} on record`}
          </Sub>
        </div>
        <Button kind="primary" asChild>
          <Link to="/papers/new">
            <Plus />
            File a paper
          </Link>
        </Button>
      </header>

      {/* The money question, answered before anything else is shown — and
          never answered from an empty list while the answer is still in the
          post. "Received to date ₹0" as a loading placeholder is a sentence
          about somebody's livelihood that happens to be false for a second. */}
      {isLoading ? (
        <MoneySkeleton />
      ) : inFlight.length > 0 ? (
        <div className="space-y-8">
          <OnTheWay claims={inFlight} />
          <section className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
            <Stat
              label="Received to date"
              value={money(received)}
              hint={receivedHint(paid.length, claims.length, lastPaidOn)}
            />
            <Stat label="Needs you" value={String(needsYou.length)} hint={needsHint(needsYou)} />
          </section>
        </div>
      ) : (
        <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
          <Stat
            label="Received to date"
            value={money(received)}
            hint={receivedHint(paid.length, claims.length, lastPaidOn)}
          />
          <Stat
            label="On the way"
            value={money(0)}
            hint={comingHint(claims.length, paid.length, needsYou.length)}
          />
          <Stat label="Needs you" value={String(needsYou.length)} hint={needsHint(needsYou)} />
        </section>
      )}

      {needsYou.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-2"
        >
          <SectionTitle>Waiting on you</SectionTitle>
          <Meta className="block">
            Nothing happens to these until you send them — nobody else can see a draft.
          </Meta>
          <ul className="divide-y divide-line border-y border-line">
            {needsYou.map((c) => (
              <PaperRow key={c.id} claim={c} />
            ))}
          </ul>
        </motion.section>
      )}

      {/* The rest. When everything you have is already called out above,
          this repeats the list under a second heading and says nothing —
          so it is not drawn. */}
      <section className={cn("space-y-2", !isLoading && !rest.length && "hidden")}>
        <div className="flex items-baseline justify-between gap-3">
          <SectionTitle>{needsYou.length ? "Everything else" : "Your papers"}</SectionTitle>
          {rest.length > 12 && (
            <Link
              to="/papers"
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              See all {claims.length}
            </Link>
          )}
        </div>

        {isLoading ? (
          <ul className="divide-y divide-line border-y border-line">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="h-[3.25rem] animate-pulse bg-sunken" />
            ))}
          </ul>
        ) : rest.length === 0 ? (
          <div className="border-y border-line py-14 text-center">
            <p className="text-base">Nothing filed yet.</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-fg-muted">
              File a paper and it goes to the research cell to be checked, then to the
              Principal to approve, then to the Director to authorise, and Finance pays it
              after that.
            </p>
            <Button kind="primary" asChild className="mt-4">
              <Link to="/papers/new">
                <Plus />
                File your first paper
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {rest.slice(0, 12).map((c) => (
              <PaperRow key={c.id} claim={c} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The sentence under each number                                            */
/* ------------------------------------------------------------------------ */

/**
 * "Received to date ₹0" beside "1 paper on record" reads as an office that
 * has never paid anybody. The figure is true either way; what changes is
 * whether the reader can tell "you are new here" from "my money did not
 * arrive", and only the sentence under it can say which.
 */
function receivedHint(payments: number, papers: number, lastOn: string | null): string {
  if (payments > 0) {
    const n = `${payments} payment${payments === 1 ? "" : "s"}`
    return lastOn ? `${n} · most recent on ${lastOn}` : n
  }
  if (papers > 0) {
    return "Nothing paid out yet — the first payment shows here once Finance settles it."
  }
  return "New account — nothing filed, so nothing has been paid."
}

/** Only reached when nothing is travelling, so every branch is a different
 *  reason for the same ₹0 and the reader should not have to work out which
 *  one is theirs. */
function comingHint(papers: number, payments: number, homework: number): string {
  if (papers === 0) return "Nothing filed, so nothing is due."
  if (payments === papers) return "Everything you have filed has been paid."
  if (homework === papers) return "A draft is not in the chain until you file it."
  return "Nothing is moving through the chain right now."
}

function needsHint(needsYou: { status: string }[]): string {
  if (!needsYou.length) return "Nothing waiting on you"
  const drafts = needsYou.filter((c) => c.status === "DRAFT").length
  const back = needsYou.length - drafts
  const parts: string[] = []
  if (drafts) parts.push(`${drafts} draft${drafts === 1 ? "" : "s"} to finish`)
  if (back) parts.push(`${back} sent back for changes`)
  return parts.join(" · ")
}

/* ------------------------------------------------------------------------ */
/* Money in flight — the one region on the page that carries the answer      */
/* ------------------------------------------------------------------------ */

/**
 * Where the money actually is, paper by paper.
 *
 * This is the page's one `.panel-lead`: when there is money in the chain it
 * is the single thing the reader came for, and when there is none it is not
 * drawn at all rather than becoming an accent-tinted box announcing ₹0.
 *
 * The total on its own was the complaint. A claimant cannot act on it, cannot
 * tell whether it is moving, and cannot tell which of three papers is the one
 * that has not budged since March. The desk and the days are what turn the
 * figure back into something a person can chase.
 */
function OnTheWay({ claims }: { claims: Claim[] }) {
  const total = claims.reduce((s, c) => s + (c.remuneration || 0), 0)
  const unpriced = claims.filter((c) => c.remuneration == null).length
  const agreed = claims
    .filter((c) => AGREED.has(stageOf(c.status).step ?? ""))
    .reduce((s, c) => s + (c.remuneration || 0), 0)
  const slow = claims.filter((c) => (c.waiting_days ?? 0) > SLOW_DAYS)
  const shown = claims.slice(0, 4)

  return (
    <section className="panel-lead p-5 sm:p-6">
      <p className="text-sm text-fg-muted">On the way to you</p>
      <p className="mt-0.5">
        <Figure className="text-3xl">{money(total)}</Figure>
      </p>
      <p className="mt-1 text-sm text-fg-muted">
        {claims.length === 1 ? "1 paper is" : `${claims.length} papers are`} in the chain
        {agreed > 0 && agreed !== total ? `, ${money(agreed)} of it already approved` : ""}.
        {unpriced > 0
          ? ` ${unpriced === 1 ? "One has" : `${unpriced} have`} no amount worked out yet, so ${unpriced === 1 ? "it is" : "they are"} not in that total.`
          : ""}
      </p>

      {slow.length > 0 && (
        // Colour is the second signal and never the only one — the sentence
        // says "more than a week" in words.
        <p className="mt-3 flex items-start gap-2 text-sm text-caution">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {claims.length === 1
              ? "This has been at the same desk for more than a week."
              : `${slow.length === 1 ? "One of these has" : `${slow.length} of these have`} been at the same desk for more than a week. Open the paper to see who has it.`}
          </span>
        </p>
      )}

      <ul className="mt-4 divide-y divide-line border-t border-line">
        {shown.map((c) => (
          // With one paper in the chain the total above *is* this row's
          // amount, and printing ₹1,05,000 twice, one line apart, reads as
          // two separate sums to anybody scanning.
          <InFlightRow key={c.id} claim={c} showAmount={claims.length > 1} />
        ))}
      </ul>

      {claims.length > shown.length && (
        <p className="mt-3">
          <Link to="/papers" className="text-sm text-accent underline-offset-4 hover:underline">
            See all {claims.length} in the chain
          </Link>
        </p>
      )}

      {/* The honest answer to "when". Nothing in the record carries a payment
          date before Finance has the ticket, so the page says what it does
          know — which desks are left — instead of implying a date it cannot
          keep. */}
      <p className="mt-4 text-sm text-fg-muted">
        No payment date is set until Finance has the ticket. A paper is checked, then
        approved, then authorised, and Finance pays it after that.
      </p>
    </section>
  )
}

function InFlightRow({ claim, showAmount }: { claim: Claim; showAmount: boolean }) {
  const stage = stageOf(claim.status)
  const desk = DESK[claim.status]
  const days = claim.waiting_days
  const late = (days ?? 0) > SLOW_DAYS

  return (
    <li className="row">
      <Link to={`/papers/${claim.id}`} className="flex items-start gap-3 px-1 py-2.5 sm:gap-4">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base">{claim.paper_title || "Untitled"}</span>
          <span className={cn("mt-0.5 block text-sm", late ? "text-caution" : "text-fg-muted")}>
            {desk ? `With ${desk}` : stage.label}
            {days == null ? " · time at this desk not recorded" : ` · ${dayCount(days)}`}
          </span>
        </span>
        {showAmount && (
          <span className="shrink-0 text-right">
            <Amount claim={claim} />
          </span>
        )}
      </Link>
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Parts                                                                     */
/* ------------------------------------------------------------------------ */

/** A number that is an answer, with the sentence saying which kind of answer
 *  it is. No box and no border — the label, the weight and the hint do the
 *  work a card was doing. The figure is `<Figure>` from `ui/text` rather than
 *  `text-2xl font-semibold tabular` written out again here, which is how two
 *  figures on one screen end up on different rhythms. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="mt-0.5">
        <Figure>{value}</Figure>
      </p>
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}

/** The shape of the three figures while they are still being fetched.
 *  A skeleton rather than figures computed from an empty list: for the second
 *  or two the request takes, the old page told a claimant owed a lakh that
 *  they had received nothing and had nothing coming. */
function MoneySkeleton() {
  return (
    <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-7 w-32" />
          <Skeleton className="mt-2 h-3 w-40" />
        </div>
      ))}
    </section>
  )
}

/**
 * The amount, and which kind of amount it is.
 *
 * `money(null)` is "—" and `money(0)` is "₹0", and the row used to print
 * neither: it tested the number for truthiness, so a paper worth nothing and
 * a paper not yet priced both came out as an empty cell. Those are three
 * different facts — no figure has been worked out, the policy pays nothing
 * for this one, and here is what you are owed — and a claimant planning
 * around the figure has to be able to tell them apart.
 */
function Amount({ claim }: { claim: Claim }) {
  if (claim.calc_error) {
    return <span className="text-sm text-critical">Could not calculate</span>
  }
  // An estimate of exactly zero is not a zero. It means the journal's metrics
  // are not on record yet, so the formula had nothing to price the paper with
  // — which is "not worked out", not "worth nothing".
  if (claim.remuneration == null || (claim.remuneration === 0 && claim.remuneration_is_estimate)) {
    return <span className="text-sm text-fg-muted">Not worked out yet</span>
  }
  return (
    <>
      <span className="block text-base tabular">{money(claim.remuneration)}</span>
      {claim.remuneration_is_estimate && (
        <span className="block text-xs leading-tight text-caution">Estimate</span>
      )}
      {claim.remuneration === 0 && !claim.remuneration_is_estimate && (
        <span className="block text-xs leading-tight text-fg-muted">No payment due</span>
      )}
    </>
  )
}

function PaperRow({ claim }: { claim: Claim }) {
  const stage = stageOf(claim.status)
  const desk = DESK[claim.status]
  const days = claim.waiting_days
  const late = (days ?? 0) > SLOW_DAYS
  // Who has it, and for how long. The stage word alone ("Checked") names a
  // step in a chain the reader is not obliged to have memorised; the desk
  // names somebody they could ask.
  const detail = desk ? `With ${desk}${days == null ? "" : ` · ${dayCount(days)}`}` : null

  return (
    <li className="row">
      <Link
        to={`/papers/${claim.id}`}
        className="flex items-start gap-3 px-1 py-2.5 sm:gap-4 sm:px-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base">{claim.paper_title || "Untitled"}</span>
          <Meta className="block truncate">
            {[claim.journal_title, claim.publication_year, claim.ticket_number]
              .filter(Boolean)
              .join(" · ")}
          </Meta>
          {/* Below `sm` the stage column is gone, so the stage word moves
              into this line rather than off the screen — a phone showing a
              row with no stage on it is a row that says nothing. */}
          <span
            className={cn(
              "mt-0.5 text-sm",
              detail ? "block" : "block sm:hidden",
              late ? "text-caution" : "text-fg-muted"
            )}
          >
            <span className="sm:hidden">
              {stage.label}
              {detail ? " · " : ""}
            </span>
            {detail}
          </span>
        </span>
        {/* Not hidden below `sm` any more. The amount was desktop-only, so on
            a phone the one question the page exists to answer was missing. */}
        <span className="w-24 shrink-0 text-right">
          <Amount claim={claim} />
        </span>
        <Stage stage={stage} className="hidden w-[7.5rem] shrink-0 sm:block" />
        <ArrowUpRight
          className="reveal hidden size-4 shrink-0 text-fg-subtle sm:block"
          aria-hidden
        />
      </Link>
    </li>
  )
}
