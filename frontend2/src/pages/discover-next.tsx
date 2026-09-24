import { useState } from "react"
import { Link } from "react-router-dom"
import { Building2, Compass, LoaderCircle } from "lucide-react"

import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Callout, EmptyState, ErrorState, InlineError, SkeletonRows, SkeletonText } from "@/ui/state"
import { Meta, SectionTitle, Sub } from "@/ui/text"

/**
 * New things to work on: who to write with, where to aim, what to try.
 *
 * Counted from the college's own record, each entry with the reason it is
 * there, so this works on a server with no model at all — the free
 * deployment's normal state. Only the industry-partner list needs outside
 * knowledge, and only it asks a model; without one it is a single line, not
 * a button that can only fail.
 */

type Person = {
  id: string
  name: string
  department: string | null
  designation: string | null
  papers: number
  shared_areas: string[]
  shared_journals: string[]
  cross_department: boolean
  reasons: string[]
}

type Journal = { title: string; quartile: string; colleagues: number; areas: string[]; reason: string }

type Topic = { area: string; alongside: number; next_to: string; people: number; q1: number; reason: string }

type Next = {
  people: Person[]
  journals: Journal[]
  topics: Topic[]
  grounded_on: { papers: number; areas: string[]; interests: string[]; since: number }
  why_empty: string | null
}

type Partner = { name: string; kind: string | null; why: string; first_step: string | null }

type Partners = {
  partners: Partner[]
  unverified: boolean
  /** Why nothing was asked, when there was nothing of the reader's to ask about. */
  why_empty?: string
  model: string
}

/** The part of `/discover/status` this section needs. */
export type AiStatus = {
  available: boolean
  code?: string
  model: string
  hosted?: boolean
  host?: string
}

