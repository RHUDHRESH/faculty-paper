import { firstName, paperTitle } from "@/lib/names"
import { Link } from "react-router-dom"
import { motion } from "motion/react"
import {
  ArrowUpRight,
  FileText,
  Plus,
} from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { HOME_DATA, homeTrack } from "@/app/home-data"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import {
  MoneySkeleton,
  MoneyStrip,
  NeedsYou,
  OnTheWay,
  PaidList,
  useOwnPapers,
} from "@/pages/home-faculty"
import { HomeTrack } from "@/pages/home-track"
import { CellHome } from "@/pages/home-cell"
import { Answer, type AnswerItem } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Section } from "@/ui/section"
import { type Brief, PushList } from "@/pages/principal-parts"
import type { TrackPayload } from "@/pages/track-data"
import { Avatar, initialsOf } from "@/ui/person"
import { Picture } from "@/ui/picture"
import { ComingUp } from "@/ui/coming-up"
import { money, Stage, stageOf } from "@/ui/paper"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * The first screen for everybody who is not a claimant — the research cell, a
 * super admin, the Principal, Finance and a head of department.
 *
 * Four of the six roles in this system used to sign in and land on "Not built
 * yet", which is the worst possible first sentence an app can say to the
 * person who runs it. Each of these answers the one question that role
 * actually arrives with, and nothing else:
 *
 *   office     what is stuck, what is waiting, what moved
 *   principal  what is waiting on me, and what is it worth
 *   finance    what is payable, what does it total, what is blocked
 *   head       what has my department published, and who has not
 *
 * Every figure here is fetched from the same endpoint as the screen it links
 * to, never recomputed from a different one. A home page whose count
 * disagrees with the queue it points at is worse than a home page with no
 * count on it, because the reader cannot tell which of the two is lying.
 */

/* ------------------------------------------------------------------------ */
/* Shared parts                                                              */
/* ------------------------------------------------------------------------ */

export function greeting(name: string | undefined): string {
  const first = firstName(name)
  return first ? `Hello, ${first}` : "Home"
}

/** A number that is an answer, not a tile — same as the faculty home. */
export function Figure({
  label,
  value,
  hint,
  tone,
  muted,
  loading,
}: {
  label: string
  value: string
  hint?: string
  tone?: "critical" | "positive" | "caution"
  muted?: boolean
  loading?: boolean
}) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      {loading ? (
        <Skeleton className="mt-1 h-7 w-24" />
      ) : (
        <p
          className={cn(
            "mt-0.5 text-2xl font-semibold tabular",
            tone === "critical" && "text-critical",
            tone === "positive" && "text-positive",
            tone === "caution" && "text-caution",
            muted && "text-fg-subtle"
          )}
        >
          {value}
        </p>
      )}
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}

/**
 * One queue, as a line you can act on.
 *
 * Deliberately a row and not a card: five bordered boxes down a page is the
 * furniture this app's whole design brief is a reaction against, and a queue
 * with nothing in it should recede rather than sit there in a box demanding
 * the same attention as one with forty tickets waiting.
 */
