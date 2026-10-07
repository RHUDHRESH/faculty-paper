import { useState } from "react"
import { Link } from "react-router-dom"
import { BellRing, Download } from "lucide-react"

import { useAuth } from "@/app/auth"
import { homeTrack } from "@/app/home-data"
import { useApi } from "@/lib/query"
import { ComingUpEvents } from "@/pages/home-events"
import { HomeHead, YourPapers } from "@/pages/home-staff"
import {
  groupDraft,
  leadSentence,
  n,
  papersLink,
  PushEmpty,
  PushRows,
  RemindDialog,
  SILENT_KINDS,
  useBrief,
  VERDICT,
  type Brief,
  type Reminder,
} from "@/pages/hod-parts"
import { Lead } from "@/pages/principal-parts"
import { days, MAIN_STAGES, type TrackPayload } from "@/pages/track-data"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Celebrations } from "@/ui/celebrations"
import { Section } from "@/ui/section"
import { Delayed, ErrorState, SkeletonRows } from "@/ui/state"

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

const SHOWN = 5

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
    <Section
      title="Your department's claims"
      action={
        <Link to="/track" className="text-accent underline-offset-4 hover:underline">
          Open Track
        </Link>
      }
    >
      <p className="text-base" role="status">
        {parts.join("; ")}.
        {late > 0 ? ` ${n(late)} ${late === 1 ? "has" : "have"} been in one place over a month.` : ""}
      </p>
    </Section>
  )
}

export function HodHome() {
  const { me } = useAuth()
  const brief = useBrief()
  const [reminding, setReminding] = useState<Reminder | null>(null)
  const b = brief.data

  const silent = b ? b.push.filter((r) => SILENT_KINDS.includes(r.kind)) : []
  const list = silent.length ? silent : b?.push ?? []
  const shown = list.slice(0, SHOWN)

  return (
    <div className="page space-y-10">
      <HomeHead
        name={me?.name}
        picture="spot-home-hod"
        sentence="Is the department on track, who needs a push, and what to tell the Principal."
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
          <Lead>{leadSentence(b)}</Lead>

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

          <Section
            title="Who needs a push"
            sub="No paper on record this year, most recent history first. Each has a next step."
            action={
              list.length > SHOWN ? (
                <Link to="/department#push" className="text-accent underline-offset-4 hover:underline">
                  All {n(list.length)} on the department page
                </Link>
              ) : undefined
            }
          >
            {shown.length === 0 ? (
              <PushEmpty year={b.year} />
            ) : (
              <>
                <PushRows rows={shown} pairs={b.pairs} onRemind={setReminding} />
                {silent.length > 1 && (
                  <Button
                    kind="quiet"
                    size="sm"
                    className="mt-2"
                    onClick={() =>
                      setReminding({
                        people: silent.map((r) => ({ id: r.person.id, name: r.person.name })),
                        draft: groupDraft(b.year),
                      })
                    }
                  >
                    <BellRing />
                    Remind all {n(silent.length)} who have no paper in {b.year}
                  </Button>
                )}
              </>
            )}
          </Section>

          <Section
            title="What to tell the Principal"
            sub="A one-page note with the same figures: the year against target or last year, who needs a push, the records to fix."
          >
            <Button kind="primary" asChild>
              <a href={`/api/hod/report?fmt=pdf&year=${b.year}`} download>
                <Download />
                Download the note for the Principal
              </a>
            </Button>
          </Section>

          <ClaimsLine />
        </>
      )}

      <Celebrations />

      <ComingUpEvents />

      <YourPapers note="What you have filed yourself, with your own amounts. Your department's figures carry none." />

      {reminding && <RemindDialog reminder={reminding} onClose={() => setReminding(null)} />}
    </div>
  )
}
