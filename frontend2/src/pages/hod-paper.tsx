import { Link, useParams } from "react-router-dom"
import { ExternalLink } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useCrumbLabel } from "@/app/crumbs"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Avatar, initialsOf } from "@/ui/person"
import { Rows, Section } from "@/ui/section"
import { Delayed, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"

/**
 * One paper of the department, as a head sees it (`GET /api/hod/papers/:id`):
 * the publication and who wrote it, never the money, the review notes or the
 * files. The id is a paper of the college record; an id from Track is a claim,
 * and then the page also says where that claim stands, in words a head may
 * have ("Under review", "Completed"), never which desk holds it.
 */

type Author = {
  name: string
  position: number | null
  user_id: string | null
  is_college: boolean
  in_department?: boolean
  photo_url?: string | null
}
type HodPaper = {
  source?: "record"
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  issn: string | null
  doi: string | null
  publication_year: number | null
  publication_date?: string | null
  quartile: string | null
  snip: number | null
  indexing_level: string | null
  publication_type: string | null
  author_position: number | null
  total_authors: number | null
  owner_id: string
  owner_name: string
  owner_department: string | null
  scopus_url: string | null
  progress: string | null
  citations: number | null
  scopus_citations?: number | null
  oa_url: string | null
  topics?: string[]
  authors: Author[]
}

/** "conference-paper" is the record's word, not a head's: "Conference paper". */
function typeLabel(t: string | null): string {
  const s = (t ?? "").replace(/[-_]+/g, " ").trim().toLowerCase()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Not recorded"
}

const JOURNAL = new Set(["article", "journal", "journal-article", "review"])

function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
}

export function HodPaper() {
  const { id = "" } = useParams()
  const { me } = useAuth()
  const { data, isLoading, error, refetch } = useApi<HodPaper>(["hod", "paper", id], `/api/hod/papers/${id}`, {
    retry: false,
  })
  useCrumbLabel(data ? paperTitle(data.paper_title) || "Paper" : undefined)

  const back = (
    <Button asChild kind="default">
      <Link to="/publications">Open the department's papers</Link>
    </Button>
  )

  if (isLoading)
    return (
      <div className="page space-y-6">
        <Delayed>
          <SkeletonRows rows={6} />
        </Delayed>
      </div>
    )
  if (error?.status === 404 || error?.status === 403)
    return (
      <div className="page space-y-6">
        <EmptyState
          illustration="empty-no-results"
          title="Not a paper from your department"
          message="This page shows papers your department's people wrote. Open the list to find another."
          action={back}
        />
      </div>
    )
  if (error || !data)
    return (
      <div className="page">
        <ErrorState what="this paper" onRetry={() => void refetch()} />
      </div>
    )

  const isJournal = JOURNAL.has((data.publication_type ?? "").toLowerCase())
  const facts: [string, React.ReactNode][] = [
    ["Journal", data.journal_title || "Not recorded"],
    ["Published", longDate(data.publication_date) ?? data.publication_year ?? "Not recorded"],
    ["Journal quartile", /^Q[1-4]$/i.test(data.quartile ?? "") ? (data.quartile ?? "").toUpperCase() : "Not recorded"],
    ["Indexed in", data.indexing_level || "Not recorded"],
    ["Type", typeLabel(data.publication_type)],
    [
      "ISSN",
      data.issn || (data.source === "record" && !isJournal ? "None: not a journal article" : "Not recorded"),
    ],
    ["DOI", data.doi || "Not recorded"],
    [
      "Cited by",
      data.citations != null
        ? `${data.citations}${data.scopus_citations != null ? ` (Scopus counts ${data.scopus_citations})` : ""}`
        : "Not counted yet",
    ],
  ]
  const own = me?.id === data.owner_id
  const inDepartment = data.authors.filter((a) => a.in_department)
  const others = data.authors.filter((a) => !a.in_department)
  const ordered = data.authors.length && data.source === "record" ? [...inDepartment, ...others] : data.authors

  return (
    <div className="page space-y-8">
      <PageHeader
        eyebrow={data.ticket_number ?? undefined}
        title={paperTitle(data.paper_title) || "Untitled paper"}
        sub={
          data.source === "record"
            ? `${inDepartment.map((a) => a.name).join(", ") || data.owner_name} · ${data.owner_department ?? "Department not recorded"}`
            : `${data.owner_name} · ${data.owner_department ?? "Department not recorded"}`
        }
        action={
          data.doi ? (
            <Button kind="primary" asChild>
              <a href={`https://doi.org/${data.doi}`} target="_blank" rel="noreferrer">
                <ExternalLink />
                Read the paper
              </a>
            </Button>
          ) : undefined
        }
      />

      {data.progress && (
        <p className="text-base">
          <span className="text-fg-muted">Where its claim stands: </span>
          <span className="font-medium">{data.progress}</span>
          {own && (
            <>
              {". "}
              <Link to={`/papers/${data.id}`} className="text-accent underline-offset-4 hover:underline">
                Open your claim
              </Link>
            </>
          )}
        </p>
      )}

      <Section title="The paper">
        <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-3 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt>
                <Meta>{label}</Meta>
              </dt>
              <dd className="text-base [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
        {data.topics && data.topics.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Topics">
            {data.topics.map((t) => (
              <li key={t} className="rounded-full bg-sunken px-2.5 py-0.5 text-sm text-fg-muted">
                {t}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={`Authors (${ordered.length})`}
        sub={inDepartment.length ? `${inDepartment.length} from your department, listed first.` : undefined}
      >
        {ordered.length === 0 ? (
          <p className="text-base text-fg-muted">The author list was not recorded with this paper.</p>
        ) : (
          <Rows>
            {ordered.map((a, i) => (
              <li key={`${a.name}-${i}`} className="flex items-center gap-3 py-2.5 sm:px-2">
                <Meta className="w-6 shrink-0 text-right tabular">{a.position ?? i + 1}</Meta>
                <Avatar person={{ name: a.name, initials: initialsOf(a.name), photo_url: a.photo_url ?? null }} size="md" />
                {a.user_id ? (
                  <Link to={`/faculty/${a.user_id}`} className="min-w-0 flex-1 truncate text-base underline-offset-4 hover:underline">
                    {a.name}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-base">{a.name}</span>
                )}
                <Meta>{a.in_department ? "Your department" : a.is_college ? "Our college" : "Outside the college"}</Meta>
              </li>
            ))}
          </Rows>
        )}
      </Section>
    </div>
  )
}
