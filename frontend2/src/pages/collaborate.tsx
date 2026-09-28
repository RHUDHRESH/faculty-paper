import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ExternalLink, UserRound, UsersRound, Waypoints } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useDebounced, useSearchAll, type SearchItem } from "@/app/search-engine"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { PersonContext, firstName, isExternalKey } from "@/pages/person-context"
import { BigSearch } from "@/ui/big-search"
import { Chip } from "@/ui/chip"
import { PersonCard } from "@/ui/entity"
import { ForceGraph, type GraphLink, type GraphNode } from "@/ui/graph"
import { HeroBand } from "@/ui/hero"
import { initialsOf } from "@/ui/person"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/ui/sheet"
import { ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"

/**
 * Who to work with (docs/ux/08): everyone I have written with, inside and
 * outside the college, suggestions with their reasons, and the ego Map that
 * replaced the College network (docs/ux/11). Picking anybody opens the
 * person-context Sheet: how we're connected, why they matter, what to do.
 *
 * Co-authors come from the authorship record (`/api/people/{id}/coauthors`),
 * never from two people filing claims for the same paper. No money here.
 */

type Coauthor = {
  key: string
  user_id: string | null
  name: string
  department: string | null
  papers_together: number
  first_year_together: number | null
  last_year_together: number | null
  institutions: string[]
  countries: string[]
  is_college_member: boolean
}
type Coauthors = { user_id: string; publications: number; inside_count: number; outside_count: number; inside: Coauthor[]; outside: Coauthor[] }

type EgoNode = {
  key: string
  user_id: string | null
  name: string
  department: string | null
  is_college_member: boolean
  institution: string | null
  college_affiliated?: boolean
  hop: 0 | 1 | 2
  papers: number
  together: number
  degree: number
}
type Ego = { center: string; coauthors: number; capped: boolean; nodes: EgoNode[]; links: { source: string; target: string; papers: number }[] }

type NextPerson = { id: string; name: string; department: string | null; designation: string | null; papers: number; reasons: string[] }
type Next = { people: NextPerson[] }

type View = "coauthors" | "suggested" | "map"
type Filter = "all" | "inside" | "outside"

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The id a person is picked by: a member's user id, else their author key. */
const pickId = (c: { user_id: string | null; key: string }) => c.user_id ?? c.key

export function Collaborate() {
  const meId = useAuth().me?.id ?? ""
  const [params, setParams] = useSearchParams()
  const view = (["coauthors", "suggested", "map"].includes(params.get("view") ?? "") ? params.get("view") : "coauthors") as View
  const picked = params.get("person")

  const co = useApi<Coauthors>(["coauthors", meId], `/api/people/${meId}/coauthors`, { enabled: !!meId })
  const ego = useApi<Ego>(["ego", meId], `/api/people/me/ego?limit=60`, { staleTime: 5 * 60_000 })
  const next = useApi<Next>(["discover", "next"], "/api/discover/next", { retry: false })

  function set(patch: Record<string, string | null>) {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k))
    setParams(p, { replace: patch.person === undefined })
  }
  const open = (id: string) => set({ person: id })

  const inside = co.data?.inside ?? []
  const outside = co.data?.outside ?? []
  const total = inside.length + outside.length
  const institutions = new Set(outside.flatMap((c) => c.institutions.slice(0, 1)))
  const suggestions = useSuggestions(ego.data, next.data)

  const sentence = co.isLoading
    ? "Counting who you've written with…"
    : co.isError
      ? "Your co-authors could not be counted just now."
      : total === 0
        ? "Nobody on your record yet — they appear from your papers' author lists."
        : `You've written with ${plural(total, "person", "people")} — ${inside.length} at Saveetha, ${outside.length} outside, across ${plural(institutions.size + (inside.length ? 1 : 0), "institution")}.`

  const tabs: { id: View; label: string; count?: number }[] = [
    { id: "coauthors", label: "Your co-authors", count: co.data ? total : undefined },
    { id: "suggested", label: "Suggested", count: suggestions.length || undefined },
    { id: "map", label: "Map" },
  ]

  return (
    <div data-area="people" className="page space-y-8">
      <HeroBand spot="collaboration" area="people" eyebrow="People" title="Who to work with" sentence={sentence}>
        <PeopleSearch onPick={open} />
      </HeroBand>

      <div role="tablist" aria-label="Who to work with" className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={view === t.id}
            onClick={() => set({ view: t.id === "coauthors" ? null : t.id })}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors duration-[var(--dur-1)]",
              view === t.id ? "border-(--area) font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"
            )}
          >
            {t.label}
            {t.count != null && <span className="ml-1.5 tabular text-fg-subtle">{t.count}</span>}
          </button>
        ))}
      </div>

      {view === "coauthors" && (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <CoauthorList query={co} onPick={open} />
          <aside className="space-y-3 max-lg:hidden">
            <SectionTitle className="flex items-center gap-1.5">
              <Waypoints aria-hidden className="size-4 text-(--area)" strokeWidth={1.75} />
              Your circle
            </SectionTitle>
            <EgoMap query={ego} height={360} onPick={open} compact />
          </aside>
        </div>
      )}
      {view === "suggested" && (
        <Suggested loading={ego.isLoading || next.isLoading} items={suggestions} onPick={open} meId={meId} />
      )}
      {view === "map" && (
        <section className="space-y-3">
          <Meta className="block">
            You, the people you've written with, and theirs — at most 60 people, never the whole college.
            Point at somebody to light their path to you; tap to see how you're connected.
          </Meta>
          <EgoMap query={ego} height={560} onPick={open} />
        </section>
      )}

      <Sheet open={!!picked} onOpenChange={(v) => !v && set({ person: null })}>
        <SheetContent className="sm:w-[30rem]">
          <SheetHeader>
            <SheetTitle>How you're connected</SheetTitle>
            <SheetDescription className="sr-only">Connection paths, reasons and actions for this person.</SheetDescription>
          </SheetHeader>
          <SheetBody className="overflow-y-auto">
            {picked && <PersonContext meId={meId} target={picked} />}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  )
}

