import { Link } from "react-router-dom"
import { ExternalLink, TriangleAlert } from "lucide-react"

import { formatCount } from "@/lib/count"
import { unshout } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { DetailLink, type DetailSpec } from "@/ui/detail-sheet"
import { Avatar } from "@/ui/person"
import { SheetBody, SheetFooter, SheetHeader, SheetTitle } from "@/ui/sheet"
import { ErrorState, SkeletonRows } from "@/ui/state"

/**
 * What each detail panel shows. Kept apart from `detail-sheet.tsx` so the
 * pages that only place links do not carry four panels' worth of code: this
 * file loads the first time somebody opens one.
 *
 * None of these panels shows money. The server sends none (`core/api/detail.py`);
 * the payments list and the statement are where a figure is read.
 */

type PaperRow = {
  id: string | null
  title: string
  year: number | null
  venue: string | null
  quartile: string | null
  citations: number | null
  position?: number | null
}

export type PaperDetail = {
  id: string
  title: string
  year: number | null
  type: string | null
  venue: string | null
  quartile: string | null
  snip: number | null
  citations: number | null
  doi: string | null
  topics: string[]
  links: { doi: string | null; scopus: string | null; openalex: string | null; open_access: string | null }
  authors: { name: string; position: number | null; user_id: string | null; is_college: boolean; institution: string | null }[]
  is_author: boolean
  mine: {
    claim_id: string | null
    stage: string | null
    days_waiting: number | null
    eligible: boolean
    ineligible_reason: string | null
  } | null
}

export type JournalDetail = {
  name: string
  quartile: string | null
  snip: number | null
  subject: string | null
  issn: string | null
  in_journal_list: boolean
  college: { count: number; papers: PaperRow[] }
  colleagues: { id: string; name: string; initials: string; photo_url: string | null; department: string | null; papers: number }[]
  colleague_count: number
  mine: PaperRow[]
  watch: { reason: string | null; since: string | null } | null
}

export type PersonCardBody = {
  person: { id: string; name: string; initials: string; photo_url: string | null; department: string | null; designation: string | null }
  is_me: boolean
  papers: number
  citations: number
  topics: string[]
}

export type MetricBody = { name: string; title: string; explain: string | null; count: number; papers: PaperRow[] }

export default function DetailPanels({ spec }: { spec: DetailSpec }) {
  if (spec.kind === "paper") return <PaperPanel id={spec.id} />
  if (spec.kind === "journal") return <JournalPanel name={spec.name} />
  if (spec.kind === "person") return <PersonPanel id={spec.id} />
  return <MetricPanel metric={spec.metric} value={spec.value} />
}

function Loading({ title }: { title: string }) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>{title}</SheetTitle>
      </SheetHeader>
      <SheetBody>
        <SkeletonRows rows={5} rowHeight={40} />
      </SheetBody>
    </>
  )
}

function Failed({ title, message, retry }: { title: string; message: string; retry: () => void }) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>{title}</SheetTitle>
      </SheetHeader>
      <SheetBody>
        <ErrorState title={`Could not open ${title.toLowerCase()}`} message={message} onRetry={retry} />
      </SheetBody>
    </>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-fg tabular">{children}</dd>
    </div>
  )
}

function QuartileChip({ q }: { q: string | null }) {
  if (!q) return null
  return <Chip tone={q === "Q1" ? "gold" : "neutral"}>{q}</Chip>
}

