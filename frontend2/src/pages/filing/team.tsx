import { useApi } from "@/lib/query"
import { Field, Input } from "@/ui/field"
import { Callout, SkeletonText } from "@/ui/state"
import { Meta } from "@/ui/text"

/* ------------------------------------------------------------------------ */
/* Team picker — student project claims                                     */
/* ------------------------------------------------------------------------ */

type TeamLookup = {
  code: string
  title: string | null
  department: string | null
  academic_year: string | null
  mentor_name: string | null
  members: {
    id: string
    name: string
    register_number: string | null
    programme: string | null
    year_of_study: string | null
    mentor_name: string | null
  }[]
}

/**
 * Find the team by the code on the project sheet, then agree with what comes
 * back.
 *
 * By code rather than by picking from a list: the code is what is printed on
 * the sheet in front of the claimant, and a list of every student project in
 * the college is neither what they came for nor theirs to browse. A code that
 * matches nothing is an ordinary answer here, not an error — the first time a
 * project is entered anywhere, no team exists yet — so it says so and points
 * at where teams are made, instead of rendering a failure.
 *
 * Nothing is confirmed silently. The students are shown by name and register
 * number because that is what the claimant is being asked to vouch for, and a
 * code echoed back as "found" would let a mistyped digit attach somebody
 * else's project to a payment.
 */
export function TeamPicker({
  code,
  onCode,
  required,
  error,
}: {
  code: string
  onCode: (code: string) => void
  /** The claim names no team yet and the server will refuse it. */
  required?: boolean
  /** Said beside the box when Continue was pressed without one. */
  error?: string
}) {
  const trimmed = code.trim()
  const { data, isLoading, error: lookupError } = useApi<TeamLookup>(
    ["team", trimmed],
    `/api/teams/${encodeURIComponent(trimmed)}`,
    { enabled: trimmed.length >= 2 }
  )

  // A 404 means "no team with that code yet", which is a normal state of the
  // world rather than something going wrong.
  const notFound = !!lookupError && (lookupError as { status?: number }).status === 404

  return (
    <div className="space-y-3 rounded-md border border-line p-4">
      <Field
        label="Team code"
        hint="The code on the project sheet — for example CSE-24-011."
        error={error ?? (required ? "A student project claim cannot be filed without one." : undefined)}
      >
        <Input value={code} onChange={(e) => onCode(e.target.value)} placeholder="CSE-24-011" />
      </Field>

      {trimmed.length < 2 ? null : isLoading ? (
        <SkeletonText lines={2} />
      ) : notFound ? (
        <Callout tone="caution" title={`No team with the code ${trimmed}`}>
          Teams are created once, with the students on them, and then claimed against by code. If
          this project has not been entered yet, create the team first — this claim cannot be filed
          until it names one.
        </Callout>
      ) : lookupError ? (
        <Callout tone="critical" title="Could not look that code up">
          The server did not answer. Nothing you have typed has been lost.
        </Callout>
      ) : data ? (
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">{data.title || "Untitled project"}</p>
            <Meta>{[data.code, data.department, data.academic_year].filter(Boolean).join(" · ")}</Meta>
            {data.mentor_name ? <Meta>Mentor: {data.mentor_name}</Meta> : null}
          </div>

          {data.members.length === 0 ? (
            <Callout tone="caution" title="This team has no students on it">
              The team exists but nobody is listed on it, so the claim would name a project with no
              one behind it.
            </Callout>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {data.members.map((m) => (
                <li key={m.id} className="px-1 py-2">
                  <p className="text-sm">{m.name}</p>
                  <Meta>
                    {[m.register_number, m.programme, m.year_of_study].filter(Boolean).join(" · ") ||
                      "No register number recorded"}
                  </Meta>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-fg-subtle">
            Check the names and register numbers before filing. This is what the claim says the
            project was, and who it was by.
          </p>
        </div>
      ) : null}
    </div>
  )
}
