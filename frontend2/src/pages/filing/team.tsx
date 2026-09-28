import type { UseQueryResult } from "@tanstack/react-query"

import type { ApiError } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Radio } from "@/ui/field"
import { money } from "@/ui/paper"
import { Callout, InlineError, SkeletonText } from "@/ui/state"
import { Meta } from "@/ui/text"

import type { FilingRules } from "./types"

/* ------------------------------------------------------------------------ */
/* Team picker — the final-year project scheme                              */
/* ------------------------------------------------------------------------ */

export type MyTeam = {
  id: string
  code: string
  title: string | null
  department: string | null
  academic_year: string | null
  mentor_name: string | null
  members: { id: string; name: string; register_number: string | null }[]
  /** The filed claim holding this team, if one does. The scheme pays once per team. */
  claimed_by: { claim_id: string; ticket_number: string | null; status: string } | null
}

/** Why the student-project option is closed, in the words the server uses. */
export const MENTORS_NO_TEAM =
  "You are not the mentor of any final-year project team on the roster, so this is not open to you. If you do mentor one, ask the research office to check the roster names you by your staff id."

/** The teams the roster says this person (or the person being filed for) mentors. */
export function useMyTeams(ownerId?: string | null) {
  return useApi<{ results: MyTeam[] }>(
    ["teams", "mine", ownerId ?? null],
    ownerId ? `/api/teams?mine=true&owner_id=${encodeURIComponent(ownerId)}` : "/api/teams?mine=true"
  )
}

/**
 * The mentor's own teams, to choose the one this paper came from.
 *
 * From a list rather than a typed code: only a team's mentor may claim for
 * it, so the list is exactly the teams the roster says this person mentors.
 * A team already claimed stays on the list with the ticket that holds it,
 * rather than being offered and then refused by the server.
 */
export function TeamPicker({
  teams,
  code,
  onCode,
  error,
  rules,
  claimId,
}: {
  teams: UseQueryResult<{ results: MyTeam[] }, ApiError>
  code: string
  onCode: (code: string) => void
  /** Said when Continue was pressed without a team. */
  error?: string
  rules: FilingRules
  /** A claim sent back to be fixed still holds its team; it is not blocked by itself. */
  claimId?: string | null
}) {
  const mine = teams.data?.results ?? []
  const chosen = code.trim().toUpperCase()
  const notMine = teams.isSuccess && chosen !== "" && !mine.some((t) => t.code.toUpperCase() === chosen)

  return (
    <fieldset className="space-y-3 rounded-md border border-line p-4" data-field="team">
      <legend className="sr-only">Your final-year project teams</legend>

      <Callout tone="info" title={`A fixed ${money(rules.student_project_amount)} per team, for a conference paper`}>
        Paid to the team's mentor, once per team. Conference papers only — a journal article or a book
        chapter is filed as a faculty publication incentive instead. It is not worked out from the SNIP
        or the quartile and is not split by author position.
      </Callout>

      {teams.isLoading ? (
        <SkeletonText lines={3} />
      ) : teams.error ? (
        <InlineError
          message="Could not load your teams. Nothing you have entered is lost."
          onRetry={() => void teams.refetch()}
        />
      ) : mine.length === 0 ? (
        <Callout tone="caution" title="You mentor no team on the roster">
          {MENTORS_NO_TEAM}
        </Callout>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {mine.map((t) => {
            const isChosen = chosen === t.code.toUpperCase()
            const heldByOther = !!t.claimed_by && t.claimed_by.claim_id !== claimId
            return (
              <li key={t.id} className="px-1 py-3">
                <Radio
                  name="fyp-team"
                  checked={isChosen}
                  disabled={heldByOther && !isChosen}
                  onChange={() => onCode(t.code)}
                  label={`${t.code} · ${t.title || "Untitled project"}`}
                  hint={
                    t.members.length
                      ? t.members
                          .map((m) => (m.register_number ? `${m.name} (${m.register_number})` : m.name))
                          .join(" · ")
                      : "No students listed on the roster"
                  }
                />
                {heldByOther && t.claimed_by ? (
                  <Meta className="mt-1 block pl-6">
                    Already claimed on ticket {t.claimed_by.ticket_number || "(not yet numbered)"} — the
                    scheme pays once per team.
                  </Meta>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {notMine ? (
        <Callout tone="caution" title={`${code.trim()} is not one of your teams`}>
          Only a team's mentor may claim for it. Choose one of the teams above.
        </Callout>
      ) : null}
      {error ? <p className="text-sm text-critical">{error}</p> : null}
    </fieldset>
  )
}
