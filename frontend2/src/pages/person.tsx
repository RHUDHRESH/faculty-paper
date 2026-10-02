import { useEffect, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  Camera,
  ExternalLink,
  FileText,
  Handshake,
  Mail,
  Pencil,
  Quote,
  Search,
  UserCheck,
  UserPlus,
  Users,
  UsersRound,
  Waypoints,
} from "lucide-react"

import { firstName, HowConnected, WhyTheyMatter } from "@/pages/person-context"
import { Chip } from "@/ui/chip"
import { initialsOf } from "@/ui/person"
import { Picture, topicPicture } from "@/ui/picture"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/ui/sheet"

import { CollabDialog } from "@/pages/chat"
import {
  BadgeStrip,
  Collaborations,
  CompletenessMeter,
  PinDialog,
  PinnedPapers,
  Skills,
  type Collaboration,
  type Completeness,
  type Skill,
} from "@/pages/person-social"
import { StatsCard, type StatsSummary } from "@/pages/stats"

import { useAuth } from "@/app/auth"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { ResearchThresholdPanel } from "@/pages/research-faculty"
import { ThresholdCard, type ThresholdSummary } from "@/ui/research-threshold"
import { Interests } from "@/pages/profile"
import { PostCard, useFeed, type FeedPost } from "@/pages/feed"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, Field, Input, Textarea } from "@/ui/field"
import { Pagination } from "@/ui/pagination"
import { Avatar, PersonLink, type PersonBrief } from "@/ui/person"
import { EmptyState, ErrorState, InlineError, Skeleton, SkeletonRows, SkeletonText } from "@/ui/state"
import { Figure, Meta, PageTitle, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { unshout } from "@/lib/names"

/**
 * A colleague's public profile (`/u/:id`), and the directory of everybody
 * (`/u`).
 *
 * The owner's words: faculty should be able to view others' profiles like
 * Facebook — that is the point of the discussions. So anybody signed in can
 * open anybody's page, and it shows who they are, what they have published,
 * who they wrote it with and what they have been posting.
 *
 * Never money, for anybody looking: `/api/people/{id}` carries no amount, no
 * ticket number and no stage in the chain, so there is nothing here to hide
 * per role. The research-post setting is the one private part, and the
 * server sends it only to the person themself and to the research
 * coordinator or super admin who set it (`research_post`).
 *
 * The office's own record of a person — payments and all — stays at
 * `/people/:id`, reached from here only by those who may open it.
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

type ProfilePaper = {
  id: string
  title: string
  journal_title: string | null
  publication_year: number | null
  quartile: string | null
  doi: string | null
  author_position: number | null
  total_authors: number | null
  coauthors: { id: string; name: string }[]
}

type ResearchPost = {
  research_faculty: boolean
  may_edit: boolean
  /** The research coordinator and the super admin set the rupee threshold. */
  may_set_threshold: boolean
  threshold: ThresholdSummary | null
}

export type Profile = {
  person: PersonBrief & {
    role_label: string
    bio: string | null
    interests: string[]
    scopus_url: string | null
    orcid_id: string | null
    orcid_url: string | null
    scholar_url?: string | null
    research_faculty: boolean
  }
  is_me: boolean
  papers: ProfilePaper[]
  counts: { papers: number; q1: number; first_author: number; areas: number }
  areas: { key: string; count: number }[]
  coauthors: (PersonBrief & { together: number })[]
  follow: { following: boolean; followers: number; following_count: number }
  posts: FeedPost[]
  research_post: ResearchPost | null
  may_open_record: boolean
  skills: Skill[]
  pinned: NonNullable<FeedPost["paper"]>[]
  collaborations: Collaboration[]
  /** Your own profile only; null on anybody else's. */
  completeness: Completeness | null
  stats: StatsSummary | null
}

type PersonCard = PersonBrief & { interests: string[]; skills?: string[]; papers: number; following: boolean }

type Directory = { total: number; limit: number; offset: number; results: PersonCard[] }

/** How many papers show before "Show all". */
const PAPERS_SHOWN = 8


/* ------------------------------------------------------------------------ */
/* The profile                                                               */
/* ------------------------------------------------------------------------ */

export function PublicProfile() {
  const { id = "me" } = useParams<{ id: string }>()
  const query = useApi<Profile>(["person", id], `/api/people/${id}`)

  if (query.isPending) {
    return (
      <div className="page max-w-3xl space-y-8">
        <div className="flex items-center gap-4">
          <Skeleton className="size-24 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        </div>
        <SkeletonText lines={5} />
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="page max-w-3xl">
        <ErrorState
          title={query.error.status === 404 ? "Nobody here by that link" : "Could not load this profile"}
          message={
            query.error.status === 404
              ? "The account may have been closed, or the link is wrong. Search for them by name instead."
              : "The server did not answer. Nothing has been lost."
          }
          onRetry={query.error.status === 404 ? false : () => void query.refetch()}
        />
        <div className="mt-4 text-center">
          <Button kind="default" size="md" asChild>
            <Link to="/u">Find people</Link>
          </Button>
        </div>
      </div>
    )
  }

  return <ProfileView data={query.data} routeId={id} />
}

