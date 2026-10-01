import { useEffect } from "react"
import { BookOpen, ExternalLink, Globe, MessageSquare, RefreshCw, Telescope } from "lucide-react"
import { Link } from "react-router-dom"

import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { formatCount } from "@/lib/count"
import { PageHeader } from "@/ui/page-header"
import { Callout, InlineError, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { cn } from "@/lib/cn"
import { Avatar, initialsOf } from "@/ui/person"
import { Picture, topicPicture } from "@/ui/picture"
import { StreamingText, ThinkingIndicator, useTypewriter } from "@/ui/motion/stream"

type Source = { url: string; title: string }
type Opportunity = { title: string; kind: string; why: string; deadline: string; url: string }
type ScoutResult = {
  profile: { name: string; department: string; papers: number; citations: number; h_index: number; topics: string[] }
  web: {
    summary: string
    opportunities: Opportunity[]
    directions: { title: string; builds_on: string; why: string; urls: string[] }[]
    external_people: { name: string; affiliation: string; work: string; url: string }[]
  }
  literature: { topic: string; title: string; year: number | null; venue: string; first_author: string; affiliation: string; citations: number; url: string }[]
  colleagues: {
    user_id: string
    name: string
    initials?: string
    photo_url?: string | null
    department: string
    papers: number
    shared_topics: string[]
    their_topics: string[]
    why: string
    picked: boolean
  }[]
  sources: Source[]
  generated_at: string
}
export type ScoutRun = {
  status: "none" | "queued" | "running" | "done" | "failed"
  id?: string
  runs_left: number
  limit: number
  result?: ScoutResult
  error?: string
  code?: string
}

const KIND: Record<string, string> = {
  call: "Funded call",
  special_issue: "Special issue",
  conference: "Conference",
  open_problem: "Open problem",
}

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function SourceLink({ url }: { url: string }) {
  if (!url) return <Meta>No link found. Check before relying on it.</Meta>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
      {host(url)}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  )
}

function Origin({ web }: { web: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-fg-subtle">
      {web ? <Globe aria-hidden className="size-3.5" /> : <BookOpen aria-hidden className="size-3.5" />}
      {web ? "From the web" : "From our records"}
    </span>
  )
}

function Section({ id, title, web, children }: { id: string; title: string; web?: boolean; children: React.ReactNode }) {
  return (
    <section className="scroll-mt-4 space-y-4 pt-2" aria-labelledby={id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle><span id={id}>{title}</span></SectionTitle>
        {web !== undefined && <Origin web={web} />}
      </div>
      {children}
    </section>
  )
}

/**
 * What the reader sees before the first run: what the scout will do, what it
 * reads and how long it takes. A blank page with a button in the corner said
 * none of this, so nobody knew whether to press it.
 */
function FirstRun({ left, limit, onStart }: { left: number; limit: number; onStart: () => void }) {
  return (
    <section className="max-w-2xl space-y-5">
      <p className="text-lg text-fg">
        The scout reads your papers, then searches the web for what you could take up next. It takes a minute or two.
      </p>
      <ul className="space-y-2 text-base text-fg-muted">
        <li>Open calls and special issues that fit your work, nearest deadline first.</li>
        <li>Directions your papers lead into, with the sources it found.</li>
        <li>Colleagues in other departments and people beyond the college who work near you.</li>
        <li>Journals that published the most-cited recent work on your topics.</li>
      </ul>
      <div className="flex flex-wrap items-center gap-4">
        <Button kind="primary" size="lg" disabled={left === 0} onClick={onStart}>
          <Telescope aria-hidden />
          Scout for me
        </Button>
        <Meta>
          {left === 0 ? "You have used today's runs. Try again tomorrow." : `${left} of ${limit} runs left today. Results are kept for 24 hours.`}
        </Meta>
      </div>
    </section>
  )
}

const DAY = 86_400_000

/** A deadline the model wrote, as a date; null when it is not one. */
export function parseDeadline(text: string): Date | null {
  if (!text) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim())
  const d = iso ? new Date(+iso[1], +iso[2] - 1, +iso[3]) : new Date(text)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Open calls in date order: the nearest first, undated after, closed ones apart. */
export function sortCalls(list: Opportunity[], today = new Date()) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const rows = list.map((o) => {
    const d = parseDeadline(o.deadline)
    return { o, d, days: d ? Math.round((d.getTime() - start) / DAY) : null }
  })
  const open = rows
    .filter((r) => r.days === null || r.days >= 0)
    .sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9))
  const closed = rows.filter((r) => r.days !== null && r.days < 0)
  return { open, closed }
}