export function QueueRow({
  icon: Icon,
  label,
  count,
  detail,
  to,
  tone,
  loading,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count: number | null
  detail?: string
  to: string
  tone?: "critical" | "caution"
  loading?: boolean
}) {
  const empty = count === 0

  return (
    <li className="row">
      <Link to={to} className="flex items-center gap-4 px-1 py-3 sm:px-2">
        <Icon
          className={cn(
            "size-4 shrink-0",
            empty ? "text-fg-subtle" : tone === "critical" ? "text-critical" : "text-fg-muted"
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className={cn("block text-base", empty && "text-fg-muted")}>{label}</span>
          {detail && <Meta className="block truncate">{detail}</Meta>}
        </span>
        {loading ? (
          <Skeleton className="h-6 w-10" />
        ) : (
          <span
            className={cn(
              "shrink-0 text-lg font-semibold tabular",
              empty && "text-fg-subtle",
              !empty && tone === "critical" && "text-critical",
              !empty && tone === "caution" && "text-caution"
            )}
          >
            {count === null ? "—" : count.toLocaleString("en-IN")}
          </span>
        )}
        <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
      </Link>
    </li>
  )
}

export type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name?: string | null
  owner_department?: string | null
  status: string
  remuneration: number | null
  updated_at: string | null
  owner_id?: string | null
  owner_photo_url?: string | null
  waiting_days?: number | null
  needs_second_approval?: boolean
}

/**
 * A ticket, in a list on a home page.
 *
 * It carries an amount, so it is only ever rendered on a home that is
 * allowed to show one. `HodHome` deliberately does not use it — the
 * money-blind screen is built out of its own money-free rows rather than out
 * of this one with a flag turned off, because a flag defaulting to "show"
 * is one careless call site away from a leak.
 */
export function ClaimRow({ claim }: { claim: Claim }) {
  return (
    <li className="row">
      <Link to={`/papers/${claim.id}`} className="flex items-center gap-4 px-1 py-2.5 sm:px-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base">{paperTitle(claim.paper_title)}</span>
          <Meta className="block truncate">
            {[claim.owner_name, claim.owner_department, claim.ticket_number]
              .filter(Boolean)
              .join(" · ")}
          </Meta>
        </span>
        <span className="hidden w-24 shrink-0 text-right text-base tabular sm:block">
          {claim.remuneration ? money(claim.remuneration) : ""}
        </span>
        <Stage stage={stageOf(claim.status)} className="w-[7.5rem] shrink-0" />
        <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
      </Link>
    </li>
  )
}

export function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-2"
    >
      {children}
    </motion.section>
  )
}

/**
 * The top of every office home: greeting, the one question this desk answers,
 * and the desk's picture on a wide screen.
 */