export function NextThings({ status }: { status: AiStatus | undefined }) {
  const q = useApi<Next>(["discover", "next"], "/api/discover/next")

  return (
    <section className="space-y-6" aria-labelledby="next-things">
      <div>
        <SectionTitle>
          <span id="next-things">New things to work on</span>
        </SectionTitle>
        <Sub className="mt-1">
          Counted from what you and colleagues here have published. Each one says why it is here.
        </Sub>
      </div>

      {q.isLoading ? (
        <div className="space-y-3">
          <SkeletonText lines={1} className="max-w-xs" />
          <SkeletonRows rows={4} rowHeight={56} />
        </div>
      ) : q.isError ? (
        <ErrorState title="Could not load suggestions" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.data?.why_empty ? (
        <EmptyState icon={Compass} title="Nothing to go on yet" message={q.data.why_empty} />
      ) : q.data ? (
        <>
          <PeopleList people={q.data.people} />
          <div className="grid gap-8 md:grid-cols-2">
            <JournalList journals={q.data.journals} />
            <TopicList topics={q.data.topics} />
          </div>
          <Meta className="block">{groundedOn(q.data.grounded_on)}</Meta>
        </>
      ) : null}

      <IndustryPartners status={status} />
    </section>
  )
}

function groundedOn(g: Next["grounded_on"]): string {
  const bits = [`${g.papers} paper${g.papers === 1 ? "" : "s"} of yours`]
  if (g.interests.length) bits.push(`${g.interests.length} domain${g.interests.length === 1 ? "" : "s"} you follow`)
  return `Based on ${bits.join(" and ")}, and what colleagues published since ${g.since}.`
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-semibold text-fg">{children}</h3>
}

function PeopleList({ people }: { people: Person[] }) {
  return (
    <section aria-label="People to work with" className="space-y-2">
      <Heading>People to work with</Heading>
      {people.length === 0 ? (
        <Meta className="block">
          Nobody you have not already written with shares your areas or journals recently.
        </Meta>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {people.map((p) => (
            <li key={p.id} className="py-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <Link
                  to={`/u/${p.id}`}
                  className="font-medium text-fg underline-offset-4 hover:text-accent hover:underline"
                >
                  {p.name}
                </Link>
                <Meta>
                  {[p.department, p.designation].filter(Boolean).join(" · ")}
                  {` · ${p.papers} recent paper${p.papers === 1 ? "" : "s"}`}
                </Meta>
              </div>
              <ul className="mt-1 space-y-0.5 text-sm text-fg-muted">
                {p.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Quartile({ q }: { q: string }) {
  return (
    <span className="shrink-0 rounded-sm bg-accent-wash px-1.5 py-0.5 text-xs font-medium text-accent">{q}</span>
  )
}

function JournalList({ journals }: { journals: Journal[] }) {
  return (
    <section aria-label="Journals to aim for" className="space-y-2">
      <Heading>Journals to aim for</Heading>
      {journals.length === 0 ? (
        <Meta className="block">
          No Q1 or Q2 journal in your field that colleagues here use and you have not yet.
        </Meta>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {journals.map((j) => (
            <li key={j.title} className="py-3">
              <p className="flex items-start gap-2">
                <Link
                  to={`/journals/${encodeURIComponent(j.title)}`}
                  className="min-w-0 font-medium text-fg underline-offset-4 hover:text-accent hover:underline"
                >
                  {j.title}
                </Link>
                <Quartile q={j.quartile} />
              </p>
              <p className="mt-1 text-sm text-fg-muted">{j.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function TopicList({ topics }: { topics: Topic[] }) {
  return (
    <section aria-label="Topics to try" className="space-y-2">
      <Heading>Topics to try</Heading>
      {topics.length === 0 ? (
        <Meta className="block">No area sits next to yours often enough here to suggest yet.</Meta>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {topics.map((t) => (
            <li key={t.area} className="py-3">
              <p className="font-medium text-fg">{t.area}</p>
              <p className="mt-1 text-sm text-fg-muted">{t.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Companies, laboratories and non-profits to approach — the one list that
 * needs knowledge the college does not hold, so the one that asks a model.
 *
 * Asked for rather than fetched: it spends the reader's daily AI allowance.
 * And printed with the warning that nothing in it was checked, because a
 * model naming a plausible company is exactly how somebody writes to one
 * that does not exist.
 */
function IndustryPartners({ status }: { status: AiStatus | undefined }) {
  const [asked, setAsked] = useState(false)
  const q = useApi<Partners>(["discover", "partners"], "/api/discover/partners", {
    enabled: asked && !!status?.available,
    staleTime: 30 * 60_000,
    retry: false,
  })

  if (!status) return null

  return (
    <section aria-label="Industry partners" className="space-y-2 border-t border-line pt-6">
      <Heading>Industry partners</Heading>
      {!status.available ? (
        <Meta className="block">
          {status.code === "not_configured"
            ? "Suggesting companies to work with needs AI, which is not set up on this server."
            : "Suggesting companies to work with needs the AI model, which is not answering right now."}
        </Meta>
      ) : !asked ? (
        <div className="space-y-2">
          <Button size="sm" onClick={() => setAsked(true)}>
            <Building2 aria-hidden />
            Suggest organisations
          </Button>
          <Meta className="block">
            Named by {status.model}
            {status.hosted && status.host ? ` at ${status.host}, from your paper titles and areas` : ""}.
          </Meta>
        </div>
      ) : q.isError ? (
        <InlineError message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.isPending || q.isFetching ? (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Asking {status.model}…
        </p>
      ) : q.data ? (
        q.data.partners.length === 0 ? (
          <Meta className="block">{q.data.why_empty || "The model named nobody it was confident exists."}</Meta>
        ) : (
          <>
            <ul className="divide-y divide-line border-y border-line">
              {q.data.partners.map((p) => (
                <li key={p.name} className="py-3">
                  <p className="font-medium text-fg">
                    {p.name}
                    {/* A real separator, not a margin: read aloud, the
                        margin-only version ran name and kind together. */}
                    {p.kind ? <Meta className="font-normal"> · {p.kind}</Meta> : null}
                  </p>
                  {p.why && <p className="mt-1 text-sm text-fg-muted">{p.why}</p>}
                  {p.first_step && <p className="mt-1 text-sm text-fg">First step: {p.first_step}</p>}
                </li>
              ))}
            </ul>
            <Callout tone="caution" title="Suggested, not checked">
              Named by {q.data.model}, and not checked against anything we hold. Confirm an
              organisation exists and does this work before you contact it.
            </Callout>
          </>
        )
      ) : null}
    </section>
  )
}
