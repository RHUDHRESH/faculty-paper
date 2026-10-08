import { ExternalLink } from "lucide-react"

import { cn } from "@/lib/cn"
import { ColumnLabel, Figure, Meta } from "@/ui/text"

/** `profile_dict` in core/services/scopus_profiles.py. */
export type ScopusProfile = {
  scopus_id: string
  url: string | null
  author_name: string | null
  affiliation: string | null
  publications: number | null
  citations: number | null
  h_index: number | null
  publications_by_year: Record<string, number>
  documents_listed: number
  source_sheet: string
  imported_at: string | null
}

/** "23 Sept 2026" -- a calendar date, because the question is "how old is this". */
export function importedOn(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

const count = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-IN"))

/** `hod_overview`'s `scopus` block: a department's Scopus totals. */
export type DepartmentScopus = {
  people_with_profile: number
  publications: number
  citations: number
  highest_h_index: number | null
  last_imported_at: string | null
}

/**
 * One department's standing on Scopus, in a sentence: citations and Scopus
 * publications across the people with a profile loaded.
 *
 * Scopus's own count, across whole careers -- not the papers filed here --
 * so it says whose figures they are and when they were imported. Nobody with
 * a profile is said in words rather than shown as a row of zeros.
 */
export function DepartmentScopusLine({
  scopus,
  className,
}: {
  scopus: DepartmentScopus
  className?: string
}) {
  if (scopus.people_with_profile === 0) {
    return (
      <Meta className={cn("block", className)}>
        No Scopus profiles are loaded for anybody in the department yet. The research office
        imports them, matched by each person's Scopus ID.
      </Meta>
    )
  }
  const on = importedOn(scopus.last_imported_at)
  const people = scopus.people_with_profile
  return (
    <p className={cn("text-sm tabular", className)}>
      On Scopus: {scopus.citations.toLocaleString("en-IN")} citations and{" "}
      {scopus.publications.toLocaleString("en-IN")} Scopus publications across the {people}{" "}
      {people === 1 ? "person" : "people"} with a profile loaded
      {scopus.highest_h_index != null ? `; highest h-index ${scopus.highest_h_index}` : ""}
      {on ? ` (imported ${on})` : ""}.
    </p>
  )
}

/**
 * A person's Scopus figures, as the office's profile import holds them.
 *
 * Academic figures, not money, so the same card serves the person, the
 * office and their head of department. The date it was imported is always
 * shown: these are a snapshot of Scopus on the day the workbook was made, not
 * a live reading, and a citation count with no date reads as current.
 *
 * No profile is said in words. Three zeros would claim the person has never
 * been cited, which is a different fact from nobody having loaded it.
 */
export function ScopusProfileCard({
  profile,
  emptyMessage,
  className,
}: {
  profile: ScopusProfile | null | undefined
  emptyMessage?: string
  className?: string
}) {
  if (!profile) {
    return (
      <p className={cn("text-sm text-fg-muted", className)}>
        {emptyMessage ??
          "No Scopus profile has been imported for this account yet. The research office loads them from the Scopus profile workbook, matched by Scopus ID."}
      </p>
    )
  }
  const figures: [string, number | null][] = [
    ["Publications", profile.publications],
    ["Citations", profile.citations],
    ["h-index", profile.h_index],
  ]
  const on = importedOn(profile.imported_at)
  return (
    <div className={cn("space-y-3", className)}>
      <dl className="grid grid-cols-3 gap-4">
        {figures.map(([label, value]) => (
          <div key={label}>
            <dt>
              <ColumnLabel>{label}</ColumnLabel>
            </dt>
            <dd className="mt-1">
              <Figure className="text-figure">{count(value)}</Figure>
            </dd>
          </div>
        ))}
      </dl>
      <Meta className="block">
        Scopus ID{" "}
        {profile.url ? (
          <a
            href={profile.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2"
          >
            {profile.scopus_id}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : (
          profile.scopus_id
        )}
        {on ? ` · imported ${on}` : ""}
      </Meta>
    </div>
  )
}
