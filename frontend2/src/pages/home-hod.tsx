import { useState } from "react"
import { Link } from "react-router-dom"
import { BellRing, Check, Download, Users } from "lucide-react"

import { useAuth } from "@/app/auth"
import { homeTrack } from "@/app/home-data"
import { useApi, useApiMutation } from "@/lib/query"
import {
  groupDraft,
  leadSentence,
  n,
  papersLink,
  PushEmpty,
  RemindDialog,
  SILENT_KINDS,
  useBrief,
  VERDICT,
  type Brief,
  type PushRow,
  type Reminder,
} from "@/pages/hod-parts"
import { YourPapers } from "@/pages/home-staff"
import { days, MAIN_STAGES, type TrackPayload } from "@/pages/track-data"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Section } from "@/ui/section"
import { Delayed, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { toast } from "@/ui/toast"

/**
 * A head of department's first screen. It answers the three questions a head
 * is asked every month, in the order they are asked (docs/jtbd/hod.md): is the
 * department on track, who needs a push, and what do I tell the Principal.
 *
 * Every figure is a count of papers from the college's publication record, the
 * same record the Principal's pages read, so what a head says in the monthly
 * review is what the Principal sees. Nothing here is a rupee and no desk is
 * named; the head's own papers, at the bottom, are the one place their own
 * amounts appear.
 */

const SHOWN = 10
const DAY = 24 * 60 * 60 * 1000

function tone(b: Brief): "positive" | "caution" | "critical" | "neutral" {
  const pubs = b.targets.find((t) => t.metric === "PUBLICATIONS")
  if (pubs) return VERDICT[pubs.verdict].tone
  if (b.year < new Date(b.as_of).getFullYear()) return "neutral"
  return b.totals.this_year_to_date >= b.totals.last_year_to_date ? "positive" : "caution"
}

/** The department's claims, in one sentence: nothing here is a desk or an amount. */
function ClaimsLine() {
  const { me } = useAuth()
  const mine = homeTrack(me?.role)
  const q = useApi<TrackPayload>(mine.key, mine.path)
  if (q.isError) return null
  if (!q.data) return <div className="h-6" aria-hidden />
  const s = q.data.stages.filter((x) => MAIN_STAGES.includes(x.key))
  const by = (k: string) => s.find((x) => x.key === k)
  const review = by("review")
  const done = by("completed")
  const late = q.data.stages.reduce((a, x) => a + (x.ageing?.older ?? 0), 0)
  const parts = [
    review?.count
      ? `${n(review.count)} ${review.count === 1 ? "claim is" : "claims are"} being checked by the college${
          review.oldest_days ? `, the longest for ${days(review.oldest_days)}` : ""
        }`
      : "No claim is waiting with the college",
    done ? `${n(done.count)} ${done.count === 1 ? "is" : "are"} complete` : "",
  ].filter(Boolean)
  return (
    <p className="text-sm text-fg-muted">
      <span role="status">
        {parts.join("; ")}.
        {late > 0 ? ` ${n(late)} ${late === 1 ? "has" : "have"} been in one place over a month.` : ""}
      </span>{" "}
      <Link to="/track" className="text-accent underline-offset-4 hover:underline">
        Open Track
      </Link>
    </p>
  )
}

/** The buttons on a row: Remind, and Pair them where a writing partner is suggested. */
function PushActions({
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
    <div className="flex flex-wrap gap-2">
      {pair && (
        <Button
          kind="default"
          onClick={() => void pairThem()}
          disabled={paired || create.isPending}
          aria-label={`Pair ${p.name} with ${pair.mentor.name}`}
        >
          {paired ? <Check /> : <Users />}
          {paired ? "Paired" : "Pair them"}
        </Button>
      )}
      <Button
        kind="default"
        onClick={() => onRemind({ people: [{ id: p.id, name: p.name }], draft: row.draft })}
        disabled={recently}
        aria-label={recently ? `${p.name} was reminded in the last day` : `Remind ${p.name}`}
      >
        {recently ? <Check /> : <BellRing />}
        {recently ? "Reminded" : "Remind"}
      </Button>
    </div>
  )
}

function PushTable({
  rows,
  pairs,
  onRemind,
}: {
  rows: PushRow[]
  pairs: Brief["pairs"]
  onRemind: (r: Reminder) => void
}) {
  const pairOf = new Map(pairs.map((x) => [x.mentee.id, x]))
  const next = (r: PushRow) => {
    const pair = pairOf.get(r.person.id)
    return pair ? `Write with ${pair.mentor.name} (${pair.area ?? "same area"}).` : r.next_step
  }
  const columns: Column<PushRow>[] = [
    {
      key: "person",
      header: "Colleague",
      exportValue: (r) => r.person.name,
      cell: (r) => (
        <Link to={`/faculty/${r.person.id}`} className="font-medium text-accent underline-offset-4 hover:underline">
          {r.person.name}
        </Link>
      ),
    },
    { key: "why", header: "Why", exportValue: (r) => r.reasons.join(". "), cell: (r) => r.reasons.join(". ") },
    { key: "next", header: "Next step", exportValue: next, cell: next },
    {
      key: "act",
      header: "Action",
      label: "Remind",
      cell: (r) => <PushActions row={r} pair={pairOf.get(r.person.id)} onRemind={onRemind} />,
    },
  ]
  return (
    <Table
      rows={rows}
      columns={columns}
      getKey={(r) => r.person.id}
      tools={{ id: "hod-home-push", title: "Who needs a push" }}
    />
  )
}

export function HodHome() {
  const brief = useBrief()
  const [reminding, setReminding] = useState<Reminder | null>(null)
  const b = brief.data

  const silent = b ? b.push.filter((r) => SILENT_KINDS.includes(r.kind)) : []
  const list = silent.length ? silent : b?.push ?? []
  const shown = list.slice(0, SHOWN)

  return (
    <div className="page space-y-8">
      <PageHeader
        title="Home"
        sub="How your department is doing and who needs a word."
        action={
          b && (
            <>
              <Button kind="quiet" asChild>
                <a href={`/api/hod/report?fmt=pdf&year=${b.year}`} download>
                  <Download />
                  Download the note for the Principal
                </a>
              </Button>
              {silent.length > 1 && (
                <Button
                  kind="primary"
                  onClick={() =>
                    setReminding({
                      people: silent.map((r) => ({ id: r.person.id, name: r.person.name })),
                      draft: groupDraft(b.year),
                    })
                  }
                >
                  <BellRing />
                  Remind all {n(silent.length)}
                </Button>
              )}
            </>
          )
        }
      />

      {brief.isError ? (
        <ErrorState
          what="the department's year"
          message={
            brief.error?.status === 400 || brief.error?.status === 403
              ? "This account is not set up as the head of a department. Ask the research office to set the department."
              : "The server did not answer."
          }
          onRetry={brief.error?.status === 400 || brief.error?.status === 403 ? false : () => void brief.refetch()}
        />
      ) : !b ? (
        <Delayed>
          <SkeletonRows rows={5} rowHeight={48} />
        </Delayed>
      ) : (
        <>
          <Answer
            items={[
              {
                value: b.totals.publications,
                label: `papers in ${b.year}${b.year >= new Date(b.as_of).getFullYear() ? " so far" : ""}`,
                zero: `No papers on record for ${b.year}`,
                to: papersLink({ year: b.year }),
                tone: tone(b),
              },
              {
                value: `${n(b.totals.faculty_published)} of ${n(b.totals.faculty)}`,
                label: `faculty have a paper in ${b.year}`,
                to: "/department?tab=faculty",
              },
              {
                value: silent.length,
                label: `have no paper in ${b.year}`,
                zero: `Everyone has a paper in ${b.year}`,
                to: "/department#push",
                tone: silent.length ? "caution" : "neutral",
              },
              {
                value: b.totals.missing_issn_or_doi,
                label: "papers of the last five years missing a DOI or an ISSN",
                zero: "Every paper has a DOI and, for a journal, an ISSN",
                to: "/department?tab=records",
              },
            ]}
          />

          <p className="text-sm text-fg-muted" data-testid="report-answer">
            {leadSentence(b)}
          </p>

          <Section title="Who needs a push">
            {shown.length === 0 ? (
              <PushEmpty year={b.year} />
            ) : (
              <>
                <PushTable rows={shown} pairs={b.pairs} onRemind={setReminding} />
                <p className="mt-2 text-sm">
                  <Link to="/department#push" className="text-accent underline-offset-4 hover:underline">
                    {list.length > shown.length ? `View all ${n(list.length)} on the department page` : "View on the department page"}
                  </Link>
                </p>
              </>
            )}
          </Section>

          <ClaimsLine />
        </>
      )}

      <YourPapers note="What you have filed yourself, with your own amounts. Your department's figures carry none." />

      {reminding && <RemindDialog reminder={reminding} onClose={() => setReminding(null)} />}
    </div>
  )
}
