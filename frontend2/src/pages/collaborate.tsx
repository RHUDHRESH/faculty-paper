import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ChevronDown, ExternalLink, Globe, MessageSquare, UserRound, Waypoints } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useDebounced, useSearchAll, type SearchItem } from "@/app/search-engine"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { PersonContext, isExternalKey } from "@/pages/person-context"
import { BigSearch } from "@/ui/big-search"
import { Chip } from "@/ui/chip"
import { YourCircle } from "@/ui/circle"
import { Answer } from "@/ui/answer"
import { PageHeader } from "@/ui/page-header"
import { formatCount } from "@/lib/count"
import { Avatar, PersonLink, initialsOf } from "@/ui/person"
import { Picture } from "@/ui/picture"
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
  /** Has an account on this app: can be messaged and followed. (`is_college_member` is the old name for it.) */
  has_account: boolean
  /** An author of the college, with or without an account. */
  at_college: boolean
  is_college_member: boolean
  photo_url?: string | null
  initials?: string
}
type Coauthors = { user_id: string; publications: number; inside_count: number; outside_count: number; inside: Coauthor[]; outside: Coauthor[] }

type EgoNode = {
  key: string
  user_id: string | null
  name: string
  department: string | null
  has_account: boolean
  at_college: boolean
  is_college_member: boolean
  institution: string | null
  college_affiliated?: boolean
  hop: 0 | 1 | 2
  photo_url?: string | null
  initials?: string
  papers: number
  together: number
  degree: number
}
type Ego = { center: string; coauthors: number; capped: boolean; nodes: EgoNode[]; links: { source: string; target: string; papers: number }[] }

type NextPerson = { id: string; name: string; department: string | null; designation: string | null; papers: number; reasons: string[]; shared_areas?: string[] }
type Next = { people: NextPerson[] }

