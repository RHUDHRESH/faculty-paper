import { useState } from "react"
import { Link } from "react-router-dom"
import { BellRing, Check, Users } from "lucide-react"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog"
import { Field, Textarea } from "@/ui/field"
import { Avatar, initialsOf } from "@/ui/person"
import { Rows } from "@/ui/section"
import { toast } from "@/ui/toast"

/**
 * The pieces a head's Home and Department page share, so the two can never
 * disagree: the brief (`/api/hod/brief`), the pace against the calendar, and
 * the push list. Everything here is a count of papers from the college's
 * publication record, the same record the Principal's pages read, so a head's
 * figure for a department and year is the Principal's figure (docs/jtbd/hod.md).
 * There is no money on any of it and no desk named.
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
  has_scopus_id: boolean
  target: number | null
  last_reminded_at: string | null
}

export type Verdict = "met" | "on_track" | "close" | "behind"
export type PushKind = "slipped" | "quiet" | "never" | "no_q1" | "never_led"

export type BriefTarget = {
  metric: string
  label: string
  target: number
  done: number
  expected_by_now: number
  verdict: Verdict
  due_date: string | null
  to_go: number
  months_left: number
  per_month_needed: number | null
}

export type PushRow = {
  person: BriefPerson
  reasons: string[]
  kind: PushKind
  next_step: string
  draft: string
}

export type Brief = {
  department: string
  year: number
  as_of: string
  elapsed: number
  months_left: number
  totals: {
    publications: number
    q1: number
    quartile_known: number
    first_author: number
    faculty: number
    faculty_published: number
    silent: number
    per_teacher: number | null
    last_year_full: number
    last_year_to_date: number
    this_year_to_date: number
    missing_doi: number
    missing_issn: number
    missing_issn_or_doi: number
    record_papers: number
    record_papers_window: number
    scopus_indexed: number
    without_scopus_id: number
  }
  college: { per_teacher: number | null; papers: number; top_quartile_share: number | null; rank: number | null; of: number } | null
  targets: BriefTarget[]
  by_year: { year: number; publications: number; q1: number; partial: boolean }[]
  people: BriefPerson[]
  push: PushRow[]
  pairs: { mentee: BriefPerson; mentor: BriefPerson; area: string | null; why: string }[]
  years: number[]
}

export const VERDICT: Record<Verdict, { text: string; tone: "positive" | "caution" | "critical" }> = {
  met: { text: "Target met", tone: "positive" },
  on_track: { text: "On track", tone: "positive" },
  close: { text: "Slightly behind", tone: "caution" },
  behind: { text: "Behind", tone: "critical" },
}

export const TONE_TEXT = { positive: "text-positive", caution: "text-caution", critical: "text-critical" } as const

/** No paper this year: the people a head talks to this week. The other kinds are about quality. */
export const SILENT_KINDS: PushKind[] = ["slipped", "quiet", "never"]

export function useBrief(year?: number) {
  return useApi<Brief>(["hod", "brief", year ?? "current"], `/api/hod/brief${year ? `?year=${year}` : ""}`, {
    retry: false,
  })
}

export function face(p: { name: string; photo_url?: string | null }) {
  return { name: p.name, initials: initialsOf(p.name), photo_url: p.photo_url ?? null }
}

export const n = formatCount

/** Where a figure's papers open: the list of the department's papers. */
export function papersLink(params: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, String(v))
  const s = q.toString()
  return `/publications${s ? `?${s}` : ""}`
}

/** "3 months" or "1 month". */
export const months = (k: number) => `${k} ${k === 1 ? "month" : "months"}`

/**
 * The one sentence a head can say to the Principal: how many papers, against
 * what, and what it means. With a target it is pace against the calendar; with
 * none it is this year to today against last year to the same date.
 */
