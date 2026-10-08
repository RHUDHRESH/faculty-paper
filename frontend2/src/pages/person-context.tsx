import { ExternalLink, Gem, MessageCircle, Sparkles, UserRound, UsersRound, Waypoints, BookOpen, Building2, FileText } from "lucide-react"
import { Link } from "react-router-dom"

import { useApi } from "@/lib/query"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { ConnectionPath, type Hop } from "@/ui/connection"

import { PaperCard } from "@/ui/entity"
import { Avatar, initialsOf } from "@/ui/person"
import { InlineError, Skeleton, SkeletonRows } from "@/ui/state"

/**
 * The "Y" view (docs/ux/08, Person context panel): how the viewer is
 * connected to somebody, why they matter, the papers that connect them, and
 * what to do next. Used in the Sheet on Who to work with and embedded on
 * /u/:id for anybody who is not the viewer. `target` is a user id or an
 * external author key; everything is counted from the publication record.
 */

export type ConnectionStep = {
  photo_url?: string | null
  key: string
  user_id: string | null
  name: string
  department: string | null
  has_account: boolean
  is_college_member: boolean
  institution: string | null
  via: { id: string; title: string; year: number | null; doi: string | null }[]
}
export type ConnectionBody = { from: string; to: string; hops: number | null; paths: { people: ConnectionStep[] }[] }
export type WhyBody = { reasons: { kind: string; text: string; refs: string[] }[]; papers: number; your_papers: number }
export type ExternalPerson = {
  key: string
  name: string
  institutions: string[]
  countries: string[]
  orcid: string
  openalex_id: string
  college_affiliated: boolean
  papers_count: number
  papers: {
    id: string
    title: string
    year: number | null
    venue: string
    quartile: string
    doi: string | null
    citations: number
    college_authors: { user_id: string; name: string }[]
  }[]
  college_coauthors: { user_id: string; name: string; department: string | null; papers_together: number; photo_url?: string | null }[]
}

const REASON_ICON: Record<string, typeof Gem> = {
  together: FileText,
  shared_venue: BookOpen,
  topic: Sparkles,
  complement: Building2,
  q1: Gem,
  common_coauthors: UsersRound,
}

/** A user id, not an OpenAlex key ("A123…") or a name key ("n:…"). */
export function isExternalKey(target: string) {
  return /^A\d+$/.test(target) || target.startsWith("n:")
}

