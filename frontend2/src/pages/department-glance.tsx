import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { BellRing, Check, Download, FileText, Users } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Avatar, initialsOf } from "@/ui/person"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { TableScroller } from "@/ui/table"
import { Meta, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The head's three questions, answered before anything else on the page:
 * are we on track, who needs a push, who should write with whom. Built on
 * `/api/hod/brief`; the PDF and Excel downloads are the same brief on paper,
 * so what the Principal reads is what the head saw. See docs/jtbd/hod.md.
 */

export type BriefPerson = {
  id: string
  name: string
  designation: string | null
  photo_url: string | null
  is_you: boolean
  this_year: number
  last_year: number
  q1_this_year: number
  led_this_year: number
  total: number
  last_year_published: number | null
  area: string | null
  target: number | null
  last_reminded_at: string | null
}

type Verdict = "met" | "on_track" | "close" | "behind"

export type Brief = {
  department: string
  year: number
  as_of: string
  elapsed: number
  totals: {
    publications: number
    q1: number
    first_author: number
    faculty: number
    faculty_published: number
    per_teacher: number | null
    last_year_full: number
    last_year_to_date: number
    this_year_to_date: number
    rejected_outright: number
    missing_issn_or_doi: number
  }
  targets: {
    metric: string
    label: string
    target: number
    done: number
    expected_by_now: number
    verdict: Verdict
    due_date: string | null
  }[]
  by_year: { year: number; publications: number; q1: number; partial: boolean }[]
  people: BriefPerson[]
  push: { person: BriefPerson; reasons: string[] }[]
  pairs: { mentee: BriefPerson; mentor: BriefPerson; area: string | null; why: string }[]
  years: number[]
}

const VERDICT: Record<Verdict, { text: string; tone: string }> = {
  met: { text: "Met", tone: "text-positive" },
  on_track: { text: "On track", tone: "text-positive" },
  close: { text: "Slightly behind", tone: "text-caution" },
  behind: { text: "Behind", tone: "text-critical" },
}

const DAY = 24 * 60 * 60 * 1000

function face(p: BriefPerson) {
  return { name: p.name, initials: initialsOf(p.name), photo_url: p.photo_url }
}

export function DepartmentGlance({ year }: { year: number }) {
  const brief = useApi<Brief>(["hod", "brief", year], `/api/hod/brief?year=${year}`)

  if (brief.isError) {
    return (
      <ErrorState
        title="Could not load the department at a glance"
        message="The server did not answer."
        onRetry={() => void brief.refetch()}
      />
    )
  }
  if (brief.isLoading || !brief.data) return <SkeletonRows rows={6} rowHeight={48} />
  const b = brief.data

  return (
    <section aria-label="At a glance" className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <SectionTitle>{b.year} at a glance</SectionTitle>
          <Sub className="mt-1">
            Counts of filed papers from {b.department}. Papers the review chain did not accept are
            left out{b.totals.rejected_outright ? ` (${b.totals.rejected_outright} this year)` : ""}.
          </Sub>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button kind="primary" asChild>
            <a href={`/api/hod/report?fmt=pdf&year=${b.year}`} download>
              <FileText />
              Report for the Principal (PDF)
            </a>
          </Button>
          <Button kind="default" asChild>
            <a href={`/api/hod/report?fmt=xlsx&year=${b.year}`} download>
              <Download />
              NBA / NAAC workbook (Excel)
            </a>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <OnTrack b={b} />
        <OutputChart b={b} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <PushList b={b} />
        <Pairs b={b} />
      </div>

      <FacultyTable b={b} />
    </section>
  )
}

/* ---------------- are we on track ---------------- */

function OnTrack({ b }: { b: Brief }) {
  const t = b.totals
  const pct = Math.round(b.elapsed * 100)
  return (
    <div className="panel space-y-5 p-5">
      <h3 className="text-sm font-medium text-fg-muted">Are we on track?</h3>
      {b.targets.length === 0 ? (
        <div className="space-y-2">
          <p className="text-2xl font-semibold tabular-nums">
            {t.this_year_to_date} papers so far
          </p>
          <p className="text-sm text-fg-muted">
            {t.last_year_to_date} by the same date in {b.year - 1}
            {" "}({t.last_year_full} in the whole of {b.year - 1}).{" "}
            {t.this_year_to_date >= t.last_year_to_date
              ? "Ahead of last year's pace."
              : `${t.last_year_to_date - t.this_year_to_date} behind last year's pace.`}
          </p>
          <p className="text-xs text-fg-subtle">
            No department target is set for {b.year}; set one below to judge pace against it.
          </p>
        </div>
      ) : (
        <ul className="space-y-5">
          {b.targets.map((x) => (
            <li key={x.metric} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-sm font-medium">{x.label}</span>
                <span className={cn("text-sm font-medium", VERDICT[x.verdict].tone)}>
                  {VERDICT[x.verdict].text}
                </span>
              </div>
              <PaceBar done={x.done} target={x.target} expected={x.expected_by_now} />
              <p className="text-xs text-fg-muted tabular-nums">
                {x.done} of {x.target}. {pct}% of the year has gone, so about{" "}
                {Math.round(x.expected_by_now)} would be on pace
                {x.done < x.target ? `; ${x.target - x.done} still to go.` : "."}
              </p>
            </li>
          ))}
        </ul>
      )}
      <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
        <Fig label="Papers" value={t.publications} />
        <Fig label="Q1 papers" value={t.q1} />
        <Fig label="Faculty published" value={`${t.faculty_published} of ${t.faculty}`} />
        <Fig label="Per teacher" value={t.per_teacher ?? "–"} />
      </dl>
    </div>
  )
}

function Fig({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

/** Progress with a tick where the calendar says it should be by now. */
function PaceBar({ done, target, expected }: { done: number; target: number; expected: number }) {
  const w = (n: number) => `${Math.min(100, target ? (n / target) * 100 : 0)}%`
  return (
    <div
      className="relative h-2.5 rounded-full bg-sunken"
      role="img"
      aria-label={`${done} of ${target}; about ${Math.round(expected)} expected by now`}
    >
      <div className="h-full rounded-full bg-accent" style={{ width: w(done) }} />
      <div
        className="absolute -top-1 h-4.5 w-0.5 bg-fg"
        style={{ left: w(expected) }}
        title="Where it should be by today"
      />
    </div>
  )
}

/* ---------------- output over time ---------------- */

/**
 * One chart, two quantities that nest (Q1 is part of all papers), so the Q1
 * share is drawn inside each bar rather than as a second series. Numbers are
 * written on the bars; the current year is labelled "so far", never drawn as
 * if it were finished.
 */
function OutputChart({ b }: { b: Brief }) {
  const max = Math.max(1, ...b.by_year.map((r) => r.publications))
  return (
    <figure className="panel space-y-4 p-5">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-fg-muted">Papers per year</h3>
        <span className="flex items-center gap-3 text-xs text-fg-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm bg-accent" /> Q1
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm bg-fg-subtle/40" /> Other
          </span>
        </span>
      </figcaption>
      <div className="flex h-44 items-end gap-3" role="list">
        {b.by_year.map((r) => (
          <div
            key={r.year}
            role="listitem"
            aria-label={`${r.year}${r.partial ? " so far" : ""}: ${r.publications} papers, ${r.q1} Q1`}
            className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
          >
            <span className="text-xs font-medium tabular-nums">{r.publications}</span>
            <div
              className={cn(
                "flex w-full max-w-12 flex-col justify-end overflow-hidden rounded-t-md bg-fg-subtle/40",
                r.partial && "opacity-70"
              )}
              style={{ height: `${(r.publications / max) * 100}%` }}
            >
              <div
                className="w-full bg-accent"
                style={{ height: r.publications ? `${(r.q1 / r.publications) * 100}%` : 0 }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-3 border-t border-line pt-1.5">
        {b.by_year.map((r) => (
          <span key={r.year} className="min-w-0 flex-1 text-center text-xs text-fg-muted tabular-nums">
            {r.year}
            {r.partial && <span className="block text-[11px] text-fg-subtle">so far</span>}
          </span>
        ))}
      </div>
    </figure>
  )
}

/* ---------------- who needs a push ---------------- */

function reminderFor(year: number, reasons: string[]): string {
  const first = reasons[0] ?? ""
  const why = first.startsWith("Nothing")
    ? `nothing from you is on record for ${year} yet.`
    : first.startsWith("No Q1")
      ? "the department is aiming for more Q1 papers, and your next one could be it."
      : "the department is credited with the papers it leads; please consider leading your next one."
  return `A reminder from your head of department: ${why} If a paper is out or under review, please file it. If you are stuck, come and talk to me.`
}

function PushList({ b }: { b: Brief }) {
  const [all, setAll] = useState(false)
  const shown = all ? b.push : b.push.slice(0, 8)
  return (
    <div className="panel p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-fg-muted">Who needs a push</h3>
        <Meta>{b.push.length} people</Meta>
      </div>
      {b.push.length === 0 ? (
        <p className="text-sm text-fg-muted">Nobody: everyone has published this year.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((r) => (
            <PushRow key={r.person.id} year={b.year} person={r.person} reasons={r.reasons} />
          ))}
        </ul>
      )}
      {b.push.length > 8 && (
        <Button kind="quiet" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${b.push.length}`}
        </Button>
      )}
    </div>
  )
}

function PushRow({ year, person, reasons }: { year: number; person: BriefPerson; reasons: string[] }) {
  const recently =
    !!person.last_reminded_at && Date.now() - new Date(person.last_reminded_at).getTime() < DAY
  const [sent, setSent] = useState(recently)
  const send = useApiMutation<{ user_ids: string[]; message: string }, { sent: number }>(
    "/api/hod/nudge",
    { invalidates: [["hod", "brief"]] }
  )
  async function remind() {
    try {
      const r = await send.mutateAsync({ user_ids: [person.id], message: reminderFor(year, reasons) })
      setSent(true)
      toast.ok(r.sent ? `Reminder sent to ${person.name}` : `${person.name} was reminded in the last day`)
    } catch (err) {
      toast.fail(err)
    }
  }
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Avatar person={face(person)} size="sm" />
      <div className="min-w-0 flex-1">
        <Link to={`/people/${person.id}`} className="text-sm font-medium hover:underline">
          {person.name}
        </Link>
        <p className="text-xs text-fg-muted">{reasons.join(". ")}</p>
      </div>
      <Button
        kind="quiet"
        size="sm"
        onClick={() => void remind()}
        disabled={sent || send.isPending}
        aria-label={sent ? `${person.name} reminded` : `Remind ${person.name}`}
      >
        {sent ? <Check /> : <BellRing />}
        {sent ? "Reminded" : "Remind"}
      </Button>
    </li>
  )
}

/* ---------------- who should write with whom ---------------- */

function Pairs({ b }: { b: Brief }) {
  const [all, setAll] = useState(false)
  return (
    <div className="panel p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-fg-muted">Who should write with whom</h3>
        <Meta>{b.pairs.length} suggested</Meta>
      </div>
      {b.pairs.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No pairing to suggest: nobody without a Q1 paper shares an area with a colleague who has
          two or more recent ones, or they are already paired.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {(all ? b.pairs : b.pairs.slice(0, 5)).map((p) => (
            <PairRow key={p.mentee.id} pair={p} />
          ))}
        </ul>
      )}
      {b.pairs.length > 5 && (
        <Button kind="quiet" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${b.pairs.length}`}
        </Button>
      )}
    </div>
  )
}

function PairRow({ pair }: { pair: Brief["pairs"][number] }) {
  const [done, setDone] = useState(false)
  const create = useApiMutation<
    { kind: string; title: string; notes: string; assignee_id: string; partner_id: string },
    unknown
  >("/api/hod/assignments", { invalidates: [["hod", "assignments"], ["hod", "brief"]] })
  async function pairThem() {
    try {
      await create.mutateAsync({
        kind: "PAIRING",
        title: `Write a paper together${pair.area ? ` in ${pair.area}` : ""}`,
        notes: pair.why,
        assignee_id: pair.mentee.id,
        partner_id: pair.mentor.id,
      })
      setDone(true)
      toast.ok(`Paired ${pair.mentee.name} with ${pair.mentor.name}. Both see it on their home screen.`)
    } catch (err) {
      toast.fail(err)
    }
  }
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="flex shrink-0 -space-x-2">
        <Avatar person={face(pair.mentee)} size="sm" className="ring-2 ring-surface" />
        <Avatar person={face(pair.mentor)} size="sm" className="ring-2 ring-surface" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {pair.mentee.name} <span className="font-normal text-fg-muted">with</span> {pair.mentor.name}
        </p>
        <p className="text-xs text-fg-muted">{pair.why}</p>
      </div>
      <Button kind="quiet" size="sm" onClick={() => void pairThem()} disabled={done || create.isPending}>
        {done ? <Check /> : <Users />}
        {done ? "Paired" : "Pair them"}
      </Button>
    </li>
  )
}

/* ---------------- per-faculty table ---------------- */

type SortKey = "name" | "this_year" | "last_year" | "q1_this_year" | "led_this_year" | "total"

function FacultyTable({ b }: { b: Brief }) {
  const [sort, setSort] = useState<SortKey>("this_year")
  const rows = useMemo(
    () =>
      [...b.people].sort((x, y) =>
        sort === "name" ? x.name.localeCompare(y.name) : y[sort] - x[sort] || x.name.localeCompare(y.name)
      ),
    [b.people, sort]
  )
  const max = Math.max(1, ...b.people.map((p) => Math.max(p.this_year, p.last_year)))
  const head = (key: SortKey, label: string, right = true) => (
    <th scope="col" className={cn("px-3 py-2 font-medium", right && "text-right")}>
      <button
        type="button"
        onClick={() => setSort(key)}
        className={cn("hover:underline", sort === key ? "text-fg" : "text-fg-muted")}
        aria-pressed={sort === key}
      >
        {label}
      </button>
    </th>
  )
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-fg-muted">Every faculty member, {b.year}</h3>
        <Meta>{b.people.length} people. Click a heading to sort.</Meta>
      </div>
      <TableScroller>
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line text-left text-xs">
            <tr>
              {head("name", "Faculty", false)}
              <th scope="col" className="px-3 py-2 font-medium text-fg-muted">
                {b.year} against {b.year - 1}
              </th>
              {head("this_year", String(b.year))}
              {head("last_year", String(b.year - 1))}
              {head("q1_this_year", "Q1")}
              {head("led_this_year", "Led")}
              {head("total", "All years")}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((p) => (
              <tr key={p.id} className={cn(p.this_year === 0 && "bg-caution-wash")}>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-3">
                    <Avatar person={face(p)} size="sm" />
                    <span className="min-w-0">
                      <Link to={`/people/${p.id}`} className="font-medium hover:underline">
                        {p.name}
                        {p.is_you && <span className="font-normal text-fg-muted"> (you)</span>}
                      </Link>
                      <span className="block text-xs text-fg-muted">
                        {[p.designation, p.area].filter(Boolean).join(", ")}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span
                    className="block w-32 space-y-0.5"
                    role="img"
                    aria-label={`${p.this_year} in ${b.year}, ${p.last_year} in ${b.year - 1}`}
                  >
                    <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${(p.this_year / max) * 100}%` }} />
                    <span className="block h-1.5 rounded-full bg-fg-subtle/40" style={{ width: `${(p.last_year / max) * 100}%` }} />
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {p.this_year}
                  {p.target ? <span className="font-normal text-fg-muted"> / {p.target}</span> : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{p.last_year}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.q1_this_year || "–"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.led_this_year || "–"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{p.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
    </div>
  )
}
