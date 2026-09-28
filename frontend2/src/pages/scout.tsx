import { useEffect } from "react"
import { BookOpen, ExternalLink, Globe, Lightbulb, RefreshCw, Telescope, UsersRound } from "lucide-react"
import { Link } from "react-router-dom"

import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { HeroBand } from "@/ui/hero"
import { Callout, InlineError, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle, Sub } from "@/ui/text"
import { cn } from "@/lib/cn"
import { STAGGER_CAP } from "@/ui/motion/list"
import { StreamingText, ThinkingIndicator, useTypewriter } from "@/ui/motion/stream"

type Source = { url: string; title: string }
type ScoutResult = {
  profile: { name: string; department: string; papers: number; citations: number; h_index: number; topics: string[] }
  web: {
    summary: string
    opportunities: { title: string; kind: string; why: string; deadline: string; url: string }[]
    directions: { title: string; builds_on: string; why: string; urls: string[] }[]
    external_people: { name: string; affiliation: string; work: string; url: string }[]
  }
  literature: { topic: string; title: string; year: number | null; venue: string; first_author: string; affiliation: string; citations: number; url: string }[]
  colleagues: { user_id: string; name: string; department: string; papers: number; shared_topics: string[]; their_topics: string[]; why: string; picked: boolean }[]
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
  if (!url) return <Meta>No link found — check before relying on it</Meta>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
      {host(url)}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  )
}

function Origin({ web }: { web: boolean }) {
  return web ? (
    <Chip tone="area" icon={Globe}>From the web</Chip>
  ) : (
    <Chip tone="neutral" icon={BookOpen}>From our records</Chip>
  )
}

function Card({ children, i = 0 }: { children: React.ReactNode; i?: number }) {
  return (
    <li
      className={cn("hover-lift rounded-xl bg-surface p-4 shadow-[inset_0_0_0_1px_var(--color-edge)]", i < STAGGER_CAP && "stagger-in")}
      style={{ animationDelay: `${Math.min(i, STAGGER_CAP) * 30}ms` }}
    >
      {children}
    </li>
  )
}