/* ------------------------------------------------------------------ search */

function PeopleSearch({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState("")
  const term = useDebounced(q)
  const res = useSearchAll(term, "people", 8)
  const items: SearchItem[] = res.data?.groups.find((g) => g.kind === "person")?.items ?? []
  const show = q.trim().length >= 2
  return (
    <BigSearch
      value={q}
      onChange={setQ}
      hideScopes
      label="Find anyone"
      placeholder="Find anyone — see how you're connected"
      className="mt-5"
    >
      {show && (
        <div role="listbox" aria-label="People" className="panel mt-2 max-h-80 overflow-y-auto p-1">
          {res.isLoading && !res.data ? (
            <SkeletonRows rows={3} rowHeight={40} />
          ) : items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-fg-muted">Nobody called “{q.trim()}” in the college or among its co-authors.</p>
          ) : (
            items.map((it) => {
              const m = it.meta ?? {}
              const id = String(m.connect ?? it.id)
              return (
                <button
                  key={it.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onPick(id)
                    setQ("")
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-hover"
                >
                  <UserRound aria-hidden className="size-4 shrink-0 text-(--area)" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{it.title}</span>
                    <span className="block truncate text-xs text-fg-muted">
                      {m.external && (m.college_coauthors ?? []).length
                        ? `${it.subtitle} · wrote with ${(m.college_coauthors as { name: string }[]).map((c) => c.name).slice(0, 2).join(", ")}`
                        : it.subtitle}
                    </span>
                  </span>
                  <Chip tone={m.external ? "neutral" : "area"} area="people" className="max-w-40 truncate max-sm:hidden">
                    {m.external ? "Outside" : "Saveetha"}
                  </Chip>
                </button>
              )
            })
          )}
        </div>
      )}
    </BigSearch>
  )
}

/* --------------------------------------------------------------- co-authors */

function CoauthorList({ query, onPick }: { query: ReturnType<typeof useApi<Coauthors>>; onPick: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all")
  const [sort, setSort] = useState<"papers" | "recent">("papers")
  const [shown, setShown] = useState(40)
  if (query.isLoading) return <SkeletonRows rows={5} rowHeight={96} />
  if (query.isError)
    return (
      <ErrorState
        title="Could not work out who you have written with"
        message="The server did not answer. This page only reads — nothing has been lost."
        onRetry={() => void query.refetch()}
      />
    )
  const inside = query.data?.inside ?? []
  const outside = query.data?.outside ?? []
  if (inside.length + outside.length === 0) return <NoCoauthors />
  const rows = [
    ...(filter !== "outside" ? inside.map((c) => ({ ...c, inside: true })) : []),
    ...(filter !== "inside" ? outside.map((c) => ({ ...c, inside: false })) : []),
  ].sort((a, b) =>
    sort === "papers"
      ? b.papers_together - a.papers_together || (b.last_year_together ?? 0) - (a.last_year_together ?? 0)
      : (b.last_year_together ?? 0) - (a.last_year_together ?? 0) || b.papers_together - a.papers_together
  )
  const filters: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: inside.length + outside.length },
    { id: "inside", label: "Saveetha", n: inside.length },
    { id: "outside", label: "Outside", n: outside.length },
  ]
  return (
    <section className="space-y-3" aria-label="Your co-authors">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Show" className="flex gap-1.5">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "h-8 rounded-full px-3 text-sm transition-colors duration-[var(--dur-1)]",
                filter === f.id ? "bg-(--area-wash) font-medium text-(--area) shadow-[inset_0_0_0_1px_var(--area-line)]" : "text-fg-muted hover:bg-hover"
              )}
            >
              {f.label} <span className="tabular">{f.n}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as "papers" | "recent")}
            className="h-8 rounded-md bg-surface px-2 text-sm text-fg shadow-[inset_0_0_0_1px_var(--color-field)]"
          >
            <option value="papers">Most papers</option>
            <option value="recent">Most recent</option>
          </select>
        </label>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {rows.slice(0, shown).map((c) => (
          <li key={c.key}>
            <CoauthorCard c={c} inside={c.inside} onPick={onPick} />
          </li>
        ))}
      </ul>
      {rows.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + 40)} className="mt-4 text-sm font-medium text-accent hover:underline">
          Show more ({rows.length - shown} left)
        </button>
      )}
    </section>
  )
}