export function leadSentence(b: Brief): string {
  const t = b.totals
  const running = b.year >= new Date(b.as_of).getFullYear()
  const pubs = b.targets.find((x) => x.metric === "PUBLICATIONS")
  const head = `${b.department} ${running ? "has" : "had"} ${n(t.publications)} ${t.publications === 1 ? "paper" : "papers"} in ${b.year}${running ? " so far" : ""}`
  if (pubs) {
    const tail =
      pubs.verdict === "met"
        ? `, and has met its target of ${n(pubs.target)}.`
        : `, against a target of ${n(pubs.target)} (${n(Math.round(pubs.expected_by_now))} expected by now): ${VERDICT[pubs.verdict].text.toLowerCase()}.`
    const more =
      pubs.to_go && b.months_left && running
        ? ` ${n(pubs.to_go)} to go in ${months(b.months_left)}, about ${pubs.per_month_needed} a month.`
        : ""
    return `${head}${tail}${more}`
  }
  if (running) {
    const ahead = t.this_year_to_date >= t.last_year_to_date
    return `${head}, ${ahead ? "ahead of" : "behind"} last year's pace: ${n(t.this_year_to_date)} by today against ${n(t.last_year_to_date)} by the same date in ${b.year - 1}. No target is set.`
  }
  return `${head}, against ${n(t.last_year_full)} in ${b.year - 1}.`
}

/* ---------------- pace ---------------- */

/** Progress with a tick where the calendar says it should be by now. */
export function PaceBar({ done, target, expected }: { done: number; target: number; expected: number }) {
  const w = (v: number) => `${Math.min(100, target ? (v / target) * 100 : 0)}%`
  return (
    <div
      className="relative h-2.5 rounded-full bg-sunken"
      role="img"
      aria-label={`${done} of ${target}; about ${Math.round(expected)} expected by now`}
    >
      <div className="h-full rounded-full bg-accent" style={{ width: w(done) }} />
      <div className="absolute -top-1 h-4.5 w-0.5 bg-fg" style={{ left: w(expected) }} title="Where it should be by today" />
    </div>
  )
}

/** A target against the calendar: how far, how far it should be, and what a month must now deliver. */
export function TargetPace({ t, elapsed }: { t: BriefTarget; elapsed: number }) {
  const tone = TONE_TEXT[VERDICT[t.verdict].tone]
  return (
    <li className="space-y-1.5 py-3 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-base font-medium">{t.label}</span>
        <span className={cn("text-sm font-medium", tone)}>{VERDICT[t.verdict].text}</span>
      </div>
      <PaceBar done={t.done} target={t.target} expected={t.expected_by_now} />
      <p className="text-sm text-fg-muted tabular">
        {n(t.done)} of {n(t.target)}. {Math.round(elapsed * 100)}% of the year has gone, so about{" "}
        {n(Math.round(t.expected_by_now))} would be on pace
        {t.to_go > 0
          ? `; ${n(t.to_go)} to go${t.months_left ? ` in ${months(t.months_left)}${t.per_month_needed ? `, about ${t.per_month_needed} a month` : ""}` : ""}.`
          : "."}
      </p>
    </li>
  )
}

/* ---------------- who needs a push ---------------- */

export type Reminder = { people: { id: string; name: string }[]; draft: string }

