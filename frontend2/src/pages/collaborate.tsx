import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ArrowUpRight, Share2, UserPlus, Users } from "lucide-react"

import { useApi } from "@/lib/query"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * "Who have I written with, and who could I write with."
 *
 * Nothing here is entered by hand. Two people who filed a claim for the same
 * paper are counted as co-authors, which is the only signal the system has —
 * so every section says as much, and the server's own `derived_from`
 * sentence is shown verbatim rather than paraphrased, because a relationship
 * the software asserts about two named colleagues has to be accountable to
 * somebody who disagrees with it.
 *
 * Carries no money by construction: `/api/collaborate/*` never returns a
 * rupee figure, which is what lets an HOD open this page at all. Nothing in
 * this file should ever add one.
 */
export function Collaborate() {
  const me = useApi<MeCollaborators>(["collaborate", "me"], "/api/collaborate/me?limit=25")
  const graph = useApi<Graph>(["collaborate", "graph"], "/api/collaborate/graph")

  return (
    <div className="page space-y-10">
      <header>
        <PageTitle>Who to work with</PageTitle>
        <Sub className="mt-1">
          Nobody records co-authorship directly. It is worked out from who filed a claim for
          the same paper.
        </Sub>
      </header>

      {me.data && (
        <Callout tone="info" title="Where this comes from">
          {me.data.derived_from}
        </Callout>
      )}

      <section className="space-y-3">
        <SectionTitle>People you have written with</SectionTitle>
        {me.isLoading ? (
          <SkeletonRows rows={4} rowHeight={48} />
        ) : me.isError ? (
          // Written, not relayed. `error.message` is whatever the server put
          // in `detail`, or "Failed to fetch" when the connection dropped —
          // and beside a heading reading "People you have written with", a
          // machine string is indistinguishable from the answer "none".
          <ErrorState
            title="Could not work out who you have written with"
            message="The server did not answer. This screen only reads — no co-authorship has been lost or forgotten."
            onRetry={() => me.refetch()}
          />
        ) : me.data && me.data.worked_with.length > 0 ? (
          <WorkedWithList people={me.data.worked_with} />
        ) : (
          <EmptyState
            art="nothing-filed"
            icon={Users}
            title="No co-authors yet"
            message="Once a paper you have filed shares a claim with somebody else's, they will show up here — nothing to do but keep filing."
          />
        )}
      </section>

      <section className="space-y-3">
        <SectionTitle>People you could write with</SectionTitle>
        {me.isLoading ? (
          <SkeletonRows rows={4} rowHeight={56} />
        ) : me.isError ? (
          <ErrorState
            title="Could not work out who to suggest"
            message="The server did not answer. Nothing about your record has changed."
            onRetry={() => me.refetch()}
          />
        ) : me.data && me.data.suggestions.length > 0 ? (
          <SuggestionsList people={me.data.suggestions} />
        ) : (
          <EmptyState
            art="no-results"
            icon={UserPlus}
            title="No introductions to make yet"
            message="This fills in once somebody outside your usual collaborators publishes in a journal you also publish in."
          />
        )}
      </section>

      <section className="space-y-3">
        <SectionTitle>The network</SectionTitle>
        {graph.isLoading ? (
          <Skeleton className="mx-auto aspect-square w-full max-w-md" />
        ) : graph.isError ? (
          <ErrorState
            title="Could not draw the network"
            message="The server did not answer. An empty drawing here would say nobody is connected, which is not what happened."
            onRetry={() => graph.refetch()}
          />
        ) : graph.data ? (
          <NetworkGraph graph={graph.data} meId={me.data?.me.id} />
        ) : null}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Types — mirrors API.md's "Who has worked with whom"                      */
/* ------------------------------------------------------------------------ */

type Collaborator = {
  id: string
  name: string
  department: string
  designation: string
  together: number
  papers: number
}

type Suggestion = {
  id: string
  name: string
  department: string
  designation: string
  papers: number
  shared_journals: string[]
  shared_count: number
  cross_department: boolean
  why: string
}

type MeCollaborators = {
  me: { id: string; name: string; department: string; designation: string }
  papers: number
  worked_with: Collaborator[]
  suggestions: Suggestion[]
  derived_from: string
}

type GraphNode = {
  id: string
  name: string
  department: string
  designation: string
  papers: number
  degree: number
}

type GraphLink = { source: string; target: string; papers: number }

type Graph = {
  nodes: GraphNode[]
  links: GraphLink[]
  department: string | null
  hidden: number
}

/* ------------------------------------------------------------------------ */
/* People you have written with                                             */
/* ------------------------------------------------------------------------ */

/**
 * A plain list rather than `RankedBars` — every row needs department and
 * designation alongside the count, and the bars chart has only room for a
 * label and a number. The server already sorts by `together`, so the order
 * here is exactly the order the data arrived in.
 */
function WorkedWithList({ people }: { people: Collaborator[] }) {
  const top = Math.max(1, ...people.map((p) => p.together))
  return (
    <ul className="divide-y divide-line border-y border-line">
      {people.map((p) => (
        <li key={p.id} className="row">
          <Link to={`/people/${p.id}`} className="flex items-center gap-4 px-1 py-2.5 sm:px-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base">{p.name}</span>
              <Meta className="block truncate">
                {[p.department, p.designation].filter(Boolean).join(" · ")}
              </Meta>
            </span>
            <span className="hidden w-24 shrink-0 sm:block">
              <span className="block h-1.5 overflow-hidden rounded-full bg-line">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${(p.together / top) * 100}%` }}
                />
              </span>
            </span>
            <span className="w-20 shrink-0 text-right text-sm tabular text-fg-muted">
              {p.together} paper{p.together === 1 ? "" : "s"}
            </span>
            <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------------ */
/* People you could write with                                              */
/* ------------------------------------------------------------------------ */

/**
 * The `why` sentence is the server's, verbatim — it already knows how many
 * journals are shared and whether the person is cross-department, so
 * recomposing it here from the parts would just be a second, possibly
 * different, description of the same fact.
 */
function SuggestionsList({ people }: { people: Suggestion[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {people.map((p) => (
        <li key={p.id} className="row">
          <Link to={`/people/${p.id}`} className="flex items-start gap-4 px-1 py-3 sm:px-2">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate text-base">{p.name}</span>
                {/* Somebody in another department is the more interesting
                    introduction, so that's the one case that gets a badge —
                    a same-department suggestion needs no flag, it is the
                    unsurprising case. */}
                {p.cross_department && p.department && (
                  <span className="shrink-0 rounded-sm bg-accent-wash px-1.5 py-0.5 text-xs font-medium text-accent">
                    {p.department}
                  </span>
                )}
              </span>
              <Meta className="mt-0.5 block">
                {p.papers} paper{p.papers === 1 ? "" : "s"} · {p.why}
              </Meta>
            </span>
            <ArrowUpRight className="reveal mt-1 size-4 shrink-0 text-fg-subtle" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------------ */
/* The network                                                              */
/* ------------------------------------------------------------------------ */

/** Real pixel width of a container, watched. Chart.tsx has the same hook but
 *  does not export it, so it is repeated here rather than reached for across
 *  a file boundary that was told not to be touched. First measurement comes
 *  from `clientWidth` inside `useLayoutEffect`, which runs and commits before
 *  the browser paints — so there is no visible 0-width frame — and the
 *  ResizeObserver only ever corrects it afterwards. */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onResize = () => ref.current && setW(ref.current.clientWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  return [ref, w] as const
}

function shortLabel(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

type Placed = GraphNode & { x: number; y: number; r: number }
type DeptLabel = { key: string; x: number; y: number; anchor: "start" | "middle" | "end" }

/**
 * A deterministic layout: nodes on a circle, grouped into a contiguous arc
 * per department, ordered alphabetically so the same data always draws the
 * same picture. A force simulation was the other option and was rejected —
 * it wanders on every reload and on every new data point, which is exactly
 * wrong for "is X still connected to Y", the question this exists to answer.
 * Arc size is proportional to how many people are in the department, so a
 * department of three does not take as much of the circle as one of forty.
 */
function useCircleLayout(nodes: GraphNode[], size: number) {
  return useMemo(() => {
    const cx = size / 2
    const cy = size / 2
    const R = Math.max(60, size / 2 - 46)
    const placed = new Map<string, Placed>()
    const labels: DeptLabel[] = []
    if (nodes.length === 0 || size === 0) return { placed, labels }

    const byDept = new Map<string, GraphNode[]>()
    for (const n of nodes) {
      const key = n.department || "No department"
      const arr = byDept.get(key)
      if (arr) arr.push(n)
      else byDept.set(key, [n])
    }
    const depts = [...byDept.keys()].sort()
    for (const key of depts) {
      byDept.get(key)?.sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name))
    }

    // A fixed gap between groups, shrinking as there are more of them so
    // thirty departments don't eat the whole circle in whitespace.
    const gap = depts.length > 1 ? Math.min(0.35, 2.4 / depts.length) : 0
    const sweep = Math.max(0.001, Math.PI * 2 - gap * depts.length)

    let angle = -Math.PI / 2 // 12 o'clock, so the first department starts at the top
    for (const key of depts) {
      const members = byDept.get(key) ?? []
      const span = (members.length / nodes.length) * sweep
      members.forEach((n, i) => {
        const a = angle + ((i + 0.5) / members.length) * span
        const r = 4 + Math.min(6, Math.sqrt(n.degree) * 1.6)
        placed.set(n.id, { ...n, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), r })
      })

      const mid = angle + span / 2
      const cos = Math.cos(mid)
      labels.push({
        key,
        x: cx + (R + 20) * cos,
        y: cy + (R + 20) * Math.sin(mid),
        anchor: cos > 0.15 ? "start" : cos < -0.15 ? "end" : "middle",
      })

      angle += span + gap
    }

    return { placed, labels }
  }, [nodes, size])
}

/**
 * The collaboration network, drawn by hand — no graph library is installed
 * and this app does not want one for a single screen.
 *
 * Department names only get a label on the circle itself (there are a
 * couple of dozen of them); the ~150 individual people do not, because
 * per-node text at that count overlaps into noise at any screen size. A
 * person's name instead appears in the panel beside the drawing when their
 * dot is pointed at or tabbed to, which is legible at 375px precisely
 * because it is ordinary flowing text and not something crammed into the
 * SVG's coordinate space.
 */
function NetworkGraph({ graph, meId }: { graph: Graph; meId?: string }) {
  const [box, w] = useMeasuredWidth<HTMLDivElement>()
  const [active, setActive] = useState<string | null>(null)
  const navigate = useNavigate()
  const { placed, labels } = useCircleLayout(graph.nodes, w)

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        art="no-results"
        icon={Share2}
        title="No network to draw yet"
        message="Nobody has a shared paper on record yet. Once claims start overlapping, a network will appear here."
      />
    )
  }

  const total = graph.nodes.length + graph.hidden
  const activeNode = active ? placed.get(active) : null
  const neighbours = new Set(
    active
      ? graph.links
          .filter((l) => l.source === active || l.target === active)
          .flatMap((l) => [l.source, l.target])
      : []
  )

  function go(id: string) {
    navigate(`/people/${id}`)
  }

  function onNodeKeyDown(e: React.KeyboardEvent, id: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      go(id)
    }
  }

  return (
    <div>
      <Meta className="block">
        Showing {graph.nodes.length} of {total} people who share a paper with somebody
        {graph.department ? ` in ${graph.department}` : ""}.
        {graph.hidden > 0
          ? ` ${graph.hidden} more are connected but left off the drawing.`
          : ""}
      </Meta>

      <div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <div ref={box} className="mx-auto aspect-square w-full max-w-md">
          {w > 0 && (
            <svg
              width={w}
              height={w}
              role="img"
              aria-label={`Collaboration network. ${graph.nodes.length} people, grouped by department. Point at or tab to a person for details.`}
            >
              <g>
                {graph.links.map((l) => {
                  const a = placed.get(l.source)
                  const b = placed.get(l.target)
                  if (!a || !b) return null
                  const touches = active != null && (l.source === active || l.target === active)
                  const dim = active != null && !touches
                  return (
                    <line
                      key={`${l.source}-${l.target}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={touches ? "var(--color-accent)" : "var(--color-edge)"}
                      strokeWidth={touches ? 1.5 : 1}
                      opacity={dim ? 0.08 : touches ? 0.9 : 0.4}
                      className="transition-opacity duration-[var(--dur-2)] ease-out"
                    />
                  )
                })}
              </g>

              {/* Below `sm` the circle is under 340px across and two dozen
                  department names would overlap each other; the panel next
                  to the drawing carries that information instead. */}
              <g className="hidden sm:block">
                {labels.map((lb) => (
                  <text
                    key={lb.key}
                    x={lb.x}
                    y={lb.y}
                    textAnchor={lb.anchor}
                    dominantBaseline="middle"
                    className="fill-fg-subtle text-xs"
                  >
                    {shortLabel(lb.key, 20)}
                  </text>
                ))}
              </g>

              <g>
                {[...placed.values()].map((n) => {
                  const isActive = n.id === active
                  const isMe = n.id === meId
                  const dim = active != null && !isActive && !neighbours.has(n.id)
                  return (
                    <g
                      key={n.id}
                      tabIndex={0}
                      role="link"
                      aria-label={`${n.name}, ${n.department || "no department"}, ${n.degree} collaborator${n.degree === 1 ? "" : "s"}`}
                      onFocus={() => setActive(n.id)}
                      onBlur={() => setActive((a) => (a === n.id ? null : a))}
                      onMouseEnter={() => setActive(n.id)}
                      onMouseLeave={() => setActive((a) => (a === n.id ? null : a))}
                      onClick={() => go(n.id)}
                      onKeyDown={(e) => onNodeKeyDown(e, n.id)}
                      className="cursor-pointer outline-none transition-opacity duration-[var(--dur-2)] ease-out"
                      style={{ opacity: dim ? 0.25 : 1 }}
                    >
                      {/* An invisible, larger hit area — the visible dot for
                          somebody with one collaborator is 5px across, well
                          under a usable tap or click target on its own. */}
                      <circle cx={n.x} cy={n.y} r={n.r + 8} fill="transparent" />
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={n.r}
                        fill={
                          isMe || isActive ? "var(--color-accent)" : "var(--color-fg-subtle)"
                        }
                        stroke={isActive ? "var(--color-accent-line)" : "none"}
                        strokeWidth={isActive ? 3 : 0}
                      />
                    </g>
                  )
                })}
              </g>
            </svg>
          )}
        </div>

        <div className="text-sm">
          {activeNode ? (
            <div>
              <p className="font-medium text-fg">
                {activeNode.name}
                {activeNode.id === meId ? " (you)" : ""}
              </p>
              <Meta className="block">
                {[activeNode.department, activeNode.designation].filter(Boolean).join(" · ")}
              </Meta>
              <p className="mt-2 text-fg-muted">
                {activeNode.degree} collaborator{activeNode.degree === 1 ? "" : "s"} ·{" "}
                {activeNode.papers} paper{activeNode.papers === 1 ? "" : "s"}
              </p>
            </div>
          ) : (
            <p className="text-fg-muted">
              Point at, or tab to, a person in the drawing to see who they have written with.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