type View = "coauthors" | "suggested" | "map"
type Filter = "all" | "members" | "others" | "outside"

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
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    setParams(p, { replace: patch.person === undefined })
  }
  const open = (id: string) => set({ person: id })

  const inside = co.data?.inside ?? []
  const outside = co.data?.outside ?? []
  const total = inside.length + outside.length
  const members = inside.filter((c) => c.has_account).length
  const others = inside.length - members
  const institutions = new Set(outside.flatMap((c) => c.institutions.slice(0, 1)))
  const suggestions = useSuggestions(ego.data, next.data)
  const show = (["members", "others", "outside"].includes(params.get("show") ?? "") ? params.get("show") : "all") as Filter
  const showList = (f: Filter) => `/collaborate${f === "all" ? "" : `?show=${f}`}`

  const sentence = co.isError
    ? "Your co-authors could not be counted just now."
    : co.data && total === 0
      ? "Nobody on your record yet. Co-authors appear from your papers' author lists."
      : "Everyone you have written with, and who to write with next."

  const tabs: { id: View; label: string; count?: number }[] = [
    { id: "coauthors", label: "Your co-authors", count: co.data ? total : undefined },
    { id: "suggested", label: "Suggested", count: suggestions.length || undefined },
    { id: "map", label: "Map of your circle" },
  ]

  return (
    <div data-area="people" className="page space-y-8">
      <div className="space-y-6">
        <PageHeader title="Who to work with" sub={sentence} spot="spot-who-to-work-with" />
        {co.data && total > 0 ? (
          <Answer
            items={[
              { value: total, label: "People you have written with", to: showList("all") },
              { value: members, label: "Colleagues on this app", zero: "No colleague on this app yet", to: showList("members") },
              { value: others, label: "Saveetha authors not on this app", zero: "Every Saveetha author is on this app", to: showList("others") },
              {
                value: outside.length,
                label: outside.length ? `Outside, at ${plural(institutions.size, "institution")}` : "Outside the college",
                zero: "Nobody outside the college yet",
                to: showList("outside"),
              },
            ]}
          />
        ) : null}
        <PeopleSearch onPick={open} />
      </div>

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
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <CoauthorList query={co} onPick={open} meId={meId} filter={show} onFilter={(f) => set({ show: f === "all" ? null : f })} />
          <aside className="space-y-3 max-lg:hidden">
            <SectionTitle className="flex items-center gap-1.5">
              <Waypoints aria-hidden className="size-4 text-(--area)" strokeWidth={1.75} />
              Your circle
            </SectionTitle>
            <Meta className="block">
              {ego.data?.capped ? `The closest ${ego.data.nodes.length - 1} of your ${formatCount(total)} co-authors. The list has everyone.` : "You and the people you have written with."}
            </Meta>
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
            You, the people you have written with, and the people they have written with: at most 60 people, never the whole college.
            Point at somebody to light their path to you, and tap to see how you are connected.
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
      placeholder="Find anyone and see how you're connected"
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

type Face = { name: string; initials: string; photo_url: string | null }

/** Two letters for an institution: "Anna University" -> "AU". */
function monogram(inst: string | null | undefined): string | null {
  const words = (inst || "").replace(/\b(of|the|and|for|&)\b/gi, " ").split(/[\s,.-]+/).filter((w) => /^[A-Z]/.test(w))
  if (!words.length) return null
  return (words[0][0] + (words.length > 1 ? words[1][0] : "")).toUpperCase()
}

/** A colleague's face; an outside author gets their institution's monogram, never a made-up face. */
function PersonFace({ person, outside, institution }: { person: Face; outside: boolean; institution?: string | null }) {
  if (!outside) return <Avatar person={person} size="lg" className="size-12 text-base sm:size-14" />
  const m = monogram(institution)
  return (
    <span
      aria-hidden
      title={institution ?? undefined}
      className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-sunken text-sm font-semibold tracking-wide text-fg-muted shadow-[inset_0_0_0_1px_var(--color-line)] sm:size-14"
    >
      {m ?? <Globe className="size-5" strokeWidth={1.5} />}
    </span>
  )
}

const yearsOf = (c: Coauthor) =>
  c.first_year_together && c.last_year_together && c.first_year_together !== c.last_year_together
    ? `${c.first_year_together}–${c.last_year_together}`
    : c.last_year_together
      ? String(c.last_year_together)
      : null

function CoauthorList({
  query,
  onPick,
  meId,
  filter,
  onFilter,
}: {
  query: ReturnType<typeof useApi<Coauthors>>
  onPick: (id: string) => void
  meId: string
  filter: Filter
  onFilter: (f: Filter) => void
}) {
  const [sort, setSort] = useState<"papers" | "recent">("papers")
  const [find, setFind] = useState("")
  const [shown, setShown] = useState(40)
  // Until the account is known the query is switched off: no data and no error
  // is "not asked yet", never "you have no co-authors".
  if (query.isLoading || (!query.data && !query.isError)) return <SkeletonRows rows={6} rowHeight={72} />
  if (query.isError)
    return (
      <ErrorState
        title="Could not work out who you have written with"
        message="The server did not answer. This page only reads, so nothing has been lost."
        onRetry={() => void query.refetch()}
      />
    )
  const inside = query.data?.inside ?? []
  const outside = query.data?.outside ?? []
  if (inside.length + outside.length === 0) return <NoCoauthors />
  const needle = find.trim().toLowerCase()
  const rows = [
    ...(filter === "all" || filter === "members" || filter === "others" ? inside.map((c) => ({ ...c, inside: true })) : []),
    ...(filter === "all" || filter === "outside" ? outside.map((c) => ({ ...c, inside: false })) : []),
  ]
    .filter((c) => filter !== "members" || c.has_account)
    .filter((c) => filter !== "others" || !c.has_account)
    .filter((c) => !needle || c.name.toLowerCase().includes(needle) || (c.institutions[0] ?? "").toLowerCase().includes(needle) || (c.department ?? "").toLowerCase().includes(needle))
    .sort((a, b) =>
      sort === "papers"
        ? b.papers_together - a.papers_together || (b.last_year_together ?? 0) - (a.last_year_together ?? 0)
        : (b.last_year_together ?? 0) - (a.last_year_together ?? 0) || b.papers_together - a.papers_together
    )
  const members = inside.filter((c) => c.has_account).length
  const filters: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: inside.length + outside.length },
    { id: "members", label: "On this app", n: members },
    { id: "others", label: "Not on this app", n: inside.length - members },
    { id: "outside", label: "Outside", n: outside.length },
  ]
  return (
    <section aria-label="Your co-authors">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => onFilter(f.id)}
              className={cn(
                "transition-colors duration-[var(--dur-1)]",
                filter === f.id ? "font-medium text-fg" : "text-fg-muted hover:text-fg"
              )}
            >
              {f.label} <span className="tabular text-fg-subtle">{f.n}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-sm text-fg-muted">
          <span className="sr-only">Find in your co-authors</span>
          <input
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Name, department or institution"
            className="h-8 w-52 rounded-control bg-surface px-2 text-sm text-fg shadow-well ring-1 ring-inset ring-field placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-accent max-sm:w-40"
          />
        </label>
        <label className="flex items-center gap-1 text-sm text-fg-muted">
          <span className="max-sm:sr-only">Sort by</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as "papers" | "recent")}
            className="h-8 rounded-md bg-transparent px-1 text-sm text-fg hover:bg-hover"
          >
            <option value="papers">Most papers</option>
            <option value="recent">Most recent</option>
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="py-8 text-sm text-fg-muted">
          {needle ? `Nobody matching “${find.trim()}” in this list.` : "Nobody in this group yet."}{" "}
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => { setFind(""); onFilter("all") }}>
            Show everyone
          </button>
        </p>
      ) : null}
      <ul className="divide-y divide-line">
        {rows.slice(0, shown).map((c) => (
          <CoauthorRow key={c.key} c={c} inside={c.inside} onPick={onPick} meId={meId} />
        ))}
      </ul>
      {rows.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + 40)} className="mt-4 text-sm font-medium text-accent hover:underline">
          Show {Math.min(40, rows.length - shown)} more of {rows.length - shown}
        </button>
      )}
    </section>
  )
}

