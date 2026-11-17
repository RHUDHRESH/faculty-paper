import { Link } from "react-router-dom"

import { useApi } from "@/lib/query"
import { ClaimNo } from "@/ui/claim-number"
import { Section } from "@/ui/section"
import { Meta } from "@/ui/text"
import { papersWord, studentsWord, type TeamsPayload } from "@/pages/teams-types"

/** How many teams Home lists; the rest are one link away. */
const SHOWN = 5

/**
 * "My teams" on a faculty member's Home: the final-year project teams they
 * mentor, each with where its claim stands. Draws nothing for somebody who
 * mentors none, and nothing if the request fails: it is a second errand beside
 * the record, not something to put a second error box on the page for.
 */
export function MyTeams() {
  const q = useApi<TeamsPayload>(["teams", "home"], `/api/teams?limit=${SHOWN}`)
  const teams = q.data?.results ?? []
  if (teams.length === 0) return null
  const total = q.data?.total ?? teams.length
  return (
    <Section
      title="My teams"
      action={
        <Link to="/teams" className="text-accent underline-offset-2 hover:underline">
          {total > teams.length ? `See all ${total} teams` : "Open my teams"}
        </Link>
      }
    >
      <ul className="divide-y divide-line border-y border-line">
        {teams.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-2.5">
            <div className="min-w-0 flex-1 basis-60">
              <Link to={`/teams/${encodeURIComponent(t.code)}`} className="font-medium tabular hover:underline">
                {t.code}
              </Link>
              <Meta className="block truncate">
                {[t.project_title, studentsWord(t.student_count), papersWord(t.publications_count)].filter(Boolean).join(" · ")}
              </Meta>
            </div>
            <div className="text-sm">
              {t.claim ? (
                <Link to={t.claim.url} className="inline-flex flex-wrap items-center gap-x-2 hover:underline">
                  <ClaimNo value={t.claim.ticket_number} copy={false} />
                  <span className="text-fg-muted">{t.claim.stage}</span>
                </Link>
              ) : (
                <Link to={`/teams/${encodeURIComponent(t.code)}`} className="text-accent underline-offset-2 hover:underline">
                  Not claimed
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}