export function HomeHead({
  name,
  sentence,
  picture,
  actions,
}: {
  name: string | undefined
  sentence: React.ReactNode
  picture: string
  actions?: React.ReactNode
}) {
  return (
    <header className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <PageTitle>{greeting(name)}</PageTitle>
        <Sub className="mt-1 max-w-xl">{sentence}</Sub>
        {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
      </div>
      <Picture name={picture} eager className="hidden w-[200px] shrink-0 md:block lg:w-[240px]" />
    </header>
  )
}

function daysLabel(n: number | null | undefined): string {
  if (n == null) return ""
  if (n <= 0) return "Today"
  return `${n} ${n === 1 ? "day" : "days"}`
}

/**
 * Work waiting at this desk, oldest first, as rows: the claimant's face, the
 * paper, how long it has waited, and the one thing to do next.
 *
 * The viewer's own claim is never drawn here even if a server ever sent it:
 * somebody at a desk cannot act on their own paper, so a row with an action
 * button on it would be a lie.
 */
export function DeskQueue({
  claims,
  meId,
  action,
  to,
  showMoney = true,
  limit = 6,
}: {
  claims: Claim[]
  meId: string | undefined
  action: string
  to: string
  showMoney?: boolean
  limit?: number
}) {
  const rows = claims
    .filter((c) => !meId || c.owner_id !== meId)
    .slice()
    .sort((a, b) => (b.waiting_days ?? 0) - (a.waiting_days ?? 0))
    .slice(0, limit)
  return (
    <ul className="divide-y divide-line border-y border-line">
      {rows.map((c) => {
        const days = c.waiting_days ?? null
        return (
          <li key={c.id} className="flex items-center gap-3 py-3 sm:gap-4 sm:px-2">
            <Avatar
              size="md"
              person={{
                name: c.owner_name || "",
                initials: initialsOf(c.owner_name),
                photo_url: c.owner_photo_url ?? null,
              }}
            />
            <div className="min-w-0 flex-1">
              <Link
                to={`/papers/${c.id}`}
                className="block truncate text-base font-medium underline-offset-4 hover:underline"
              >
                {paperTitle(c.paper_title)}
              </Link>
              <Meta className="block truncate">
                {[c.owner_name, c.owner_department].filter(Boolean).join(" · ")}
                {showMoney && c.remuneration ? (
                  <span className="sm:hidden"> · {money(c.remuneration)}</span>
                ) : null}
              </Meta>
            </div>
            {showMoney && (
              <span className="hidden w-24 shrink-0 text-right text-base tabular sm:block">
                {c.remuneration ? money(c.remuneration) : ""}
              </span>
            )}
            <span
              className={cn(
                "w-14 shrink-0 text-right text-sm tabular text-fg-muted sm:w-16",
                days != null && days > 30 && "font-medium text-critical",
                days != null && days > 14 && days <= 30 && "text-caution"
              )}
              title={days != null ? `Waiting ${daysLabel(days).toLowerCase()}` : undefined}
            >
              {daysLabel(days)}
            </span>
            <Button size="sm" asChild>
              <Link to={to} aria-label={`${action}: ${paperTitle(c.paper_title)}`}>
                {action}
              </Link>
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

/* ------------------------------------------------------------------------ */
/* The office — research cell and super admin                               */
/* ------------------------------------------------------------------------ */

type StageCounts = {
  counts: {
    all: number
    draft: number
    filed: number
    checked: number
    approved: number
    paid: number
    sent_back: number
  }
}

type FaultsSummary = { total: number; urgent: number; checked_at: string }
type RequestsSummary = { pending: number }
type DuplicatesSummary = { summary: { open: number; at_issue: number } }

/** "Every payment in the ledger since Jan 2024", or nothing without a ledger. */
export function collegeSince(ym: string | null | undefined): string | undefined {
  if (!ym) return undefined
  const [y, m] = ym.split("-").map(Number)
  const d = new Date(y, (m || 1) - 1, 1)
  return `Every payment in the ledger since ${d.toLocaleDateString("en-IN", { month: "short", year: "numeric" })}`
}

/**
 * What is stuck, what is waiting, and what moved.
 *
 * The clearing count comes from `/api/claims/counts` rather than from the
 * length of `/api/admin/clearing-queue`, which is capped at 200 rows — on a
 * backlog of 340 the queue screen says 340 and a count taken from the array
 * would have said 200, on the same page, three lines apart.
 */
export function OfficeHome() {
  const { me } = useAuth()
  // The first desk has its own Home (home-cell.tsx); this one is the super admin's.
  if (me?.role === "RESEARCH_CELL" || me?.role === "RESEARCH_COORDINATOR") return <CellHome />
  return <AdminHome />
}

function AdminHome() {
  const { me } = useAuth()

  const D = HOME_DATA
  const counts = useApi<StageCounts>(D.stageCounts.key, D.stageCounts.path)
  const faults = useApi<FaultsSummary>(D.faults.key, D.faults.path)
  const requests = useApi<RequestsSummary>(D.pendingRequests.key, D.pendingRequests.path)
  const duplicates = useApi<DuplicatesSummary>(D.openDuplicates.key, D.openDuplicates.path)

  const clearing = useApi<Claim[]>(D.clearingQueue.key, D.clearingQueue.path)

  const waiting = counts.data?.counts.filed ?? null
  const isAdmin = me?.role === "SUPER_ADMIN"
  const queueRows = clearing.data ?? []

  // The rest of what waits on the office, said in one line. The super admin's
  // health panel already carries these, so only the desk roles get the line.
  const also = [
    { n: requests.data?.pending ?? 0, one: "profile correction", many: "profile corrections", to: "/requests" },
    { n: duplicates.data?.summary.open ?? 0, one: "possible duplicate payment", many: "possible duplicate payments", to: "/duplicates" },
    { n: faults.data?.total ?? 0, one: "fault", many: "faults", to: "/faults" },
  ].filter((x) => x.n > 0)

  return (
    <div className="page space-y-10">
      <HomeHead
        name={me?.name}
        picture="spot-home-admin"
        sentence={
          isAdmin
            ? "Whether everything is healthy, and what is waiting at the desks."
            : "What is waiting on you to clear, oldest first."
        }
      />

      <Waiting>
        <div className="flex items-baseline justify-between gap-3">
          <SectionTitle>Waiting on you to clear</SectionTitle>
          <Link to="/clearing" className="text-sm text-accent underline-offset-4 hover:underline">
            Open Claims{waiting ? ` (${waiting.toLocaleString("en-IN")})` : ""}
          </Link>
        </div>
        {clearing.isLoading ? (
          <ul className="divide-y divide-line border-y border-line">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="h-[3.75rem] animate-pulse bg-sunken" />
            ))}
          </ul>
        ) : clearing.isError ? (
          <InlineError message="Could not load the clearing queue." onRetry={() => void clearing.refetch()} />
        ) : queueRows.length === 0 ? (
          <div className="flex items-center gap-5 border-y border-line py-6">
            <Picture name="spot-approvals" className="w-24 shrink-0" />
            <p className="text-base text-fg-muted">
              Nothing is waiting to be cleared. A paper appears here the moment a claimant files
              it. Your own papers are cleared by another officer, never by you.
            </p>
          </div>
        ) : (
          <DeskQueue claims={queueRows} meId={me?.id} action="Check" to="/clearing" limit={5} />
        )}
      </Waiting>

      <HomeTrack />

      {!isAdmin && also.length > 0 && (
        <p className="text-base text-fg-muted">
          Also waiting:{" "}
          {also.map((x, i) => (
            <span key={x.to}>
              {i > 0 && (i === also.length - 1 ? " and " : ", ")}
              <Link to={x.to} className="text-accent underline-offset-4 hover:underline">
                {x.n.toLocaleString("en-IN")} {x.n === 1 ? x.one : x.many}
              </Link>
            </span>
          ))}
          .
        </p>
      )}

      {faults.isError && (
        <InlineError
          message="Could not check for faults. The queues above are still accurate."
          onRetry={() => faults.refetch()}
        />
      )}

      {/* The office's work first; an officer's own research after it. */}
      {can(me?.role).fileOwnPapers && <YourPapers />}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The Principal                                                             */
/* ------------------------------------------------------------------------ */

type PrincipalQueue = {
  total: number
  results: Claim[]
  totals: { count: number; amount: number; longest_wait_days: number | null }
}

/**
 * The Principal's Home: what waits on her, then how the year is going.
 *
 * She opens it for two things and neither may cost a scroll. The first is the
 * approval desk, and the wait figure leads there because it is the only one
 * that gets worse by itself: forty claims is the same forty whether they
 * arrived this morning or in March. The second is "are we better than last
 * year?", which the year brief answers in one sentence, so the sentence is
 * here, with the departments that need a call and the way to the council PDF.
 * The rest of the pipeline is one line and a link to Track: it is not hers to
 * work, and a strip of stage counts above her own desk made the page longer
 * than the answer.
 */
export function PrincipalHome() {
  const { me } = useAuth()
  const queue = useApi<PrincipalQueue>(HOME_DATA.principalQueue.key, HOME_DATA.principalQueue.path)
  const brief = useApi<Brief>(["reports-brief", ""], "/api/reports/brief")
  const mine = homeTrack(me?.role)
  const track = useApi<TrackPayload>(mine.key, mine.path)

  const totals = queue.data?.totals
  const waiting = totals?.count ?? null
  const longest = totals?.longest_wait_days ?? null
  const b = brief.data
  const late = track.data ? track.data.stages.reduce((sum, s) => sum + (s.ageing?.older ?? 0), 0) : null

  const items: AnswerItem[] =
    waiting != null && waiting > 0
      ? [
          { value: waiting, label: "waiting for your approval", to: "/approvals" },
          { value: money(totals?.amount), label: "they are worth", to: "/approvals" },
          {
            value: longest == null ? "Today" : `${longest} ${longest === 1 ? "day" : "days"}`,
            label: "the longest has waited",
            tone: longest != null && longest > 30 ? "critical" : "neutral",
            to: "/approvals",
          },
          {
            value: b ? b.push.length : null,
            label: "departments need a push",
            zero: "No department needs a push",
            to: "/reports/departments",
          },
        ]
      : [
          {
            value: waiting,
            label: "waiting for your approval",
            zero: "Nothing is waiting for your approval",
            to: "/approvals",
          },
          { value: b ? b.totals.papers.toLocaleString("en-IN") : null, label: b ? `papers in ${b.year}` : "papers", to: "/reports/brief" },
          { value: b ? String(b.totals.per_teacher ?? "None") : null, label: "papers per teacher", to: "/reports/brief" },
          {
            value: b ? b.push.length : null,
            label: "departments need a push",
            zero: "No department needs a push",
            to: "/reports/departments",
          },
        ]

  return (
    <div className="page space-y-10">
      <HomeHead
        name={me?.name}
        picture="spot-approvals"
        sentence="What waits for your approval, and how the year is going."
      />

      <Answer items={items} />

      {queue.isError ? (
        <InlineError message="Could not load the approval queue." onRetry={() => queue.refetch()} />
      ) : waiting === 0 ? (
        <ComingUp desk="principal" align="start" />
      ) : waiting != null ? (
        <Section
          title="Waiting longest"
          action={
            <Link to="/approvals" className="text-accent underline-offset-4 hover:underline">
              Open the queue ({waiting.toLocaleString("en-IN")})
            </Link>
          }
        >
          <DeskQueue claims={queue.data?.results ?? []} meId={me?.id} action="Approve" to="/approvals" limit={8} />
        </Section>
      ) : null}

      <Section
        title={b ? `The college, ${b.year}` : "The college, last full year"}
        action={
          <Link to="/reports/brief" className="text-accent underline-offset-4 hover:underline">
            Open the year brief
          </Link>
        }
      >
        {b ? (
          <div className="space-y-6">
            <p data-testid="principal-brief-headline" className="max-w-3xl font-serif text-lg leading-snug text-fg">
              {b.headline}
            </p>
            {b.push.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Departments to call about</p>
                <PushList rows={b.push.slice(0, 3)} year={b.year} empty="" />
                <Link to="/reports/departments" className="inline-block text-sm text-accent underline-offset-4 hover:underline">
                  All departments
                </Link>
              </div>
            )}
          </div>
        ) : brief.isError ? (
          <InlineError message="Could not load the year brief." onRetry={() => brief.refetch()} />
        ) : (
          <div className="h-14 max-w-3xl animate-pulse rounded-control bg-sunken" />
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <a href={`/api/reports/brief/export?fmt=pdf${b ? `&year=${b.year}` : ""}`} download>
              <FileText />
              Download council PDF
            </a>
          </Button>
          <Button size="sm" kind="quiet" asChild>
            <Link to="/accreditation">NAAC and NIRF tables</Link>
          </Button>
          <Button size="sm" kind="quiet" asChild>
            <Link to="/budget">Budget</Link>
          </Button>
        </div>
      </Section>

      <p className="text-base text-fg-muted" role="status">
        {late == null
          ? ""
          : late > 0
            ? `${late.toLocaleString("en-IN")} ${late === 1 ? "claim has" : "claims have"} been in one place for over a month. `
            : "Nothing has been in one place for over a month. "}
        <Link to="/track" className="text-accent underline-offset-4 hover:underline">
          Open Track
        </Link>
      </p>

      <YourPapers />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Finance                                                                 */
/* ------------------------------------------------------------------------ */

// Finance's Home is in home-finance.tsx. The budget summary type stays here
// because the Director's Home reads it too.
export type BudgetSummary = {
  financial_year: string
  college: { allocated: number | null; spent: number; committed: number; remaining: number | null }
}


/**
 * The viewer's own papers, on a home whose first job is something else: a
 * head of department's, who is faculty that also heads the department
 * (2026-09-23), and an officer's -- the research cell, the coordinator, the
 * Principal, the Director, Finance -- who is an academic too and "must be
 * able to do both".
 *
 * The same pieces a faculty member's home is built from, so the two cannot
 * drift: their own money, anything sent back to them, and every paper still
 * moving drawn as the claimant's journey — never which desk holds it, even
 * for somebody who sits at one. `/api/claims?mine=1` is theirs alone, and the
 * amounts on it are theirs (`hod.for_head`, `core.visibility`).
 */
export function YourPapers({
  note = "What you have filed yourself. Another officer, or the super admin, decides each one, never you.",
}: {
  note?: string
}) {
  const own = useOwnPapers()
  const { claims, isLoading, isError, refetch } = own

  return (
    <section aria-label="Your own papers" className="space-y-4 border-t border-line pt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionTitle>Your own papers</SectionTitle>
          <Meta className="block">{note}</Meta>
        </div>
        <Button kind="default" asChild>
          <Link to="/papers/new">
            <Plus />
            File a paper
          </Link>
        </Button>
      </div>

      {isError ? (
        // A dropped request is not an empty record: no ₹0 in its place.
        <InlineError
          message="Could not load your papers. Nothing has been lost."
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <MoneySkeleton />
      ) : claims.length === 0 ? (
        <p className="text-base text-fg-muted">
          Nothing filed yet. File a paper and follow it here, as any claimant does.
        </p>
      ) : (
        <>
          <MoneyStrip own={own} />
          <NeedsYou sentBack={own.sentBack} drafts={own.drafts} />
          <OnTheWay moving={own.moving} />
          <PaidList payments={own.payments} />
        </>
      )}
    </section>
  )
}