/**
 * Research scout: Claude searches the web from the person's own record and
 * says what to work on next and with whom. Web findings and our own records
 * are labelled apart; links are only the ones the search actually returned.
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
  const typed = useTypewriter(r ? r.web.summary || "Here is what is worth your attention next." : "")

  const sentence = busy
    ? "Reading your record and searching the web. This takes a minute or two."
    : r
      ? <StreamingText text={typed} />
      : "Next-level problems, open calls, and people to work with — from your papers and the web."

  return (
    <div className="page space-y-6" data-area="research">
      <HeroBand spot="hero-research-scout"
        area="research"
        eyebrow="Research"
        title="Research scout"
        sentence={sentence}
        actions={
          <Button size="lg" disabled={busy || (!!r && left === 0)} onClick={() => start.mutate({ refresh: !!r })}>
            {r ? <RefreshCw aria-hidden /> : <Telescope aria-hidden />}
            {busy ? "Scouting…" : r ? "Scout again" : "Scout for me"}
          </Button>
        }
      >
        <p className="mt-3 text-sm text-fg-muted">
          {left} of {data?.limit ?? 5} runs left today · results are kept for 24 hours
          {r && ` · last run ${new Date(r.generated_at).toLocaleString()}`}
        </p>
      </HeroBand>

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
          <section className="space-y-3" aria-labelledby="opps">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle><span id="opps">Open now</span></SectionTitle>
              <Origin web />
            </div>
            <ul className="grid gap-3 md:grid-cols-2">
              {r.web.opportunities.map((o, i) => (
                <Card key={o.title} i={i}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone="area">{KIND[o.kind] ?? o.kind}</Chip>
                    {o.deadline && <Chip tone="caution">Deadline {o.deadline}</Chip>}
                  </div>
                  <p className="mt-2 font-medium">{o.title}</p>
                  <Sub className="mt-1">{o.why}</Sub>
                  <div className="mt-2"><SourceLink url={o.url} /></div>
                </Card>
              ))}
            </ul>
          </section>

          <section className="space-y-3" aria-labelledby="dirs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle><span id="dirs">Where your work can go next</span></SectionTitle>
              <Origin web />
            </div>
            <ul className="space-y-3">
              {r.web.directions.map((d, i) => (
                <Card key={d.title} i={i}>
                  <p className="flex items-start gap-2 font-medium">
                    <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-(--area)" />
                    {d.title}
                  </p>
                  {d.builds_on && <Meta>Builds on: {d.builds_on}</Meta>}
                  <Sub className="mt-1">{d.why}</Sub>
                  <div className="mt-2 flex flex-wrap gap-3">
                    {d.urls.map((u) => <SourceLink key={u} url={u} />)}
                  </div>
                </Card>
              ))}
            </ul>
          </section>

          <section className="space-y-3" aria-labelledby="cols">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle><span id="cols">Colleagues in other departments</span></SectionTitle>
              <Origin web={false} />
            </div>
            <ul className="grid gap-3 md:grid-cols-2">
              {r.colleagues.map((c, i) => (
                <Card key={c.user_id} i={i}>
                  <div className="flex items-center justify-between gap-2">
                    <Link to={`/u/${c.user_id}`} className="font-medium hover:underline">{c.name}</Link>
                    <Chip tone="neutral" icon={UsersRound}>{c.department || "—"}</Chip>
                  </div>
                  <Meta>{c.papers} papers · you share {c.shared_topics.join(", ")}</Meta>
                  {c.their_topics.length > 0 && <Sub className="mt-1">They bring: {c.their_topics.join(", ")}</Sub>}
                  {c.why && <p className="mt-2 text-sm">{c.why} <Meta>(suggested by AI)</Meta></p>}
                </Card>
              ))}
              {r.colleagues.length === 0 && <Sub>No colleague in another department shares your topics yet.</Sub>}
            </ul>
          </section>

          <section className="space-y-3" aria-labelledby="ext">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle><span id="ext">Researchers outside the college</span></SectionTitle>
              <Origin web />
            </div>
            <ul className="grid gap-3 md:grid-cols-2">
              {r.web.external_people.map((p, i) => (
                <Card key={p.name} i={i}>
                  <p className="font-medium">{p.name}</p>
                  <Meta>{p.affiliation}</Meta>
                  <Sub className="mt-1">{p.work}</Sub>
                  <div className="mt-2"><SourceLink url={p.url} /></div>
                </Card>
              ))}
            </ul>
          </section>

          {r.literature.length > 0 && (
            <section className="space-y-3" aria-labelledby="lit">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SectionTitle><span id="lit">Most-cited recent papers on your topics</span></SectionTitle>
                <Chip tone="neutral" icon={BookOpen}>From Scopus</Chip>
              </div>
              <ul className="divide-y divide-(--color-edge) rounded-xl bg-surface shadow-[inset_0_0_0_1px_var(--color-edge)]">
                {r.literature.map((l) => (
                  <li key={l.title} className="p-4">
                    <a href={l.url || undefined} target="_blank" rel="noreferrer" className="font-medium hover:underline">{l.title}</a>
                    <Meta className="block">
                      {l.first_author}{l.affiliation && ` (${l.affiliation})`} · {l.venue} {l.year} · {l.citations} citations
                    </Meta>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <details className="text-sm text-fg-muted">
            <summary className="cursor-pointer">All {r.sources.length} web sources the search returned</summary>
            <ul className="mt-2 space-y-1">
              {r.sources.map((s) => (
                <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.title || s.url}</a></li>
              ))}
            </ul>
          </details>
          <Meta className="block">
            Web findings are gathered by an AI model with web search and can be wrong — open the source before acting. Colleague matches are counted from the college's publication record.
          </Meta>
        </>
      )}
    </div>
  )
}