const action =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-fg shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-hover"

function CoauthorRow({ c, inside, onPick, meId }: { c: Coauthor; inside: boolean; onPick: (id: string) => void; meId: string }) {
  const [open, setOpen] = useState(false)
  const years = yearsOf(c)
  const where = inside
    ? [c.department, c.has_account ? "Saveetha" : "Saveetha, not on this app"].filter(Boolean).join(" · ")
    : [c.institutions[0], c.countries[0]].filter(Boolean).join(" · ") || "Outside the college"
  const face: Face = { name: c.name, initials: c.initials ?? initialsOf(c.name), photo_url: c.photo_url ?? null }
  const openAlex = !c.user_id && /^A\d+$/.test(c.key) ? `https://openalex.org/authors/${c.key}` : null
  return (
    <li className="py-4">
      <div className="flex items-center gap-4">
        <PersonFace person={face} outside={!inside} institution={c.institutions[0]} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base">
            {c.user_id ? <PersonLink id={c.user_id} name={c.name} /> : <span className="font-medium text-fg">{c.name}</span>}
          </p>
          <p className="truncate text-sm text-fg-muted">{where}</p>
          <p className="text-sm text-fg-subtle">
            <span className="tabular">{plural(c.papers_together, "paper")}</span> together{years && ` · ${years}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Messaging a colleague is the job; on a phone it is an icon, still 40 px to tap. */}
          {c.user_id && c.has_account ? (
            <Link to={`/messages?to=${c.user_id}`} aria-label={`Message ${c.name}`} className={cn(action, "max-sm:size-10 max-sm:justify-center max-sm:px-0")}>
              <MessageSquare aria-hidden className="size-4" strokeWidth={1.75} /> <span className="max-sm:sr-only">Message</span>
            </Link>
          ) : openAlex ? (
            <a href={openAlex} target="_blank" rel="noreferrer" className={cn(action, "max-sm:hidden")}>
              OpenAlex <ExternalLink aria-hidden className="size-3.5" />
            </a>
          ) : (
            <button type="button" onClick={() => onPick(pickId(c))} className={cn(action, "max-sm:hidden")}>
              Open profile
            </button>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-label={`How you're connected to ${c.name}`}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-10 items-center gap-1 rounded-control px-2 text-sm text-fg-muted hover:bg-hover hover:text-fg sm:h-9"
          >
            <span className="max-lg:sr-only">How we are connected</span>
            <ChevronDown aria-hidden className={cn("size-4 transition-transform duration-[var(--dur-2)]", open && "rotate-180")} />
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-3 rounded-lg bg-sunken p-4 sm:ml-[4.5rem]">
          {openAlex ? (
            <a href={openAlex} target="_blank" rel="noreferrer" className={cn(action, "sm:hidden")}>
              OpenAlex <ExternalLink aria-hidden className="size-3.5" />
            </a>
          ) : null}
          <PersonContext meId={meId} target={pickId(c)} header={false} />
        </div>
      )}
    </li>
  )
}

function NoCoauthors() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Picture name="empty-no-collaborators" className="h-40 w-56" />
      <p className="mt-2 text-lg font-semibold text-fg">Your co-authors will appear here</p>
      <p className="max-w-sm text-base text-fg-muted">We find them from your papers' author lists, so nobody needs to file anything.</p>
      <Link to="/papers" className="mt-3 inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
        Check my record
      </Link>
    </div>
  )
}

/* ---------------------------------------------------------------- suggested */

type Suggestion = {
  id: string
  name: string
  face: Face
  sub: string | null
  group: string
  reason: string
  via: Face[]
  outside: boolean
}

const faceOf = (n: { name: string; initials?: string; photo_url?: string | null }): Face => ({
  name: n.name,
  initials: n.initials ?? initialsOf(n.name),
  photo_url: n.photo_url ?? null,
})

