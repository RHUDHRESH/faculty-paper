import { Link } from "react-router-dom"
import { CheckCircle2, XCircle } from "lucide-react"

import { cn } from "@/lib/cn"

/**
 * The reviewer's "Team check" on a student-project claim: the facts the
 * college's rule rests on, each as one plain pass or fail line the server has
 * worked out (`student_teams.team_check`), so a claim whose team has changed
 * since it was filed is seen before it is cleared.
 *
 * Nothing here decides anything: a failing line is a reason to look, and the
 * reviewer still clears, sends back or rejects.
 */

export type TeamCheck = {
  team_code: string | null
  team_url: string | null
  /** Every line passes. */
  ok: boolean
  lines: { key: string; ok: boolean; text: string }[]
}

export function TeamCheckBlock({ check, className }: { check: TeamCheck | null | undefined; className?: string }) {
  if (!check) return null
  const failing = check.lines.filter((l) => !l.ok).length
  return (
    <section aria-labelledby="team-check" className={cn("space-y-2", className)} data-testid="team-check">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="team-check" className="text-base font-semibold">
          Team check
        </h3>
        {check.team_url && check.team_code && (
          <Link to={check.team_url} className="text-sm text-accent underline-offset-2 hover:underline">
            Open team {check.team_code}
          </Link>
        )}
      </div>
      <p className={cn("text-sm", check.ok ? "text-positive" : "text-critical")}>
        {check.ok
          ? "The team passes every check."
          : `${failing} of ${check.lines.length} checks ${failing === 1 ? "does" : "do"} not pass. Look at this before clearing.`}
      </p>
      <ul className="space-y-1.5">
        {check.lines.map((l) => (
          <li key={l.key} className="flex gap-2 text-sm" data-check={l.key} data-ok={l.ok}>
            {l.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
            )}
            <span className={cn("min-w-0 text-pretty", !l.ok && "text-critical")}>
              <span className="sr-only">{l.ok ? "Passes: " : "Fails: "}</span>
              {l.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