const NOT_AN_END = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Er|St|vs|etc|e\.g|i\.e|[A-Z])\.$/

/**
 * Where the first sentence ends, or -1. A full stop after a title or an
 * initial ("Mr. S. Joyal Isac") is not the end: splitting there made the
 * lead read "Mr."
 */
export function sentenceEnd(text: string): number {
  for (const m of text.matchAll(/[.!?](\s+)(?=[A-Z])/g)) {
    const stop = (m.index ?? 0) + 1
    if (!NOT_AN_END.test(text.slice(0, stop))) return stop
  }
  return -1
}

function daysLeft(days: number | null) {
  if (days === null) return null
  if (days === 0) return "Closes today"
  if (days === 1) return "1 day left"
  return `${days} days left`
}

function CallRow({ o, d, days, closed }: { o: Opportunity; d: Date | null; days: number | null; closed?: boolean }) {
  return (
    <li className={cn("grid grid-cols-[4.5rem_1fr] gap-4 py-4 sm:grid-cols-[6rem_1fr]", closed && "opacity-60")}>
      <div className="text-right">
        {d ? (
          <>
            <p className="font-display text-2xl leading-none text-fg">{d.getDate()}</p>
            <p className="mt-1 text-sm text-fg-muted">
              {d.toLocaleDateString(undefined, { month: "short" })} {d.getFullYear()}
            </p>
          </>
        ) : (
          <p className="text-sm text-fg-subtle">Rolling</p>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-(--area)">{KIND[o.kind] ?? o.kind}</span>
          {closed ? (
            <span className="text-fg-subtle">Closed</span>
          ) : (
            days !== null && (
              <span className={cn("font-medium", days <= 14 ? "text-caution" : "text-fg-muted")}>{daysLeft(days)}</span>
            )
          )}
        </p>
        <p className={cn("font-medium text-fg", closed && "line-through decoration-fg-subtle")}>{o.title}</p>
        <p className="text-sm text-fg-muted">{o.why}</p>
        <SourceLink url={o.url} />
      </div>
    </li>
  )
}

/**
 * Research scout: Claude searches the web from the person's own record and
 * says what to work on next and with whom. It reads as a brief: the lead
 * direction first, then calls by date, directions, people and venues. Web
 * findings and our own records are labelled apart; links are only the ones
 * the search actually returned.
 */
export function Scout() {
  const run = useApi<ScoutRun>(["scout"], "/api/scout", {
    refetchInterval: (q) => (q.state.data?.status === "queued" || q.state.data?.status === "running" ? 4000 : false),
  })
  const start = useApiMutation<{ refresh: boolean }, ScoutRun>("/api/scout", { invalidates: [["scout"]] })
  useEffect(() => {
    document.title = "Research scout"
  }, [])

  const data = run.data
  const busy = data?.status === "queued" || data?.status === "running" || start.isPending
  const r = data?.status === "done" ? data.result : undefined
  const left = data?.runs_left ?? 0

  const summary = r ? r.web.summary || "Here is what is worth your attention next." : ""
  const cut = sentenceEnd(summary)
  const lead = cut > 0 ? summary.slice(0, cut) : summary
  const rest = cut > 0 ? summary.slice(cut).trim() : ""
  const typed = useTypewriter(lead)
  const leadPicture = r ? topicPicture(lead, ...r.profile.topics.slice(0, 3)) : null
  const calls = r ? sortCalls(r.web.opportunities) : { open: [], closed: [] }
  const venues = r
    ? [...new Map(r.literature.filter((l) => l.venue).map((l) => [l.venue, r.literature.filter((x) => x.venue === l.venue)])).entries()]
    : []

  const sentence = "What to write next, who to write with and which calls are open, from your papers and the web."
  const jump = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }
  const found: { id: string; n: number; one: string; many: string; zero: string }[] = r
    ? [
        { id: "calls", n: calls.open.length, one: "Open call", many: "Open calls", zero: "No open call ahead" },
        { id: "dirs", n: r.web.directions.length, one: "Direction to grow into", many: "Directions to grow into", zero: "No direction found" },
        { id: "people", n: r.colleagues.length, one: "Colleague to write with", many: "Colleagues to write with", zero: "No colleague found" },
        { id: "people", n: r.web.external_people.length, one: "Person beyond the college", many: "People beyond the college", zero: "Nobody beyond the college" },
      ]
    : []

  return (
    <div className="page space-y-8" data-area="research">
      <PageHeader
        title="Research scout"
        sub={busy ? "Reading your record and searching the web. This takes a minute or two." : sentence}
        spot="hero-research-scout"
        action={
          data && data.status !== "none" ? (
            <Button size="md" disabled={busy || (!!r && left === 0)} onClick={() => start.mutate({ refresh: !!r })}>
              {r ? <RefreshCw aria-hidden /> : <Telescope aria-hidden />}
              {busy ? "Scouting…" : r ? "Scout again" : "Scout for me"}
            </Button>
          ) : null
        }
      />
      {r ? (
        <div role="group" aria-label="At a glance" className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
          {found.map((f, i) => (
            <a key={i} href={`#${f.id}`} onClick={jump(f.id)} className="block min-w-0 rounded-control hover:underline hover:decoration-1 hover:underline-offset-4">
              <span className={cn("figure block text-figure", f.n === 0 && "text-fg-subtle")}>{formatCount(f.n)}</span>
              <span className="mt-0.5 block text-sm text-fg-muted">{f.n === 0 ? f.zero : f.n === 1 ? f.one : f.many}</span>
            </a>
          ))}
        </div>
      ) : null}

      {data?.status === "none" && !busy ? (
        <FirstRun left={left} limit={data.limit} onStart={() => start.mutate({ refresh: false })} />
      ) : null}

      {run.isError && <InlineError message={run.error.message} onRetry={() => void run.refetch()} />}
      {start.isError && <InlineError message={start.error.message} />}
      {data?.status === "failed" && (
        <Callout tone="caution" title="The scout could not finish">
          {data.error}
        </Callout>
      )}
      {busy && (
        <div className="space-y-3">
          <ThinkingIndicator label="Scouting the web" />
          <SkeletonRows rows={6} />
        </div>
      )}

      {r && (
        <>
          <section aria-label="The direction" className="grid items-center gap-6 md:grid-cols-[1fr_14rem]">
            <div className="space-y-4">
              <p className="text-sm text-(--area)">The direction, for {r.profile.name}</p>
              <p className="font-display text-2xl leading-snug text-fg sm:text-[1.75rem]">
                <StreamingText text={typed} />
              </p>
              {rest && <p className="max-w-prose text-fg-muted">{rest}</p>}
            </div>
            {leadPicture && <Picture name={leadPicture} className="hidden w-56 md:block" />}
          </section>

          <Section id="calls" title="Open calls and deadlines" web>
            {calls.open.length === 0 && (
              <Meta className="block">No open call with a date still ahead. Scout again next week.</Meta>
            )}
            <ul className="divide-y divide-(--color-edge)">
              {calls.open.map((c) => <CallRow key={c.o.title} {...c} />)}
            </ul>
            {calls.closed.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-fg-muted">
                  {calls.closed.length} already closed
                </summary>
                <ul className="divide-y divide-(--color-edge)">
                  {calls.closed.map((c) => <CallRow key={c.o.title} {...c} closed />)}
                </ul>
              </details>
            )}
          </Section>

          <Section id="dirs" title="Directions to grow into" web>
            <ol className="space-y-6">
              {r.web.directions.map((d, i) => (
                <li key={d.title} className="grid grid-cols-[2.5rem_1fr] gap-3">
                  <span className="font-display text-2xl leading-none text-fg-subtle">{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 space-y-1">
                    <p className="text-lg font-medium text-fg">{d.title}</p>
                    {d.builds_on && <p className="text-sm text-(--area)">Builds on {d.builds_on}</p>}
                    <p className="max-w-prose text-fg-muted">{d.why}</p>
                    {d.urls.length > 0 && (
                      <div className="flex flex-wrap gap-3 pt-1">
                        {d.urls.map((u) => <SourceLink key={u} url={u} />)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <Section id="people" title="People to work with">
            <div className="grid gap-8 lg:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-medium text-fg">At the college</h3>
                  <Origin web={false} />
                </div>
                <ul className="divide-y divide-(--color-edge)">
                  {r.colleagues.map((c) => (
                    <li key={c.user_id} className="flex gap-3 py-3">
                      <Link to={`/u/${c.user_id}`} aria-hidden tabIndex={-1}>
                        <Avatar person={{ name: c.name, initials: c.initials || initialsOf(c.name), photo_url: c.photo_url ?? null }} />
                      </Link>
                      <div className="min-w-0 space-y-1">
                        <p>
                          <Link to={`/u/${c.user_id}`} className="font-medium hover:underline">{c.name}</Link>
                          <span className="text-sm text-fg-muted"> · {c.department || "No department"} · {c.papers} {c.papers === 1 ? "paper" : "papers"}</span>
                        </p>
                        <p className="text-sm text-fg-muted">You share {c.shared_topics.join(", ")}</p>
                        {c.their_topics.length > 0 && <p className="text-sm text-fg-muted">They bring {c.their_topics.slice(0, 3).join(", ")}</p>}
                        {c.why && <p className="text-sm text-fg">{c.why} <Meta>(suggested by AI)</Meta></p>}
                        <p className="pt-1">
                          <Button kind="quiet" size="sm" asChild>
                            <Link to={`/messages?to=${c.user_id}`} aria-label={`Message ${c.name}`}>
                              <MessageSquare aria-hidden className="size-4" /> Message
                            </Link>
                          </Button>
                        </p>
                      </div>
                    </li>
                  ))}
                  {r.colleagues.length === 0 && (
                    <li className="py-3 text-sm text-fg-muted">No colleague in another department shares your topics yet.</li>
                  )}
                </ul>
              </div>
              <div className="space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-medium text-fg">Beyond the college</h3>
                  <Origin web />
                </div>
                <ul className="divide-y divide-(--color-edge)">
                  {r.web.external_people.map((p) => (
                    <li key={p.name} className="flex gap-3 py-3">
                      <Avatar person={{ name: p.name, initials: initialsOf(p.name), photo_url: null }} />
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium text-fg">{p.name}</p>
                        <p className="text-sm text-(--area)">{p.affiliation}</p>
                        <p className="text-sm text-fg-muted">{p.work}</p>
                        <SourceLink url={p.url} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Section>

          {venues.length > 0 && (
            <Section id="venues" title="Venues publishing the most-cited recent work">
              <Meta className="block">Counted from Scopus on your topics.</Meta>
              <ul className="divide-y divide-(--color-edge)">
                {venues.map(([venue, papers]) => (
                  <li key={venue} className="grid gap-2 py-4 sm:grid-cols-[16rem_1fr] sm:gap-6">
                    <p className="font-medium text-fg">{venue}</p>
                    <ul className="space-y-2">
                      {papers.map((l) => (
                        <li key={l.title}>
                          <a href={l.url || undefined} target="_blank" rel="noreferrer" className="text-fg hover:underline">{l.title}</a>
                          <Meta className="block">
                            {l.first_author}{l.affiliation && ` (${l.affiliation})`} · {l.year} · {l.citations} citations
                          </Meta>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <div className="space-y-2 border-t border-(--color-edge) pt-6 text-sm text-fg-muted">
            <details>
              <summary className="cursor-pointer">All {r.sources.length} web sources the search returned</summary>
              <ul className="mt-2 space-y-1">
                {r.sources.map((s) => (
                  <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.title || s.url}</a></li>
                ))}
              </ul>
            </details>
            <Meta className="block">
              Web findings are gathered by an AI model with web search and can be wrong. Open the source before acting.
              Colleague matches are counted from the college's publication record.
            </Meta>
          </div>
        </>
      )}

      {data && data.status !== "none" ? (
        <p className="text-sm text-fg-muted">
          {left} of {data.limit} runs left today. Results are kept for 24 hours
          {r ? `, last run ${new Date(r.generated_at).toLocaleString()}.` : "."}
          {left === 0 ? " You have used today's runs, so Scout again is off until tomorrow." : ""}
        </p>
      ) : null}
      {run.isLoading ? <SkeletonRows rows={4} /> : null}
    </div>
  )
}