type Metrics = {
  total_publications: number
  total_citations: number | null
  h_index: number | null
  i10_index: number | null
}
type RecordPaper = {
  id: string
  year: number | null
  citations: number | null
  title: string
  venue?: string | null
  quartile?: string | null
  doi?: string | null
}
type Coauthor = {
  key: string
  user_id: string | null
  name: string
  department: string | null
  papers_together: number
  institutions: string[]
  has_account: boolean
  is_college_member: boolean
  photo_url?: string | null
}
type CoauthorsBody = { inside?: Coauthor[]; outside?: Coauthor[] }

type ProfileTab = "papers" | "research" | "activity"

function ProfileView({ data, routeId }: { data: Profile; routeId: string }) {
  const { person } = data
  const viewerId = useAuth().me?.id ?? ""
  const [editing, setEditing] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [addingSkill, setAddingSkill] = useState(false)
  const [proposing, setProposing] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [tab, setTab] = useState<ProfileTab>("papers")

  const metrics = useApi<Metrics>(["publication-metrics", person.id], `/api/people/${person.id}/publication-metrics`, {
    retry: false,
  })
  const record = useApi<{ publications?: RecordPaper[] }>(
    ["person-publications", person.id],
    `/api/people/${person.id}/publications?sort=year`,
    { retry: false, staleTime: 5 * 60_000 }
  )
  const coauthors = useApi<CoauthorsBody>(["coauthors", person.id], `/api/people/${person.id}/coauthors`, {
    retry: false,
  })

  function act(action: string) {
    setFinishing(false)
    if (action === "edit") setEditing(true)
    else if (action === "pins") setPinning(true)
    else if (action === "skills") {
      setAddingSkill(true)
      document.getElementById("skills")?.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }

  const m = metrics.data && typeof metrics.data.total_publications === "number" ? metrics.data : null
  const cites = record.data?.publications ? citationsByYear(record.data.publications) : null
  const tabs: { id: ProfileTab; label: string }[] = [
    { id: "papers", label: "Papers" },
    { id: "research", label: "Research" },
    { id: "activity", label: "Activity" },
  ]

  return (
    <div data-area="people" className="page space-y-6">
      <header className="grid gap-6 border-b border-line pb-8 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-10">
        <Avatar
          person={person}
          size="xl"
          className="size-36 rounded-2xl text-5xl sm:size-48"
        />
        <div className="min-w-0 space-y-4">
          <div>
            <h1 className="honour text-[2rem] leading-[1.15] sm:text-honour">{person.name}</h1>
            <p className="mt-1.5 text-base text-fg-muted">
              {[person.designation, person.department].filter(Boolean).join(", ") || person.role_label}
              {person.research_faculty && (
                <span className="ml-2 inline-flex items-center rounded-sm bg-accent-wash px-1.5 py-0.5 align-middle text-xs font-medium text-fg">
                  Research faculty
                </span>
              )}
            </p>
          </div>
          {person.bio && (
            <p className="max-w-[62ch] whitespace-pre-wrap text-[15px] leading-relaxed text-fg">{person.bio}</p>
          )}
          <ProfileLinks person={person} />
          {person.interests.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {person.interests.map((i) => (
                <Link
                  key={i}
                  to={`/search?scope=people&q=${encodeURIComponent(i)}`}
                  className="rounded-full bg-sunken px-2.5 py-1 text-xs font-medium text-fg-muted ring-1 ring-inset ring-transparent hover:bg-hover hover:text-fg hover:ring-edge active:bg-active"
                >
                  {i}
                </Link>
              ))}
            </div>
          )}
          <FollowBar data={data} routeId={routeId} onEdit={() => setEditing(true)} onPropose={() => setProposing(true)} />
        </div>
      </header>

      <dl className="flex flex-wrap gap-x-10 gap-y-4" aria-label="Record">
        {[
          { label: "Papers", value: m ? m.total_publications : data.counts.papers },
          { label: "Citations", value: m ? (m.total_citations ?? 0) : metrics.isLoading ? null : "Not yet" },
          { label: "h-index", value: m ? (m.h_index ?? 0) : metrics.isLoading ? null : "Not yet" },
          { label: "i10-index", value: m ? (m.i10_index ?? 0) : metrics.isLoading ? null : "Not yet" },
        ].map((x) => (
          <div key={x.label} className="flex flex-col-reverse">
            <dt className="text-sm text-fg-muted">{x.label}</dt>
            <dd className="honour tabular text-[1.75rem] leading-tight text-fg">
              {x.value === null ? <Skeleton className="h-7 w-12" /> : x.value}
            </dd>
          </div>
        ))}
      </dl>

      {data.completeness && data.completeness.score < 100 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sunken px-4 py-2 text-sm">
          <span className="text-fg-muted">
            <span className="font-medium text-fg">Profile {data.completeness.score}%</span>
            {(() => {
              const missing = data.completeness.items.filter((i) => !i.done).map((i) => i.label.toLowerCase())
              return missing.length ? ` · still to add: ${missing.slice(0, 3).join(", ")}` : ""
            })()}
          </span>
          <Button kind="default" size="sm" onClick={() => setFinishing(true)}>
            Finish profile
            <ArrowRight />
          </Button>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {data.research_post && (
            <ResearchPostPanel personId={person.id} name={person.name} routeId={routeId} post={data.research_post} isMe={data.is_me} />
          )}

          <BadgeStrip userId={person.id} own={data.is_me} />

          <div role="tablist" aria-label="Profile" className="flex gap-1 border-b border-line">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "-mb-px h-11 rounded-t-control border-b-[3px] px-3 text-sm transition-colors duration-[var(--dur-1)]",
                  tab === t.id
                    ? "border-(--area) bg-hover/60 font-semibold text-fg"
                    : "border-transparent font-medium text-fg-muted hover:border-control-edge hover:bg-hover/60 hover:text-fg active:bg-active"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "papers" && (
            <div className="space-y-8">
              <PinnedPapers pinned={data.pinned ?? []} isMe={data.is_me} onChoose={() => setPinning(true)} />
              {record.isLoading ? (
                <SkeletonRows rows={5} />
              ) : record.data?.publications?.length ? (
                <PublishedWork papers={record.data.publications} />
              ) : (
                <Papers papers={data.papers} isMe={data.is_me} name={person.name} />
              )}
            </div>
          )}
          {tab === "research" && (
            <div className="space-y-8">
              <Counts counts={data.counts} />
              {data.areas.length > 0 && (
                <section className="space-y-3">
                  <SectionTitle>Topics</SectionTitle>
                  <ul className="space-y-2">
                    {data.areas.map((a) => (
                      <li key={a.key} className="flex items-center gap-3 text-sm">
                        <span className="w-48 shrink-0 truncate text-fg">{a.key}</span>
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                          <span
                            className="block h-full rounded-full bg-(--area-fill,var(--area))"
                            style={{ width: `${(a.count / Math.max(1, ...data.areas.map((x) => x.count))) * 100}%` }}
                          />
                        </span>
                        <span className="w-8 text-right tabular text-fg-muted">{a.count}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <Collaborations
                collaborations={data.collaborations ?? []}
                routeId={routeId}
                onPropose={data.is_me ? undefined : () => setProposing(true)}
              />
            </div>
          )}
          {tab === "activity" && <Posts data={data} />}
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          {!data.is_me && viewerId && (
            <RailCard title="How you're connected" icon={Waypoints}>
              <HowConnected stacked meId={viewerId} target={person.id} name={person.name} messageTo={`/messages?to=${person.id}`} />
              <details className="group mt-3">
                <summary className="cursor-pointer text-sm text-accent">Why {firstName(person.name)} matters to you</summary>
                <div className="mt-2">
                  <WhyTheyMatter target={person.id} name={person.name} />
                </div>
              </details>
            </RailCard>
          )}
          <RailCard title="Co-authors" icon={UsersRound}>
            <CoauthorRail query={coauthors} fallback={data.coauthors} />
          </RailCard>
          <RailCard title="Citations per year" icon={Quote} className="lg:order-first">
            {record.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : cites && cites.length > 0 ? (
              <CitationBars rows={cites} />
            ) : (
              <p className="text-sm text-fg-muted">No citations on {firstName(person.name)}'s record yet.</p>
            )}
          </RailCard>
          <div id="skills">
            <Skills
              skills={data.skills ?? []}
              isMe={data.is_me}
              name={person.name}
              routeId={routeId}
              adding={addingSkill}
              onAdding={setAddingSkill}
            />
          </div>
          {data.stats && (
            <details className="panel px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-fg">Only you see this</summary>
              <div className="mt-3">
                <StatsCard stats={data.stats} />
              </div>
            </details>
          )}
        </aside>
      </div>

      {finishing && data.completeness && (
        <Sheet open onOpenChange={(v) => !v && setFinishing(false)}>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Finish your profile</SheetTitle>
              <SheetDescription>Complete profiles come first in people search and suggestions.</SheetDescription>
            </SheetHeader>
            <SheetBody className="overflow-y-auto">
              <CompletenessMeter completeness={data.completeness} onAction={act} />
            </SheetBody>
          </SheetContent>
        </Sheet>
      )}
      {editing && <EditProfile data={data} routeId={routeId} onClose={() => setEditing(false)} />}
      {pinning && (
        <PinDialog papers={data.papers} pinned={data.pinned ?? []} routeId={routeId} onClose={() => setPinning(false)} />
      )}
      {proposing && <CollabDialog person={person} onClose={() => setProposing(false)} />}
    </div>
  )
}

/** Scopus, ORCID and Google Scholar as quiet marks, each labelled for screen readers and on hover. */
function ProfileLinks({ person }: { person: Profile["person"] }) {
  const links = [
    person.scopus_url && { href: person.scopus_url, mark: "Sc", label: "Scopus profile" },
    person.orcid_url && { href: person.orcid_url, mark: "iD", label: `ORCID ${person.orcid_id ?? ""}`.trim() },
    person.scholar_url && { href: person.scholar_url, mark: "GS", label: "Google Scholar profile" },
  ].filter(Boolean) as { href: string; mark: string; label: string }[]
  if (!links.length) return null
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label="Research profiles elsewhere">
      {links.map((l) => (
        <li key={l.mark}>
          <a
            href={l.href}
            target="_blank"
            rel="noreferrer"
            title={l.label}
            aria-label={`${l.label} (opens in a new tab)`}
            className="group inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-2.5 text-xs text-fg-muted hover:border-fg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="font-semibold tracking-tight text-fg">{l.mark}</span>
            <span className="max-sm:sr-only">{l.label.split(" ")[0] === "Google" ? "Scholar" : l.label.split(" ")[0]}</span>
            <ExternalLink className="size-3 opacity-60" aria-hidden />
          </a>
        </li>
      ))}
    </ul>
  )
}

function RailCard({
  title,
  icon: Icon,
  children,
  className,
}: {
  title: string
  icon: typeof Quote
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("panel space-y-3 p-4", className)}>
      <h2 className="flex items-center gap-1.5 text-sm font-medium text-fg-muted">
        <Icon aria-hidden className="size-4 text-(--area)" strokeWidth={1.75} />
        {title}
      </h2>
      {children}
    </section>
  )
}

/** Citations earned by the papers published in each year (OpenAlex gives current counts, not a history). */
function citationsByYear(papers: RecordPaper[]) {
  const by = new Map<number, { year: number; citations: number; papers: RecordPaper[] }>()
  for (const p of papers) {
    if (!p.year) continue
    const row = by.get(p.year) ?? { year: p.year, citations: 0, papers: [] }
    row.citations += p.citations ?? 0
    row.papers.push(p)
    by.set(p.year, row)
  }
  return [...by.values()].sort((a, b) => a.year - b.year).slice(-10)
}

function CitationBars({ rows }: { rows: ReturnType<typeof citationsByYear> }) {
  const [open, setOpen] = useState<number | null>(null)
  const top = Math.max(1, ...rows.map((r) => r.citations))
  const picked = rows.find((r) => r.year === open)
  return (
    <div>
      <div className="flex h-24 items-end gap-1" role="list" aria-label="Citations to papers published each year">
        {rows.map((r) => (
          <button
            key={r.year}
            type="button"
            role="listitem"
            aria-label={`${r.year}: ${r.citations} citation${r.citations === 1 ? "" : "s"}`}
            aria-pressed={open === r.year}
            onClick={() => setOpen(open === r.year ? null : r.year)}
            className="tap-exempt flex h-full min-w-0 flex-1 flex-col justify-end"
            title={`${r.year} · ${r.citations} citation${r.citations === 1 ? "" : "s"}`}
          >
            <span
              className={cn("block w-full rounded-t-sm", open === r.year ? "bg-(--area)" : "bg-(--area-line)")}
              style={{ height: `${Math.max(3, (r.citations / top) * 100)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular text-fg-subtle">
        <span>{rows[0]?.year}</span>
        <span>{rows.at(-1)?.year}</span>
      </div>
      {picked && (
        <div className="mt-2 rounded-md bg-sunken p-2 text-xs">
          <p className="font-medium text-fg">
            {picked.year} · {picked.citations} citations
          </p>
          <ul className="mt-1 space-y-0.5 text-fg-muted">
            {picked.papers
              .sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0))
              .slice(0, 5)
              .map((p) => (
                <li key={p.id} className="line-clamp-1">
                  {p.citations ?? 0} · {unshout(p.title)}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function CoauthorRail({
  query,
  fallback,
}: {
  query: ReturnType<typeof useApi<CoauthorsBody>>
  fallback: Profile["coauthors"]
}) {
  if (query.isLoading) return <SkeletonRows rows={3} rowHeight={32} />
  const inside = Array.isArray(query.data?.inside) ? query.data!.inside : null
  const outside = Array.isArray(query.data?.outside) ? query.data!.outside : []
  const rows: {
    key: string
    name: string
    photo_url?: string | null
    to: string | null
    papers: number
    inside: boolean
    where: string | null
  }[] =
    inside
      ? [...inside.map((c) => ({ ...c, inside: true })), ...outside.map((c) => ({ ...c, inside: false }))]
          .sort((a, b) => b.papers_together - a.papers_together)
          .map((c) => ({
            key: c.key,
            name: c.name,
            photo_url: c.photo_url ?? null,
            to: c.user_id ? `/u/${c.user_id}` : null,
            papers: c.papers_together,
            inside: c.inside,
            where: c.inside ? c.department : (c.institutions[0] ?? null),
          }))
      : fallback.map((c) => ({ key: c.id, name: c.name, photo_url: c.photo_url, to: `/u/${c.id}`, papers: c.together, inside: true, where: c.department ?? null }))
  if (!rows.length) return <p className="text-sm text-fg-muted">Nobody on the record yet.</p>
  return (
    <div className="space-y-2">
      {inside && (
        <p className="text-xs text-fg-muted">
          {inside.length} at the college · {outside.length} outside
        </p>
      )}
      <ul className="space-y-2">
        {rows.slice(0, 8).map((c) => (
          <li key={c.key} className="flex items-center gap-2">
            <Avatar person={{ name: c.name, initials: initialsOf(c.name), photo_url: c.photo_url ?? null }} size="md" />
            <span className="min-w-0 flex-1">
              {c.to ? (
                <Link to={c.to} className="block truncate text-sm text-fg hover:underline hover:underline-offset-4">
                  {c.name}
                </Link>
              ) : (
                <Link
                  to={`/collaborate?person=${encodeURIComponent(c.key)}`}
                  className="block truncate text-sm text-fg hover:underline hover:underline-offset-4"
                >
                  {c.name}
                </Link>
              )}
              <span className="block truncate text-xs text-fg-muted">
                {[c.where, `${c.papers} paper${c.papers === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
              </span>
            </span>
            {/* Only the exception is marked: everybody at the college is the default. */}
            {!c.inside && (
              <Chip tone="neutral" area="people">
                Outside
              </Chip>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function FollowBar({
  data,
  routeId,
  onEdit,
  onPropose,
}: {
  data: Profile
  routeId: string
  onEdit: () => void
  onPropose: () => void
}) {
  const qc = useQueryClient()
  const key = ["person", routeId]
  const follow = useMutation<{ following: boolean; followers: number }, ApiError, boolean>({
    mutationFn: (next) => api(`/api/follows/people/${data.person.id}`, { method: next ? "POST" : "DELETE" }),
    onMutate: (next) => {
      qc.setQueryData<Profile>(key, (d) =>
        d
          ? {
              ...d,
              follow: {
                ...d.follow,
                following: next,
                followers: Math.max(0, d.follow.followers + (next ? 1 : -1)),
              },
            }
          : d
      )
    },
    onSuccess: (r) => {
      qc.setQueryData<Profile>(key, (d) => (d ? { ...d, follow: { ...d.follow, ...r } } : d))
      void qc.invalidateQueries({ queryKey: ["feed", "following"] })
    },
    onError: (err, next) => {
      qc.setQueryData<Profile>(key, (d) =>
        d
          ? {
              ...d,
              follow: {
                ...d.follow,
                following: !next,
                followers: Math.max(0, d.follow.followers + (next ? -1 : 1)),
              },
            }
          : d
      )
      toast.fail(err)
    },
  })

  const { following, followers, following_count } = data.follow

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
      <Meta className="text-sm">
        <span className="tabular font-medium text-fg">{followers}</span> follower{followers === 1 ? "" : "s"} ·{" "}
        <span className="tabular font-medium text-fg">{following_count}</span> following
      </Meta>
      <div className="flex flex-wrap gap-2">
        {data.is_me ? (
          <>
            <Button kind="default" size="md" onClick={onEdit}>
              <Pencil />
              Edit profile
            </Button>
            <Button kind="quiet" size="md" asChild>
              <Link to="/me">Account details</Link>
            </Button>
          </>
        ) : (
          <>
            <Button
              kind={following ? "default" : "primary"}
              size="md"
              aria-pressed={following}
              onClick={() => follow.mutate(!following)}
            >
              {following ? <UserCheck /> : <UserPlus />}
              {following ? "Following" : "Follow"}
            </Button>
            <Button kind="default" size="md" asChild>
              <Link to={`/messages?to=${data.person.id}`}>
                <Mail />
                Message
              </Link>
            </Button>
            <Button kind="default" size="md" onClick={onPropose}>
              <Handshake />
              Collaborate
            </Button>
            {data.may_open_record && (
              <Button kind="quiet" size="md" asChild>
                <Link to={`/people/${data.person.id}`}>Office record</Link>
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Counts({ counts }: { counts: Profile["counts"] }) {
  const items = [
    { label: counts.papers === 1 ? "paper" : "papers", value: counts.papers },
    { label: "in Q1 journals", value: counts.q1 },
    { label: "as first author", value: counts.first_author },
  ]
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-2">
      {items.map((i) => (
        <span key={i.label} className="flex items-baseline gap-2">
          <Figure className="text-2xl">{i.value}</Figure>
          <Meta>{i.label}</Meta>
        </span>
      ))}
    </div>
  )
}

const RECORD_STEP = 10

/**
 * The full publication record (GET /api/people/{id}/publications), newest
 * year first, grouped by year: 10 at a time, then "Show more". Never money.
 */
export function PublishedWork({ papers }: { papers: RecordPaper[] }) {
  const [shown, setShown] = useState(RECORD_STEP)
  const groups: { year: string; rows: RecordPaper[] }[] = []
  for (const p of papers.slice(0, shown)) {
    const year = p.year ? String(p.year) : "Undated"
    const last = groups[groups.length - 1]
    if (last && last.year === year) last.rows.push(p)
    else groups.push({ year, rows: [p] })
  }
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <SectionTitle>Published work</SectionTitle>
        <Meta>{papers.length === 1 ? "1 paper" : `${papers.length} papers`}</Meta>
      </div>
      {groups.map((g) => (
        <div key={g.year} className="space-y-1">
          <h3 className="text-sm font-semibold text-fg-muted">{g.year}</h3>
          <ul className="divide-y divide-line border-y border-line">
            {g.rows.map((p) => (
              <li key={p.id} className="flex min-w-0 items-start gap-4 py-3">
                {(() => {
                  const pic = topicPicture(p.title, p.venue)
                  return pic ? (
                    <Picture name={pic} className="size-14 shrink-0 rounded-md object-cover max-sm:hidden" />
                  ) : (
                    <span className="size-14 shrink-0 rounded-md bg-sunken max-sm:hidden" aria-hidden />
                  )
                })()}
                <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-base break-words">
                  {p.doi ? (
                    <a
                      href={`https://doi.org/${p.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline-offset-4 hover:underline"
                    >
                      {unshout(p.title)}
                    </a>
                  ) : (
                    p.title
                  )}
                </p>
                <Meta className="block">
                  {[p.venue, p.quartile, p.citations ? `${p.citations} citation${p.citations === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
                </Meta>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {papers.length > shown && (
        <Button kind="quiet" size="sm" onClick={() => setShown((n) => n + RECORD_STEP)}>
          Show more ({papers.length - shown} left)
        </Button>
      )}
    </section>
  )
}

/**
 * Their own published and filed work — by title, journal, year and
 * quartile, with the colleagues who filed the same paper. Nothing about
 * where a paper is in the chain: to a colleague a filed paper is published
 * work, and which desk has it is the college's business.
 */
export function Papers({ papers, isMe, name }: { papers: ProfilePaper[]; isMe: boolean; name: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? papers : papers.slice(0, PAPERS_SHOWN)

  return (
    <section className="space-y-3">
      <SectionTitle>Published work</SectionTitle>
      {papers.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={isMe ? "Nothing filed yet" : "Nothing filed here yet"}
          message={
            isMe
              ? "Papers you file appear here for colleagues to see: title, journal and year, never what they paid."
              : `When ${name} files a paper with the college it appears here.`
          }
          action={
            isMe ? (
              <Button kind="primary" size="sm" asChild>
                <Link to="/papers/new">File a paper</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-line border-y border-line">
            {shown.map((p) => (
              <li key={p.id} className="space-y-0.5 py-3">
                <p className="text-base">
                  {p.doi ? (
                    <a
                      href={`https://doi.org/${p.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline-offset-4 hover:underline"
                    >
                      {unshout(p.title)}
                    </a>
                  ) : (
                    p.title
                  )}
                </p>
                <Meta className="block">
                  {[
                    p.journal_title,
                    p.publication_year,
                    p.quartile,
                    p.author_position && p.total_authors
                      ? `author ${p.author_position} of ${p.total_authors}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Meta>
                {p.coauthors.length > 0 && (
                  <Meta className="block text-xs">
                    With{" "}
                    {p.coauthors.map((c, i) => (
                      <span key={c.id}>
                        {i > 0 ? ", " : ""}
                        <PersonLink id={c.id} name={c.name} className="font-normal text-fg-muted" />
                      </span>
                    ))}
                  </Meta>
                )}
              </li>
            ))}
          </ul>
          {papers.length > PAPERS_SHOWN && (
            <Button kind="quiet" size="sm" onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer" : `Show all ${papers.length}`}
            </Button>
          )}
        </>
      )}
    </section>
  )
}

function Posts({ data }: { data: Profile }) {
  const [more, setMore] = useState(false)
  const older = useFeed("everyone", more ? data.person.id : undefined)
  const posts = more ? (older.data?.pages.flatMap((p) => p.results) ?? data.posts) : data.posts

  return (
    <section className="space-y-3">
      <SectionTitle>Posts</SectionTitle>
      {posts.length === 0 ? (
        <EmptyState
          icon={Users}
          title={data.is_me ? "You have not posted yet" : "No posts yet"}
          message={
            data.is_me
              ? "Share a paper, a seminar or a question in Discussions and it shows here too."
              : `Nothing from ${data.person.name} in Discussions that you can see.`
          }
          action={
            data.is_me ? (
              <Button kind="primary" size="sm" asChild>
                <Link to="/discussions">Write a post</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
          {!more && data.posts.length >= 5 && (
            <Button kind="default" size="md" onClick={() => setMore(true)}>
              Show all their posts
            </Button>
          )}
          {more && older.hasNextPage && (
            <Button kind="default" size="md" onClick={() => void older.fetchNextPage()} disabled={older.isFetchingNextPage}>
              {older.isFetchingNextPage ? "Loading…" : "Show older posts"}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* The research post                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Whether somebody is research faculty, and their yearly rupee threshold.
 *
 * Two readers, two shapes. The research coordinator (and the super admin)
 * gets a tick box and the threshold, saved here. The person themself gets one
 * sentence saying how much of their threshold is used, because the threshold
 * decides which of their incentives are paid and finding that out from a zero
 * on a payment is the worst way to learn it. Everybody else gets the badge in
 * the header and no more.
 */
function ResearchPostPanel({
  personId,
  name,
  routeId,
  post,
  isMe,
}: {
  personId: string
  name: string
  routeId: string
  post: ResearchPost
  isMe: boolean
}) {
  if (!post.may_edit) {
    if (!post.research_faculty || !post.threshold) return null
    return <ThresholdCard s={post.threshold} link={false} />
  }
  return <ResearchPostEditor personId={personId} name={name} routeId={routeId} post={post} isMe={isMe} />
}

function ResearchPostEditor({
  personId,
  name,
  routeId,
  post,
  isMe,
}: {
  personId: string
  name: string
  routeId: string
  post: ResearchPost
  isMe: boolean
}) {
  const qc = useQueryClient()
  const [ticked, setTicked] = useState(post.research_faculty)
  useEffect(() => setTicked(post.research_faculty), [post.research_faculty])

  const save = useMutation<unknown, ApiError, void>({
    mutationFn: () =>
      api(`/api/admin/users/${personId}`, {
        method: "PATCH",
        json: { faculty_type: ticked ? "RESEARCH" : "REGULAR" },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["person", routeId] })
      void qc.invalidateQueries({ queryKey: ["research-faculty"] })
      toast.ok(ticked ? "Research faculty. Now set a threshold" : "No longer research faculty")
    },
  })

  const dirty = ticked !== post.research_faculty

  return (
    <section aria-label="Research post" className="panel space-y-3 px-4 py-4">
      <div>
        <SectionTitle className="text-base">Research post</SectionTitle>
        <Meta className="block">
          Only the research coordinator and the super admin see this. Incentives up to the threshold are not
          paid.
          {isMe ? " This is your own account." : ""}
        </Meta>
      </div>
      <Checkbox
        checked={ticked}
        onCheckedChange={(v) => setTicked(v === true)}
        label="Research faculty"
        hint="Unticking pays their incentives in full again. The threshold stays on record."
      />
      {save.error && <InlineError message={save.error.message} />}
      {dirty && (
        <div className="flex justify-end">
          <Button kind="primary" size="md" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save research post"}
          </Button>
        </div>
      )}
      {!dirty && post.research_faculty && post.may_set_threshold && (
        <ResearchThresholdPanel userId={personId} name={name} />
      )}
      {!dirty && post.research_faculty && !post.may_set_threshold && post.threshold && (
        <ThresholdCard s={post.threshold} link={false} />
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Editing your own                                                          */
/* ------------------------------------------------------------------------ */

/**
 * The self-service part of a profile: photo, a few lines about yourself,
 * ORCID, research interests. Everything else — name, department, the Scopus
 * link — decides who gets paid, and stays a request to the office on the
 * account page.
 */
function EditProfile({ data, routeId, onClose }: { data: Profile; routeId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { refresh } = useAuth()
  const [bio, setBio] = useState(data.person.bio ?? "")
  const [orcid, setOrcid] = useState(data.person.orcid_id ?? "")
  const fileInput = useRef<HTMLInputElement>(null)

  function refreshEverywhere() {
    void qc.invalidateQueries({ queryKey: ["person"] })
    void qc.invalidateQueries({ queryKey: ["feed"] })
    void refresh()
  }

  const save = useMutation<unknown, ApiError, void>({
    mutationFn: () =>
      api("/api/auth/profile/self", {
        method: "PATCH",
        json: { bio: bio.trim(), orcid_id: orcid.trim() },
      }),
    onSuccess: () => {
      refreshEverywhere()
      toast.ok("Profile saved")
      onClose()
    },
  })

  const photo = useMutation<{ photo_url: string | null }, ApiError, File | null>({
    mutationFn: (file) => {
      if (!file) return api("/api/people/me/photo", { method: "DELETE" })
      const form = new FormData()
      form.set("file", file)
      // Multipart: the cast `api()` needs for a FormData body (file-paper.tsx).
      return api("/api/people/me/photo", { method: "POST", body: form } as unknown as Parameters<typeof api>[1])
    },
    onSuccess: (r) => {
      qc.setQueryData<Profile>(["person", routeId], (d) =>
        d ? { ...d, person: { ...d.person, photo_url: r.photo_url } } : d
      )
      refreshEverywhere()
      toast.ok(r.photo_url ? "Photo updated" : "Photo removed")
    },
    onError: (err) => toast.fail(err),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Edit your profile</DialogTitle>
          <DialogDescription>
            Everybody in the college can see this page. Name, department and Scopus link change on your account page.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="flex items-center gap-4">
            <Avatar person={data.person} size="lg" />
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ""
                  if (f) photo.mutate(f)
                }}
              />
              <Button kind="default" size="md" onClick={() => fileInput.current?.click()} disabled={photo.isPending}>
                <Camera />
                {photo.isPending ? "Uploading…" : data.person.photo_url ? "Change photo" : "Add a photo"}
              </Button>
              {data.person.photo_url && (
                <Button kind="quiet" size="md" onClick={() => photo.mutate(null)} disabled={photo.isPending}>
                  Remove
                </Button>
              )}
            </div>
          </div>
          <Field label="About you" hint={`${bio.length} of 600 characters.`}>
            <Textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} maxRows={8} maxLength={600} />
          </Field>

          <Field label="ORCID iD">
            <Input value={orcid} onChange={(e) => setOrcid(e.target.value)} placeholder="0000-0002-1825-0097" />
          </Field>

          <div className="space-y-1">
            <Interests />
          </div>

          {save.error && <InlineError message={save.error.message} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={save.isPending}>
            Close
          </Button>
          <Button kind="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* The directory                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Everybody, searchable by name, department, designation or research
 * interest. The way into a colleague's profile when you do not already have
 * a post of theirs to click.
 */
export function PeopleDirectory() {
  const [params, setParams] = useSearchParams()
  const q = params.get("q") ?? ""
  const department = params.get("department") ?? ""
  const interest = params.get("interest") ?? ""
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1)
  const [draft, setDraft] = useState(q)
  const limit = 24

  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => set({ q: draft, page: "" }), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  function set(entries: Record<string, string>) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(entries)) {
        if (v) next.set(k, v)
        else next.delete(k)
      }
      return next
    })
  }

  const query = new URLSearchParams({ limit: String(limit), offset: String((page - 1) * limit) })
  if (q) query.set("q", q)
  if (department) query.set("department", department)
  if (interest) query.set("interest", interest)
  const people = useApi<Directory>(["people-directory", q, department, interest, page], `/api/people?${query}`)
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments")

  const filtered = !!(q || department || interest)

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>People</PageTitle>
      </header>

      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Name, department or research interest"
            aria-label="Search people"
            className="pl-8"
          />
        </div>
        <Combobox
          value={department}
          onChange={(v) => set({ department: v, page: "" })}
          options={[
            { value: "", label: "Every department" },
            ...(departments.data ?? []).map((d) => ({ value: d, label: d })),
          ]}
          aria-label="Department"
          className="w-full sm:w-60"
        />
        {interest && (
          <Button kind="quiet" size="md" onClick={() => set({ interest: "", page: "" })}>
            Interested in {interest} ×
          </Button>
        )}
      </div>

      {people.isPending ? (
        <SkeletonRows rows={6} rowHeight={64} />
      ) : people.isError ? (
        <ErrorState
          title="Could not load people"
          message="The server did not answer. Nothing has changed."
          onRetry={() => void people.refetch()}
        />
      ) : people.data.results.length === 0 ? (
        <EmptyState
          icon={Users}
          title={filtered ? "Nobody matches that" : "Nobody here yet"}
          message={filtered ? "Try part of a name, or clear the department." : "Accounts appear here as the office adds them."}
        />
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {people.data.results.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/u/${p.id}`}
                  className={cn("panel flex h-full items-start gap-3 px-3 py-3 hover:bg-hover")}
                >
                  <Avatar person={p} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium">{p.name}</span>
                    <Meta className="block truncate text-xs">
                      {[p.designation, p.department].filter(Boolean).join(" · ")}
                    </Meta>
                    <Meta className="mt-1 block truncate text-xs">
                      {p.papers} paper{p.papers === 1 ? "" : "s"}
                      {p.interests.length > 0 ? ` · ${p.interests.join(", ")}` : ""}
                      {p.following ? " · following" : ""}
                    </Meta>
                    {p.skills && p.skills.length > 0 && (
                      <Meta className="block truncate text-xs">Skills: {p.skills.join(", ")}</Meta>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination
            page={page - 1}
            pageSize={limit}
            total={people.data.total}
            onChange={(n) => set({ page: n > 0 ? String(n + 1) : "" })}
          />
        </>
      )}
    </div>
  )
}