/** Grouped: your co-authors' co-authors (two hops, college first), then the counted suggestions from Discover. */
function useSuggestions(ego: Ego | undefined, next: Next | undefined): Suggestion[] {
  return useMemo(() => {
    const out: Suggestion[] = []
    const seen = new Set<string>()
    if (ego) {
      const byKey = new Map(ego.nodes.map((n) => [n.key, n]))
      const hop2 = ego.nodes.filter((n) => n.hop === 2)
      hop2.sort((a, b) => Number(b.at_college) - Number(a.at_college) || b.degree - a.degree)
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
          face: faceOf(n),
          sub: n.at_college ? [n.department, n.has_account ? "Saveetha" : "Saveetha, not on this app"].filter(Boolean).join(" · ") : n.institution,
          group: "Your co-authors' co-authors",
          reason: via.length
            ? `Wrote with your co-author${via.length > 1 ? "s" : ""} ${via.slice(0, 2).map((v) => v.name).join(" and ")}${via.length > 2 ? ` and ${via.length - 2} more` : ""}`
            : "Two steps from you in the author record",
          via: via.slice(0, 3).map(faceOf),
          outside: !n.at_college,
        })
      }
    }
    for (const p of next?.people ?? []) {
      if (seen.has(p.id)) continue
      out.push({
        id: p.id,
        name: p.name,
        face: faceOf(p),
        sub: [p.department, p.designation].filter(Boolean).join(" · "),
        group: "Works on your topics",
        reason: p.shared_areas?.length
          ? `Also works on ${p.shared_areas.slice(0, 2).join(" and ")}`
          : (p.reasons[0] ?? `${plural(p.papers, "paper")} on record`),
        via: [],
        outside: false,
      })
    }
    return out
  }, [ego, next])
}

function Suggested({ loading, items, onPick, meId }: { loading: boolean; items: Suggestion[]; onPick: (id: string) => void; meId: string }) {
  if (loading) return <SkeletonRows rows={5} rowHeight={72} />
  if (!items.length)
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <Picture name="empty-no-collaborators" className="h-40 w-56" />
        <p className="max-w-md text-base text-fg-muted">
          Suggestions come from your co-authors' co-authors and from colleagues on your topics. Add papers to your record and they fill in.
        </p>
      </div>
    )
  const groups = [...new Set(items.map((i) => i.group))]
  return (
    <div className="max-w-3xl space-y-10">
      {groups.map((g) => (
        <section key={g}>
          <SectionTitle className="border-b border-line pb-3">{g}</SectionTitle>
          <ul className="divide-y divide-line">
            {items
              .filter((i) => i.group === g)
              .map((s) => (
                <li key={s.id} className="flex items-center gap-4 py-4">
                  <PersonFace person={s.face} outside={s.outside} institution={s.sub} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base">
                      {isExternalKey(s.id) || s.id === meId ? (
                        <span className="font-medium text-fg">{s.name}</span>
                      ) : (
                        <PersonLink id={s.id} name={s.name} />
                      )}
                    </p>
                    {s.sub && <p className="truncate text-sm text-fg-muted">{s.sub}</p>}
                    <p className="mt-1 flex items-center gap-2 text-sm text-fg-subtle">
                      {s.via.length > 0 && (
                        <span className="flex shrink-0 -space-x-2">
                          {s.via.map((v, i) => (
                            <Avatar key={i} person={v} size="sm" className="ring-2 ring-canvas" />
                          ))}
                        </span>
                      )}
                      <span className="line-clamp-2">{s.reason}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!isExternalKey(s.id) && s.id !== meId && !s.outside ? (
                      <Link to={`/messages?to=${s.id}`} aria-label={`Message ${s.name}`} className={cn(action, "max-sm:size-10 max-sm:justify-center max-sm:px-0")}>
                        <MessageSquare aria-hidden className="size-4" strokeWidth={1.75} /> <span className="max-sm:sr-only">Message</span>
                      </Link>
                    ) : null}
                    <button type="button" onClick={() => onPick(s.id)} aria-label={`How you are connected to ${s.name}`} className={cn(action, "max-sm:size-10 max-sm:justify-center max-sm:px-0")}>
                      <Waypoints aria-hidden className="size-4" strokeWidth={1.75} />
                      <span className="max-lg:sr-only">How we are connected</span>
                    </button>
                  </div>
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
    <YourCircle
      people={data.nodes}
      links={data.links}
      height={height}
      compact={compact}
      onConnect={onPick}
      footnote={!compact && data.capped ? <span>Showing the 60 closest; your full list is on Your co-authors.</span> : undefined}
    />
  )
}