function CoauthorCard({ c, inside, onPick }: { c: Coauthor; inside: boolean; onPick: (id: string) => void }) {
  const years =
    c.first_year_together && c.last_year_together && c.first_year_together !== c.last_year_together
      ? ` · ${c.first_year_together}–${c.last_year_together}`
      : c.last_year_together
        ? ` · ${c.last_year_together}`
        : ""
  const context = (
    <button type="button" onClick={() => onPick(pickId(c))} className="text-left hover:text-fg hover:underline hover:underline-offset-4">
      {plural(c.papers_together, "paper")} together{years}
    </button>
  )
  const affiliation = inside ? (c.is_college_member ? "Saveetha" : "Saveetha (former)") : (c.institutions[0] ?? "Outside")
  return (
    <div className="flex h-full flex-col">
      <PersonCard
        className="h-full"
        person={{ name: c.name, initials: initialsOf(c.name), photo_url: null, department: c.department }}
        to={c.user_id ? `/u/${c.user_id}` : undefined}
        affiliation={affiliation.length > 40 ? `${affiliation.slice(0, 39)}…` : affiliation}
        context={context}
        messageTo={c.user_id ? `/messages?to=${c.user_id}` : undefined}
        path={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onPick(pickId(c))}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-(--area) hover:bg-(--area-wash)"
            >
              <Waypoints aria-hidden className="size-4" strokeWidth={1.75} />
              How you're connected
            </button>
            {!c.user_id && /^A\d+$/.test(c.key) && (
              <a
                href={`https://openalex.org/authors/${c.key}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-fg-muted hover:bg-hover"
              >
                OpenAlex <ExternalLink aria-hidden className="size-3" />
              </a>
            )}
          </div>
        }
      />
    </div>
  )
}

function NoCoauthors() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg bg-sunken px-6 py-12 text-center">
      <div className="rounded-3xl bg-(--area-wash) p-4">
        <img src="/illustrations/network-bridge.svg" alt="" width={200} height={125} />
      </div>
      <p className="mt-2 text-lg font-semibold text-fg">Your co-authors will appear here</p>
      <p className="max-w-sm text-base text-fg-muted">
        We find them from your papers' author lists — no one needs to file anything.
      </p>
      <Link to="/papers" className="mt-3 inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
        Check my record
      </Link>
    </div>
  )
}

/* ---------------------------------------------------------------- suggested */

type Suggestion = { id: string; name: string; sub: string | null; group: string; reason: string; outside: boolean }

/** Grouped: your co-authors' co-authors (two hops, college first), then the counted suggestions from Discover. */
function useSuggestions(ego: Ego | undefined, next: Next | undefined): Suggestion[] {
  return useMemo(() => {
    const out: Suggestion[] = []
    const seen = new Set<string>()
    if (ego) {
      const byKey = new Map(ego.nodes.map((n) => [n.key, n]))
      const hop2 = ego.nodes.filter((n) => n.hop === 2)
      hop2.sort((a, b) => Number(b.is_college_member) - Number(a.is_college_member) || b.degree - a.degree)
      for (const n of hop2.slice(0, 12)) {
        const via = ego.links
          .filter((l) => l.source === n.key || l.target === n.key)
          .map((l) => byKey.get(l.source === n.key ? l.target : l.source))
          .filter((v): v is EgoNode => !!v && v.hop === 1)
        const id = n.user_id ?? n.key
        seen.add(id)
        out.push({
          id,
          name: n.name,
          sub: n.is_college_member ? [n.department, "Saveetha"].filter(Boolean).join(" · ") : n.institution,
          group: "Your co-authors' co-authors",
          reason: via.length
            ? `Wrote with ${via.slice(0, 2).map((v) => v.name).join(" and ")}${via.length > 2 ? ` and ${via.length - 2} more` : ""}`
            : "Two steps from you",
          outside: !n.is_college_member,
        })
      }
    }
    for (const p of next?.people ?? []) {
      if (seen.has(p.id)) continue
      out.push({
        id: p.id,
        name: p.name,
        sub: [p.department, p.designation].filter(Boolean).join(" · "),
        group: "Works on your topics",
        reason: p.reasons[0] ?? `${plural(p.papers, "paper")} on record`,
        outside: false,
      })
    }
    return out
  }, [ego, next])
}

function Suggested({ loading, items, onPick, meId }: { loading: boolean; items: Suggestion[]; onPick: (id: string) => void; meId: string }) {
  if (loading) return <SkeletonRows rows={4} rowHeight={96} />
  if (!items.length)
    return (
      <p className="rounded-lg bg-sunken px-6 py-10 text-center text-base text-fg-muted">
        Suggestions come from your co-authors' co-authors and from colleagues on your topics. They fill in as your record does.
      </p>
    )
  const groups = [...new Set(items.map((i) => i.group))]
  return (
    <div className="space-y-8">
      {groups.map((g) => (
        <section key={g} className="space-y-3">
          <SectionTitle>{g}</SectionTitle>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items
              .filter((i) => i.group === g)
              .map((s) => (
                <li key={s.id}>
                  <PersonCard
                    className="h-full"
                    person={{ name: s.name, initials: initialsOf(s.name), photo_url: null, department: s.sub }}
                    to={isExternalKey(s.id) || s.id === meId ? undefined : `/u/${s.id}`}
                    affiliation={s.outside ? "Outside" : "Saveetha"}
                    context={s.reason}
                    path={
                      <button
                        type="button"
                        onClick={() => onPick(s.id)}
                        className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-sm text-(--area) hover:bg-(--area-wash)"
                      >
                        <Waypoints aria-hidden className="size-4" strokeWidth={1.75} />
                        How you're connected to {firstName(s.name)}
                      </button>
                    }
                  />
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------------- map */

function EgoMap({
  query,
  height,
  onPick,
  compact,
}: {
  query: ReturnType<typeof useApi<Ego>>
  height: number
  onPick: (id: string) => void
  compact?: boolean
}) {
  const data = query.data
  const { nodes, links, idOf } = useMemo(() => {
    const idOf = new Map<string, string>()
    const nodes: GraphNode[] = (data?.nodes ?? []).map((n) => {
      idOf.set(n.key, n.user_id ?? n.key)
      return {
        id: n.key,
        name: n.hop === 0 ? "You" : n.name,
        department: n.is_college_member ? n.department : n.institution,
        degree: n.hop === 1 ? Math.max(n.degree, n.together * 2) : n.degree,
        papers: n.papers,
        tone: n.hop === 0 || n.is_college_member ? "inside" : "outside",
        faint: n.hop === 2,
      }
    })
    const links: GraphLink[] = (data?.links ?? []).map((l) => ({ ...l, kind: "coauthor" as const }))
    return { nodes, links, idOf }
  }, [data])
  if (query.isLoading) return <Skeleton className="w-full" style={{ height }} />
  if (query.isError)
    return (
      <ErrorState
        title="Could not draw your circle"
        message="The server did not answer. An empty drawing would say you have no co-authors, which is not what happened."
        onRetry={() => void query.refetch()}
      />
    )
  if (!data || data.nodes.length <= 1)
    return <p className="rounded-lg bg-sunken px-4 py-10 text-center text-sm text-fg-muted">Your circle draws itself once your papers list co-authors.</p>
  return (
    <div className="space-y-2">
      <ForceGraph
        nodes={nodes}
        links={links}
        centerId={data.center}
        height={height}
        pathToCenter
        onPick={(key) => {
          const id = idOf.get(key)
          if (id && key !== data.center) onPick(id)
        }}
        label={`Your co-author circle: you, ${plural(data.coauthors, "co-author")} and people two steps away. ${nodes.length} people shown.`}
        legend={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-full bg-accent" /> Saveetha
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-full bg-(--area)" /> Outside
            </span>
            <span className="inline-flex items-center gap-1.5">
              <UsersRound aria-hidden className="size-3.5" /> Faint: two steps away
            </span>
            {!compact && data.capped && <span>Showing the 60 closest; your full list is on Your co-authors.</span>}
          </div>
        }
      />
    </div>
  )
}