/** An editable draft, then a send. One reminder a person a day, whoever sends it. */
export function RemindDialog({ reminder, onClose }: { reminder: Reminder; onClose: () => void }) {
  const [message, setMessage] = useState(reminder.draft)
  const send = useApiMutation<
    { user_ids: string[]; message: string },
    { sent: number; skipped: { id: string; name: string }[] }
  >("/api/hod/nudge", { invalidates: [["hod", "brief"]] })
  const length = message.trim().length
  const valid = length >= 10 && length <= 500
  const who = reminder.people
  const shown = who.slice(0, 6)

  async function submit() {
    if (!valid) return
    try {
      const r = await send.mutateAsync({ user_ids: who.map((p) => p.id), message: message.trim() })
      toast.ok(r.sent ? `Reminder sent to ${r.sent} ${r.sent === 1 ? "person" : "people"}` : "No reminder sent")
      if (r.skipped.length) {
        toast.info(`Reminded in the last day, so not sent again: ${r.skipped.map((s) => s.name).join(", ")}`)
      }
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Send a reminder</DialogTitle>
          <DialogDescription>
            A notification on their home screen. Edit the words first. Anyone reminded in the last day is skipped.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm">
            <span className="text-fg-muted">To </span>
            {shown.map((p) => p.name).join(", ")}
            {who.length > shown.length && <span className="text-fg-muted"> and {who.length - shown.length} more</span>}
          </p>
          <Field label="Message" hint={`${length} of 500 characters${length < 10 ? ", at least 10" : ""}.`}>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} maxRows={10} maxLength={500} autoFocus />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={send.isPending}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void submit()} disabled={!valid || send.isPending}>
            {send.isPending ? "Sending" : who.length === 1 ? "Send reminder" : `Send ${who.length} reminders`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const DAY = 24 * 60 * 60 * 1000

/**
 * One person to talk to: their face, the reason in words, the suggested next
 * step, and the one action that does it. A suggested writing partner sits on
 * the same row, because "write with her" is the next step for a person with no
 * Q1 paper, and it is one click to make it an assignment they both see.
 */
export function PushRowItem({
  row,
  pair,
  onRemind,
}: {
  row: PushRow
  pair?: Brief["pairs"][number]
  onRemind: (r: Reminder) => void
}) {
  const p = row.person
  const recently = !!p.last_reminded_at && Date.now() - new Date(p.last_reminded_at).getTime() < DAY
  const [paired, setPaired] = useState(false)
  const create = useApiMutation<
    { kind: string; title: string; notes: string; assignee_id: string; partner_id: string },
    unknown
  >("/api/hod/assignments", { invalidates: [["hod", "assignments"], ["hod", "brief"]] })

  async function pairThem() {
    if (!pair) return
    try {
      await create.mutateAsync({
        kind: "PAIRING",
        title: `Write a paper together${pair.area ? ` in ${pair.area}` : ""}`,
        notes: pair.why,
        assignee_id: pair.mentee.id,
        partner_id: pair.mentor.id,
      })
      setPaired(true)
      toast.ok(`Paired ${pair.mentee.name} with ${pair.mentor.name}. Both see it on their home screen.`)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 sm:px-2">
      <Avatar person={face(p)} size="md" />
      <div className="min-w-0 flex-1 basis-56">
        <Link to={`/faculty/${p.id}`} className="block truncate text-base font-medium underline-offset-4 hover:underline">
          {p.name}
        </Link>
        <p className="text-sm text-fg-muted">{row.reasons.join(". ")}</p>
        <p className="text-sm text-fg-muted">
          <span className="text-fg">Next: </span>
          {pair ? `write with ${pair.mentor.name} (${pair.area ?? "same area"}).` : row.next_step}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 max-sm:w-full max-sm:pl-13">
        {pair && (
          <Button
            kind="default"
            size="sm"
            onClick={() => void pairThem()}
            disabled={paired || create.isPending}
            aria-label={`Pair ${p.name} with ${pair.mentor.name}`}
          >
            {paired ? <Check /> : <Users />}
            {paired ? "Paired" : "Pair them"}
          </Button>
        )}
        <Button
          kind={pair ? "quiet" : "default"}
          size="sm"
          onClick={() => onRemind({ people: [{ id: p.id, name: p.name }], draft: row.draft })}
          disabled={recently}
          aria-label={recently ? `${p.name} was reminded in the last day` : `Remind ${p.name}`}
        >
          {recently ? <Check /> : <BellRing />}
          {recently ? "Reminded" : "Remind"}
        </Button>
      </div>
    </li>
  )
}

/** The rows of a push list, with a hairline between them. */
export function PushRows({
  rows,
  pairs,
  onRemind,
}: {
  rows: PushRow[]
  pairs: Brief["pairs"]
  onRemind: (r: Reminder) => void
}) {
  const pairOf = new Map(pairs.map((x) => [x.mentee.id, x]))
  return (
    <Rows>
      {rows.map((r) => (
        <PushRowItem key={r.person.id} row={r} pair={pairOf.get(r.person.id)} onRemind={onRemind} />
      ))}
    </Rows>
  )
}

/** A draft for many people at once: the same words, kindly, without a per-person reason. */
export function groupDraft(year: number): string {
  return `A reminder from your head of department: nothing from you is on record for ${year} yet. If a paper is out or under review, please file it or tell me. If you are stuck, come and talk to me.`
}

export function PushEmpty({ year }: { year: number }) {
  return (
    <p className="border-y border-line py-6 text-base text-fg-muted">
      Nobody needs a push. Every colleague has a paper on record for {year}.
    </p>
  )
}
