import { Link, useParams } from "react-router-dom"
import { ArrowLeft, ExternalLink } from "lucide-react"

import { useAuth } from "@/app/auth"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Avatar } from "@/ui/person"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"

/**
 * A department colleague's paper, as a head sees it (GET /api/hod/papers/:id):
 * the publication, never the claim. No money, no review notes, no files. The
 * claim page (/papers/:id) stays the claimant's and the office's; a head's own
 * paper links there too.
 */

type Author = { name: string; position: number | null; user_id: string | null; is_college: boolean; initials?: string; photo_url?: string | null }
type HodPaper = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  issn: string | null
  doi: string | null
  publication_year: number | null
  quartile: string | null
  snip: number | null
  indexing_level: string | null
  publication_type: string | null
  author_position: number | null
  total_authors: number | null
  owner_id: string
  owner_name: string
  owner_department: string | null
  owner_photo_url?: string | null
  scopus_url: string | null
  progress: string
  citations: number | null
  oa_url: string | null
  authors: Author[]
}

export function HodPaper() {
  const { id = "" } = useParams()
  const { me } = useAuth()
  const { data, isLoading, error, refetch } = useApi<HodPaper>(["hod", "paper", id], `/api/hod/papers/${id}`, {
    retry: false,
  })

  const back = (
    <Button asChild size="sm" kind="quiet">
      <Link to="/publications">
        <ArrowLeft /> Department papers
      </Link>
    </Button>
  )

  if (isLoading)
    return (
      <div className="page space-y-6 py-6">
        <SkeletonRows rows={6} />
      </div>
    )
  if (error?.status === 404 || error?.status === 403)
    return (
      <div className="page space-y-6 py-6">
        <EmptyState
          illustration="empty-no-results"
          title="Not a paper from your department"
          message="This page shows papers filed by your department's staff. Open the department list to find another."
          action={back}
        />
      </div>
    )
  if (error || !data)
    return (
      <div className="page py-6">
        <ErrorState onRetry={() => void refetch()} />
      </div>
    )

  const facts: [string, React.ReactNode][] = [
    ["Journal", data.journal_title || "Not recorded"],
    ["Year", data.publication_year ?? "Not recorded"],
    ["Quartile", data.quartile || "Not recorded"],
    ["Indexed in", data.indexing_level || "Not recorded"],
    ["Type", data.publication_type || "Not recorded"],
    ["ISSN", data.issn || "Not recorded"],
    [
      "Author position",
      data.author_position ? `${data.author_position} of ${data.total_authors ?? "?"}` : "Not recorded",
    ],
    ["Citations", data.citations ?? "Not counted yet"],
    ["Progress", data.progress],
  ]
  const own = me?.id === data.owner_id

  return (
    <div className="page space-y-6 py-6">
      <div>{back}</div>
      <PageHeader
        eyebrow={data.ticket_number ?? undefined}
        title={paperTitle(data.paper_title)}
        sub={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Avatar person={{ name: data.owner_name, initials: "", photo_url: data.owner_photo_url ?? null }} size="sm" />
            <Link to={`/people/${data.owner_id}`} className="hover:underline">
              {data.owner_name}
            </Link>
            {data.owner_department ? <Meta>{data.owner_department}</Meta> : null}
          </span>
        }
        actions={
          <>
            {data.doi && (
              <Button asChild size="sm">
                <a href={`https://doi.org/${data.doi}`} target="_blank" rel="noreferrer">
                  <ExternalLink /> Read the paper
                </a>
              </Button>
            )}
            {own && (
              <Button asChild size="sm" kind="primary">
                <Link to={`/papers/${data.id}`}>Open your claim</Link>
              </Button>
            )}
          </>
        }
      />

      <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-3 sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0 border-b border-line pb-2">
            <dt>
              <Meta>{label}</Meta>
            </dt>
            <dd className="text-sm [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
        {data.doi && (
          <div className="min-w-0 border-b border-line pb-2">
            <dt>
              <Meta>DOI</Meta>
            </dt>
            <dd className="text-sm [overflow-wrap:anywhere]">{data.doi}</dd>
          </div>
        )}
      </dl>

      <section className="space-y-2">
        <SectionTitle>Authors</SectionTitle>
        {data.authors.length === 0 ? (
          <p className="text-sm text-fg-muted">The author list was not recorded with this paper.</p>
        ) : (
          <ol className="divide-y divide-line border-y border-line">
            {data.authors.map((a, i) => (
              <li key={`${a.name}-${i}`} className="flex items-center gap-3 py-2">
                <Meta className="w-5 shrink-0 text-right tabular-nums">{a.position ?? i + 1}</Meta>
                <Avatar person={{ name: a.name, initials: a.initials ?? "", photo_url: a.photo_url ?? null }} size="xs" />
                {a.user_id ? (
                  <Link to={`/people/${a.user_id}`} className="min-w-0 truncate text-sm hover:underline">
                    {a.name}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-sm">{a.name}</span>
                )}
                {a.is_college && <Meta>Our college</Meta>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
