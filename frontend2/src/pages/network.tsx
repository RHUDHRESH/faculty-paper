import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Search, Share2 } from "lucide-react"

import { useApi } from "@/lib/query"
import { Combobox } from "@/ui/combobox"
import { Input } from "@/ui/field"
import { ForceGraph, type GraphLink, type GraphNode } from "@/ui/graph"
import { EmptyState, ErrorState, Skeleton } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * The college's collaboration network (`/network`), and one person's corner
 * of it on their profile.
 *
 * Co-authorship is worked out from claims for the same paper -- nobody enters
 * it -- and a collaboration is one both people accepted. Neither carries
 * anything about money or where a paper is in the chain, which is why every
 * signed-in person can open it.
 */

type Graph = {
  nodes: GraphNode[]
  links: GraphLink[]
  department?: string | null
  hidden?: number
  departments?: string[]
  center?: string
}

export function CollegeNetwork() {
  const [params, setParams] = useSearchParams()
  const department = params.get("department") ?? ""
  const [q, setQ] = useState("")
  const query = useApi<Graph>(
    ["network", department],
    `/api/network${department ? `?department=${encodeURIComponent(department)}` : ""}`,
    { staleTime: 5 * 60_000 }
  )
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments")

  const match = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle || !query.data) return null
    return query.data.nodes.find((n) => n.name.toLowerCase().includes(needle)) ?? null
  }, [q, query.data])

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>The college network</PageTitle>
        <Sub className="mt-1">
          Who has written with whom, and who is collaborating now. A line is a paper filed by both people, or a
          collaboration both agreed to.
        </Sub>
      </header>

      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a person in the drawing"
            aria-label="Find a person in the drawing"
            className="pl-8"
          />
        </div>
        <Combobox
          value={department}
          onChange={(v) =>
            setParams((prev) => {
              const next = new URLSearchParams(prev)
              if (v) next.set("department", v)
              else next.delete("department")
              return next
            })
          }
          options={[{ value: "", label: "Every department" }, ...(departments.data ?? []).map((d) => ({ value: d, label: d }))]}
          aria-label="Department"
          className="w-full sm:w-60"
        />
        {q && (
          <Meta className="text-sm" aria-live="polite">
            {match ? (
              <>
                Found <Link to={`/u/${match.id}`} className="text-accent underline-offset-4 hover:underline">{match.name}</Link>
              </>
            ) : (
              "Nobody by that name in the drawing"
            )}
          </Meta>
        )}
      </div>

      {query.isPending ? (
        <Skeleton className="h-[28rem] w-full" />
      ) : query.isError ? (
        <ErrorState
          title="Could not draw the network"
          message="The server did not answer. An empty drawing here would say nobody is connected, which is not what happened."
          onRetry={() => void query.refetch()}
        />
      ) : query.data.nodes.length === 0 ? (
        <EmptyState
          icon={Share2}
          title="Nobody connected yet"
          message={
            department
              ? `Nobody in ${department} shares a paper or a collaboration with a colleague yet.`
              : "Once two colleagues file the same paper, or agree to collaborate, they appear here."
          }
        />
      ) : (
        <section className="space-y-2">
          <SectionTitle className="sr-only">The drawing</SectionTitle>
          <Meta className="block">
            {query.data.nodes.length} people and {query.data.links.length} connections
            {query.data.hidden ? `. ${query.data.hidden} more are connected but left off to keep it readable` : ""}.
          </Meta>
          <ForceGraph
            nodes={query.data.nodes}
            links={query.data.links}
            highlight={match?.id}
            height={560}
            label={`The college's collaboration network: ${query.data.nodes.length} people. Tab through to hear each person and open their profile.`}
          />
        </section>
      )}
    </div>
  )
}

/** One person's network, for their profile: the people around them and how those people connect. */
export function PersonGraph({ personId, name }: { personId: string; name: string }) {
  const query = useApi<Graph>(["person-graph", personId], `/api/people/${personId}/graph`, { staleTime: 5 * 60_000 })
  if (query.isPending) return <Skeleton className="h-80 w-full" />
  if (query.isError) {
    return (
      <ErrorState
        title="Could not draw this network"
        message="The server did not answer. Nothing about who has worked together has changed."
        onRetry={() => void query.refetch()}
      />
    )
  }
  // An optional section must never take the profile down with it: an answer
  // without nodes draws the empty state rather than throwing.
  const nodes = query.data.nodes ?? []
  if (nodes.length <= 1) {
    return (
      <EmptyState
        icon={Share2}
        title="No network here yet"
        message={`When ${name} files a paper with a colleague, or agrees to a collaboration, it is drawn here.`}
        action={
          <Link to="/network" className="text-sm text-accent underline-offset-4 hover:underline">
            See the college network
          </Link>
        }
      />
    )
  }
  return (
    <div className="space-y-2">
      <ForceGraph
        nodes={nodes}
        links={query.data.links ?? []}
        centerId={query.data.center ?? personId}
        height={340}
        label={`${name}'s network in the college: ${nodes.length - 1} people.`}
      />
      <Link to="/network" className="text-sm text-accent underline-offset-4 hover:underline">
        See the whole college network
      </Link>
    </div>
  )
}