/** A list of papers, each opening its own panel. */
export function PaperRows({ papers, empty }: { papers: PaperRow[]; empty?: string }) {
  if (!papers.length) return <p className="text-sm text-fg-muted">{empty ?? "No papers."}</p>
  return (
    <ol className="divide-y divide-line">
      {papers.map((p, i) => (
        <li key={p.id ?? `${i}-${p.title}`} className="flex items-start gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-fg">
              <DetailLink kind="paper" id={p.id}>
                {unshout(p.title)}
              </DetailLink>
            </p>
            <p className="text-xs text-fg-muted">
              {[p.venue, p.year, p.position === 1 ? "first author" : null].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <QuartileChip q={p.quartile} />
            {p.citations != null && (
              <span className="text-xs text-fg-muted tabular">
                {formatCount(p.citations)} {p.citations === 1 ? "citation" : "citations"}
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

function Out({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm text-accent underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

/* ------------------------------------------------------------------------ */

function PaperPanel({ id }: { id: string }) {
  const q = useApi<PaperDetail>(["detail", "paper", id], `/api/papers/${encodeURIComponent(id)}/detail`)
  if (q.isError) return <Failed title="This paper" message={q.error.message} retry={() => void q.refetch()} />
  if (!q.data) return <Loading title="Paper" />
  const p = q.data
  const mine = p.mine
  return (
    <>
      <SheetHeader>
        <p className="text-xs text-fg-muted">Paper</p>
        <SheetTitle className="text-balance">{unshout(p.title)}</SheetTitle>
      </SheetHeader>
      <SheetBody className="space-y-6">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Fact label="Journal">
            {p.venue ? <DetailLink kind="journal" name={p.venue} /> : "Not recorded"}
          </Fact>
          <Fact label="Year">{p.year ?? "Not recorded"}</Fact>
          <Fact label="Type">{p.type ?? "Not recorded"}</Fact>
          <Fact label="Quartile">{p.quartile ?? "Not ranked"}</Fact>
          {p.snip != null && <Fact label="SNIP">{p.snip.toFixed(2)}</Fact>}
          <Fact label="Citations">{p.citations == null ? "Not yet" : formatCount(p.citations)}</Fact>
        </dl>

        <section aria-labelledby="detail-authors" className="space-y-2">
          <h3 id="detail-authors" className="text-sm font-semibold text-fg">
            Authors ({p.authors.length})
          </h3>
          <ol className="space-y-1.5">
            {p.authors.map((a, i) => (
              <li key={`${i}-${a.name}`} className="flex items-baseline gap-2 text-sm">
                <span className="w-5 shrink-0 text-right text-xs text-fg-subtle tabular">{a.position ?? i + 1}</span>
                {a.user_id ? (
                  <Link to={`/u/${a.user_id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                    {a.name}
                  </Link>
                ) : (
                  <span className="text-fg">{a.name}</span>
                )}
                {a.institution && !a.user_id && <span className="truncate text-xs text-fg-muted">{a.institution}</span>}
                {a.user_id && <span className="text-xs text-fg-muted">at the college</span>}
              </li>
            ))}
          </ol>
        </section>

        {p.topics.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {p.topics.slice(0, 6).map((t) => (
              <Chip key={t}>{t}</Chip>
            ))}
          </div>
        )}

        {(p.links.doi || p.links.scopus || p.links.openalex || p.links.open_access) && (
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {p.links.doi && <Out href={p.links.doi}>DOI</Out>}
            {p.links.scopus && <Out href={p.links.scopus}>Scopus</Out>}
            {p.links.openalex && <Out href={p.links.openalex}>OpenAlex</Out>}
            {p.links.open_access && <Out href={p.links.open_access}>Free to read</Out>}
          </div>
        )}

        {mine && (
          <section aria-labelledby="detail-claim" className="well space-y-1 rounded-panel p-4">
            <h3 id="detail-claim" className="text-sm font-semibold text-fg">
              Your claim
            </h3>
            <p className="text-sm text-fg-muted">
              {mine.stage
                ? `${mine.stage}${mine.days_waiting ? `, ${mine.days_waiting} days since filing` : ""}.`
                : mine.eligible
                  ? "Not filed yet."
                  : `Cannot be filed: ${mine.ineligible_reason ?? "not eligible"}.`}
            </p>
          </section>
        )}
      </SheetBody>
      {mine && (mine.claim_id || (!mine.stage && mine.eligible)) && (
        <SheetFooter>
          {mine.claim_id ? (
            <Button kind="primary" asChild>
              <Link to={`/papers/${mine.claim_id}`}>Open the claim</Link>
            </Button>
          ) : (
            <Button kind="primary" asChild>
              <Link to={`/papers/new?publication=${p.id}`}>File it</Link>
            </Button>
          )}
        </SheetFooter>
      )}
    </>
  )
}

/* ------------------------------------------------------------------------ */

function JournalPanel({ name }: { name: string }) {
  const q = useApi<JournalDetail>(["detail", "journal", name], `/api/journals/detail?name=${encodeURIComponent(name)}`)
  if (q.isError) return <Failed title="This journal" message={q.error.message} retry={() => void q.refetch()} />
  if (!q.data) return <Loading title={name} />
  const j = q.data
  return (
    <>
      <SheetHeader>
        <p className="text-xs text-fg-muted">Journal</p>
        <SheetTitle className="text-balance">{unshout(j.name)}</SheetTitle>
      </SheetHeader>
      <SheetBody className="space-y-6">
        {j.watch && (
          <p role="note" className="flex gap-2 rounded-panel bg-caution-wash p-3 text-sm text-fg">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-caution" />
            <span>On the research office's watch-list.{j.watch.reason ? ` ${j.watch.reason}` : ""}</span>
          </p>
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Fact label="Quartile">{j.quartile ?? "Not ranked"}</Fact>
          <Fact label="SNIP">{j.snip != null ? j.snip.toFixed(2) : "Not known"}</Fact>
          {j.subject && <Fact label="Subject">{j.subject}</Fact>}
          {j.issn && <Fact label="ISSN">{j.issn}</Fact>}
        </dl>
        {!j.in_journal_list && <p className="text-sm text-fg-muted">Not found in the journal rankings we hold.</p>}

        <section aria-labelledby="detail-mine" className="space-y-2">
          <h3 id="detail-mine" className="text-sm font-semibold text-fg">
            Your papers here ({j.mine.length})
          </h3>
          <PaperRows papers={j.mine} empty="You have not published here yet." />
        </section>

        <section aria-labelledby="detail-college" className="space-y-2">
          <h3 id="detail-college" className="text-sm font-semibold text-fg">
            The college's papers here ({formatCount(j.college.count)})
          </h3>
          <PaperRows papers={j.college.papers} empty="Nobody at the college has published here yet." />
          {j.college.count > j.college.papers.length && (
            <p className="text-xs text-fg-muted">The newest {j.college.papers.length} are shown.</p>
          )}
        </section>

        {j.colleagues.length > 0 && (
          <section aria-labelledby="detail-colleagues" className="space-y-2">
            <h3 id="detail-colleagues" className="text-sm font-semibold text-fg">
              Colleagues who published here ({formatCount(j.colleague_count)})
            </h3>
            <ul className="divide-y divide-line">
              {j.colleagues.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2">
                  <Avatar person={c} size="sm" />
                  <div className="min-w-0 flex-1">
                    <DetailLink kind="person" id={c.id} className="text-sm font-medium text-fg">
                      {c.name}
                    </DetailLink>
                    {c.department && <p className="truncate text-xs text-fg-muted">{c.department}</p>}
                  </div>
                  <span className="text-xs text-fg-muted tabular">
                    {c.papers} {c.papers === 1 ? "paper" : "papers"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </SheetBody>
    </>
  )
}

/* ------------------------------------------------------------------------ */

function PersonPanel({ id }: { id: string }) {
  const q = useApi<PersonCardBody>(["detail", "person", id], `/api/people/${encodeURIComponent(id)}/card`)
  if (q.isError) return <Failed title="This person" message={q.error.message} retry={() => void q.refetch()} />
  if (!q.data) return <Loading title="Person" />
  const { person, papers, citations, topics, is_me } = q.data
  return (
    <>
      <SheetHeader className="flex items-center gap-4">
        <Avatar person={person} size="lg" />
        <div className="min-w-0">
          <SheetTitle>{person.name}</SheetTitle>
          <p className="text-sm text-fg-muted">{[person.designation, person.department].filter(Boolean).join(", ")}</p>
        </div>
      </SheetHeader>
      <SheetBody className="space-y-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Fact label="Papers">{formatCount(papers)}</Fact>
          <Fact label="Citations">{formatCount(citations)}</Fact>
        </dl>
        {topics.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-fg">Works on</h3>
            <div className="flex flex-wrap gap-1.5">
              {topics.map((t) => (
                <Chip key={t}>{t}</Chip>
              ))}
            </div>
          </div>
        )}
      </SheetBody>
      <SheetFooter>
        {!is_me && (
          <Button asChild>
            <Link to={`/messages?to=${person.id}`}>Message</Link>
          </Button>
        )}
        <Button kind="primary" asChild>
          <Link to={`/u/${person.id}`}>Open profile</Link>
        </Button>
      </SheetFooter>
    </>
  )
}

/* ------------------------------------------------------------------------ */

function MetricPanel({ metric, value }: { metric: string; value?: string | number | null }) {
  const params = new URLSearchParams()
  if (metric === "year" && value != null) params.set("year", String(value))
  else if (value != null && value !== "") params.set("value", String(value))
  const qs = params.toString()
  const q = useApi<MetricBody>(["detail", "metric", metric, value ?? null], `/api/me/metric/${metric}${qs ? `?${qs}` : ""}`)
  if (q.isError) return <Failed title="This number" message={q.error.message} retry={() => void q.refetch()} />
  if (!q.data) return <Loading title="What's behind this number" />
  const m = q.data
  const ready = m.name === "unfiled"
  return (
    <>
      <SheetHeader>
        <p className="text-xs text-fg-muted">What's behind this number</p>
        <SheetTitle>{m.title}</SheetTitle>
      </SheetHeader>
      <SheetBody className="space-y-4">
        {m.explain && <p className="text-sm text-fg-muted">{m.explain}</p>}
        <p className="text-sm text-fg">
          {formatCount(m.count)} {m.count === 1 ? "paper" : "papers"}
        </p>
        {ready ? (
          <ol className="divide-y divide-line">
            {m.papers.map((p, i) => (
              <li key={p.id ?? i} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <DetailLink kind="paper" id={p.id} className="text-sm font-medium text-fg">
                    {unshout(p.title)}
                  </DetailLink>
                  <p className="text-xs text-fg-muted">{[p.venue, p.year].filter(Boolean).join(" · ")}</p>
                </div>
                {p.id && (
                  <Button size="sm" asChild>
                    <Link to={`/papers/new?publication=${p.id}`}>File it</Link>
                  </Button>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <PaperRows papers={m.papers} empty="No papers make up this number yet." />
        )}
      </SheetBody>
    </>
  )
}