export function firstName(name: string) {
  return (name || "").replace(/^(Dr|Mr|Ms|Mrs|Prof)\.?\s+/i, "").replace(/^([A-Z]\.\s*)+/, "").split(/\s+/)[0] || name
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

export function useConnection(meId: string | undefined, target: string | null | undefined) {
  return useApi<ConnectionBody>(
    ["connection", meId, target],
    `/api/people/${meId}/connection?to=${encodeURIComponent(target ?? "")}`,
    { enabled: !!meId && !!target && target !== meId, retry: false, staleTime: 5 * 60_000 }
  )
}

export function useWhy(target: string | null | undefined, enabled = true) {
  return useApi<WhyBody>(["why", target], `/api/people/me/why?of=${encodeURIComponent(target ?? "")}`, {
    enabled: !!target && enabled,
    retry: false,
    staleTime: 5 * 60_000,
  })
}

/** Paths as ConnectionPath hops, shortest first, up to 3. */
export function toHops(body: ConnectionBody | undefined): Hop[][] {
  if (!body?.paths?.length) return []
  return body.paths.slice(0, 3).map((p) =>
    p.people.map((h) => ({
      person: { id: h.user_id ?? undefined, name: h.name, initials: initialsOf(h.name), photo_url: h.photo_url ?? null },
      // Papers only: an institution name here ran under its neighbour's
      // and the labels printed on top of each other in a 320 px rail.
      evidence: h.via?.length ? plural(h.via.length, "paper") : undefined,
    }))
  )
}

/** The first colleague on the shortest path who could make an introduction. */
function introducer(body: ConnectionBody | undefined): ConnectionStep | null {
  if (!body?.paths?.length || body.hops !== 2) return null
  for (const p of body.paths) {
    const x = p.people[1]
    if (x?.user_id && x.has_account) return x
  }
  return null
}

/** The only-external-bridge case the spec says to name explicitly. */
function onlyExternalBridge(body: ConnectionBody | undefined) {
  if (!body?.paths?.length || !body.hops || body.hops < 2) return false
  return body.paths.every((p) => p.people.slice(1, -1).every((h) => !h.has_account))
}

export function introDraft(x: string, y: string, topic: string | null, n: number) {
  return `Hi ${firstName(x)}, would you introduce me to ${y}? I'm working on ${topic || "my research"} and saw you've written ${plural(n, "paper")} with ${firstName(y)}.`
}

/** How you're connected: up to three paths with evidence, or the honest no-path line. */
export function HowConnected({
  meId,
  target,
  name,
  messageTo,
  stacked = false,
}: {
  meId: string
  target: string
  name: string
  messageTo?: string | null
  /** One person per line, for a narrow column; the wide row runs out of room past three people. */
  stacked?: boolean
}) {
  const conn = useConnection(meId, target)
  if (conn.isLoading) return <Skeleton className="h-10 w-64" />
  if (conn.isError) {
    if (conn.error.status === 404)
      return <p className="text-sm text-fg-muted">{name} isn't in the publication record yet, so there's no path to draw.</p>
    return <InlineError message="Could not work out the connection. Nothing was changed." onRetry={() => void conn.refetch()} />
  }
  const hops = toHops(conn.data)
  if (!hops.length) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-fg-muted">You and {firstName(name)} aren't connected within 3 steps yet.</p>
        {messageTo ? (
          <Button kind="default" size="sm" asChild>
            <Link to={messageTo}>Message {firstName(name)}</Link>
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {stacked ? <StackedPaths paths={hops} /> : <ConnectionPath paths={hops} />}
      <p className="text-sm text-fg-muted">
        {conn.data?.hops === 1
          ? `You have written together.`
          : `No paper together yet. You are ${conn.data?.hops} steps apart.`}
        {onlyExternalBridge(conn.data) && " The only people linking you work outside the college."}
      </p>
    </div>
  )
}

/**
 * The same paths as `ConnectionPath`, one person per line with the paper count
 * that links them to the one above. In the 320 px side column the horizontal
 * version cut the last person off at the edge, and a person you cannot see is
 * the person you were looking for.
 */
function StackedPaths({ paths }: { paths: Hop[][] }) {
  return (
    <div className="space-y-3">
      {paths.slice(0, 3).map((path, p) => (
        <ol key={p} className="space-y-1.5">
          {path.map((h, i) => (
            <li key={i} className="flex items-center gap-2 text-sm">
              <Avatar person={h.person} size="sm" />
              <span className="min-w-0 flex-1 truncate">
                {i === 0 ? (
                  <span className="text-fg-muted">You</span>
                ) : h.person.id ? (
                  <Link to={`/u/${h.person.id}`} className="text-fg hover:underline hover:underline-offset-4">
                    {h.person.name}
                  </Link>
                ) : (
                  <span className="text-fg">{h.person.name}</span>
                )}
              </span>
              {h.evidence && <span className="shrink-0 text-xs text-fg-muted">{h.evidence} together</span>}
            </li>
          ))}
        </ol>
      ))}
    </div>
  )
}

export function WhyTheyMatter({ target, name }: { target: string; name: string }) {
  const why = useWhy(target)
  if (why.isLoading) return <SkeletonRows rows={2} rowHeight={24} />
  if (why.isError) return <InlineError message="Could not count the reasons. Nothing was changed." onRetry={() => void why.refetch()} />
  const reasons = why.data?.reasons ?? []
  if (!reasons.length)
    return <p className="text-sm text-fg-muted">Nothing in common on the record yet: no shared venue, topic or co-author with {firstName(name)}.</p>
  return (
    <ul className="space-y-1.5">
      {reasons.map((r) => {
        const Icon = REASON_ICON[r.kind] ?? Sparkles
        return (
          <li key={r.kind} className="flex items-start gap-2 text-sm text-fg">
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-(--area)" strokeWidth={1.75} />
            <span>{r.text}</span>
          </li>
        )
      })}
    </ul>
  )
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Gem; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t border-line pt-4">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-fg-muted">
        <Icon aria-hidden className="size-4 text-(--area)" strokeWidth={1.75} />
        {title}
      </h3>
      {children}
    </section>
  )
}

type Brief = { name: string; sub: string | null; line: string | null; photo_url?: string | null; user_id: string | null }

/**
 * The whole panel. `header` is off when embedded on a profile, which has its
 * own header.
 */
export function PersonContext({
  meId,
  target,
  header = true,
  className,
}: {
  meId: string
  target: string
  header?: boolean
  className?: string
}) {
  const external = isExternalKey(target)
  const ext = useApi<ExternalPerson>(["external-person", target], `/api/external-person?key=${encodeURIComponent(target)}`, {
    enabled: external,
    retry: false,
  })
  const person = useApi<{ person: { id: string; name: string; department: string | null; designation: string | null; photo_url: string | null }; counts?: { papers: number } }>(
    ["person", target],
    `/api/people/${target}`,
    { enabled: !external && header, retry: false }
  )
  const metrics = useApi<{ total_publications: number; total_citations: number | null; h_index: number | null }>(
    ["publication-metrics", target],
    `/api/people/${target}/publication-metrics`,
    { enabled: !external && header, retry: false }
  )
  const conn = useConnection(meId, target)
  const why = useWhy(target)

  const brief: Brief | null = external
    ? ext.data
      ? {
          name: ext.data.name,
          sub: ext.data.institutions[0] ?? (ext.data.college_affiliated ? "Saveetha (former)" : "Outside the college"),
          line: `${plural(ext.data.papers_count, "paper")} in the record`,
          user_id: null,
        }
      : null
    : person.data?.person
      ? {
          name: person.data.person.name,
          sub: [person.data.person.department, person.data.person.designation, "Saveetha"].filter(Boolean).join(" · "),
          line: metrics.data
            ? [
                plural(metrics.data.total_publications, "paper"),
                metrics.data.total_citations != null ? plural(metrics.data.total_citations, "citation") : null,
                metrics.data.h_index != null ? `h ${metrics.data.h_index}` : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : null,
          photo_url: person.data.person.photo_url,
          user_id: person.data.person.id,
        }
      : null

  const name = brief?.name ?? conn.data?.paths?.[0]?.people.at(-1)?.name ?? "them"
  const x = introducer(conn.data)
  const xPapers = x ? (conn.data?.paths.find((p) => p.people[1]?.key === x.key)?.people.at(-1)?.via.length ?? 1) : 0
  const topic = why.data?.reasons.find((r) => r.kind === "topic")?.refs[0] ?? null
  const messageTo = external ? null : `/messages?to=${encodeURIComponent(target)}`

  // The X papers: every paper on the paths, once.
  const seen = new Set<string>()
  const linking = (conn.data?.paths ?? []).flatMap((p) =>
    p.people.flatMap((h, i) =>
      h.via.map((v) => ({ ...v, a: p.people[i - 1]?.name, b: h.name }))
    )
  ).filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)))

  return (
    <div data-area="people" className={cn("space-y-4", className)}>
      {header && (
        <div className="flex items-start gap-4">
          {brief ? (
            <>
              <Avatar person={{ name: brief.name, initials: initialsOf(brief.name), photo_url: brief.photo_url ?? null }} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold text-fg">{brief.name}</p>
                {brief.sub && <p className="text-sm text-fg-muted">{brief.sub}</p>}
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Chip tone={external ? "neutral" : "area"} area="people">
                    {external ? (ext.data?.college_affiliated ? "Saveetha (former)" : "Outside") : "Saveetha"}
                  </Chip>
                  {brief.line && <span className="text-sm text-fg-muted">{brief.line}</span>}
                </div>
              </div>
            </>
          ) : ext.isError || person.isError ? (
            <InlineError message="Could not load who this is. Nothing was changed." onRetry={() => void (external ? ext.refetch() : person.refetch())} />
          ) : (
            <div className="flex-1 space-y-2">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}
        </div>
      )}

      <Section title="How you're connected" icon={Waypoints}>
        <HowConnected meId={meId} target={target} name={name} messageTo={messageTo} />
      </Section>

      <Section title={`Why ${firstName(name)} matters to you`} icon={Sparkles}>
        <WhyTheyMatter target={target} name={name} />
      </Section>

      {external && ext.data && ext.data.college_coauthors.length > 0 && (
        <Section title="Who at the college connects to them" icon={UsersRound}>
          <ul className="space-y-1.5">
            {ext.data.college_coauthors.slice(0, 6).map((c) => (
              <li key={c.user_id} className="flex items-center gap-2 text-sm">
                <Avatar person={{ name: c.name, initials: initialsOf(c.name), photo_url: c.photo_url ?? null }} size="sm" />
                <Link to={`/u/${c.user_id}`} className="min-w-0 truncate text-fg hover:underline hover:underline-offset-4">
                  {c.name}
                </Link>
                <span className="shrink-0 text-fg-muted">
                  {c.department ? `${c.department} · ` : ""}
                  {plural(c.papers_together, "paper")} with {firstName(ext.data!.name)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(linking.length > 0 || (external && ext.data && ext.data.papers.length > 0)) && (
        <Section title={linking.length ? "Papers that connect you" : "Papers with college authors"} icon={FileText}>
          <div className="space-y-2">
            {(linking.length
              ? linking.slice(0, 3).map((v) => ({ id: v.id, title: v.title, year: v.year, venue: null as string | null, cites: null as number | null, line: `${v.a} and ${v.b}` }))
              : ext.data!.papers.slice(0, 3).map((p) => ({
                  id: p.id,
                  title: p.title,
                  year: p.year,
                  venue: p.venue,
                  cites: p.citations,
                  line: p.college_authors.length ? `With ${p.college_authors.map((a) => a.name).join(", ")}` : null,
                }))
            ).map((p) => (
              <PaperCard
                key={p.id}
                title={p.title}
                year={p.year}
                journal={p.venue}
                citations={p.cites}
                authorLine={p.line ? <span>{p.line}</span> : undefined}
              />
            ))}
          </div>
        </Section>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {external ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            <p className="mr-1 text-sm text-fg-muted">{firstName(name)} isn't on this app.</p>
            {ext.data?.openalex_id && (
              <Button kind="default" size="sm" asChild>
                <a href={`https://openalex.org/authors/${ext.data.openalex_id}`} target="_blank" rel="noreferrer">
                  OpenAlex profile <ExternalLink aria-hidden />
                </a>
              </Button>
            )}
            {ext.data?.orcid && (
              <Button kind="default" size="sm" asChild>
                <a href={`https://orcid.org/${ext.data.orcid}`} target="_blank" rel="noreferrer">
                  ORCID <ExternalLink aria-hidden />
                </a>
              </Button>
            )}
          </div>
        ) : (
          <Button kind="primary" size="md" asChild>
            <Link to={messageTo!}>
              <MessageCircle />
              Message {firstName(name)}
            </Link>
          </Button>
        )}
        {x && (
          <Button kind="default" size="md" asChild>
            <Link
              to={`/messages?to=${encodeURIComponent(x.user_id!)}&ctx=${encodeURIComponent(`person:${target}`)}&draft=${encodeURIComponent(introDraft(x.name, name, topic, xPapers))}`}
            >
              <Waypoints />
              Ask {firstName(x.name)} for an intro
            </Link>
          </Button>
        )}
        {!external && header && (
          <Button kind="quiet" size="md" asChild>
            <Link to={`/u/${target}`}>
              <UserRound />
              Profile
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}

