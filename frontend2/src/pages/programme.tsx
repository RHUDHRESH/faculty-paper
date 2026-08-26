import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowUpRight, ExternalLink, Sparkles, Users } from "lucide-react"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { money } from "@/ui/paper"
import { Callout, EmptyState, InlineError, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * A faculty member's research programme: what they work on, who else here
 * works on it, and what the wider field published this year.
 *
 * The important thing about this page is what it does *not* need. Every panel
 * on it works with no API key and no credits:
 *
 * - the areas, the colleagues and what they filed come from the college's own
 *   records, derived from papers people actually filed rather than from a
 *   profile somebody completed once in 2023;
 * - the field feed is a metasearch over OpenAlex, Crossref and arXiv, which
 *   are free and keyless, and it prices what it finds against our own payout
 *   tables — the one thing no search engine can do.
 *
 * The AI features elsewhere in the app degrade to "switched off" when the
 * Gemini credits run out. This does not, and that is the whole design: the
 * question "what should I work on and who with" is too central to be the
 * first thing that breaks when a billing account lapses.
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

type Programme = {
  areas: { key: string; count: number }[]
  interests: string[]
  /** What to ask the field about — your areas, or your stated interests. */
  search_terms: string[]
  colleagues: {
    id: string
    name: string
    department: string | null
    designation: string | null
    papers: number
    areas: string[]
    shared: number
  }[]
  live: {
    id: string
    paper_title: string
    journal_title: string | null
    publication_year: number | null
    quartile: string | null
    owner_id: string
    owner_name: string | null
    owner_department: string | null
    areas: string[]
  }[]
  totals: { my_papers: number; my_areas: number; colleagues: number }
  classified: number
}

type SearchResult = {
  title: string
  doi: string | null
  year: number | null
  journal: string | null
  issn: string | null
  citations: number | null
  open_access: boolean
  authors: string[]
  url: string | null
  sources: string[]
  journal_known: boolean
  quartile?: string | null
  snip?: number | null
  payout?: { amount: number | null; why_not?: string | null } | null
}

type SearchPayload = {
  results: SearchResult[]
  asked: string[]
  /** Upstreams that did not answer. Naming them stops a thin result set
   *  reading as a thin field. */
  failed: string[]
  query: string
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Programme() {
  const { me } = useAuth()
  const programme = useApi<Programme>(["programme", "me"], "/api/programme/me?limit=12")

  const [topic, setTopic] = useState<string | null>(null)
  const activeTopic = topic ?? programme.data?.search_terms[0] ?? null

  const firstName = (me?.name || "").replace(/^(Dr|Mr|Ms|Mrs|Prof)\.?\s*/i, "").split(" ")[0]

  return (
    <div className="page space-y-10">
      <header>
        <PageTitle>{firstName ? `${firstName}'s research` : "Your research"}</PageTitle>
        <Sub className="mt-1">
          What you work on, who else here works on it, and what the field published lately.
        </Sub>
      </header>

      {programme.isError ? (
        <InlineError
          message="Could not load your research picture."
          onRetry={() => programme.refetch()}
        />
      ) : programme.isLoading ? (
        <SkeletonRows rows={6} rowHeight={40} />
      ) : !programme.data ? null : programme.data.totals.my_papers === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing to build on yet"
          message="This page is assembled from the subject areas of papers you have filed. File your first one and your areas, your colleagues in them and a feed of the field all appear here."
          action={
            <Button kind="primary" asChild>
              <Link to="/papers/new">File a paper</Link>
            </Button>
          }
        />
      ) : (
        <>
          <Areas data={programme.data} active={activeTopic} onPick={setTopic} />
          <Field topic={activeTopic} />
          <Colleagues data={programme.data} />
          <LiveHere data={programme.data} />
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Your areas                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Areas come from the papers somebody actually filed, not from a form they
 * filled in. A stated interest is shown alongside but kept separate: what you
 * meant to work on and what you have published are different facts, and the
 * page is more useful for keeping them apart.
 */
function Areas({
  data,
  active,
  onPick,
}: {
  data: Programme
  active: string | null
  onPick: (topic: string) => void
}) {
  const unclassified = data.totals.my_papers - data.classified

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle>What you work on</SectionTitle>
        <Meta>
          {data.totals.my_areas} areas across {data.totals.my_papers} papers
        </Meta>
      </div>

      <div className="flex flex-wrap gap-1">
        {data.areas.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => onPick(a.key)}
            aria-pressed={active === a.key}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-sm",
              "transition-colors duration-[var(--dur-1)] ease-out",
              active === a.key
                ? "bg-selected font-medium text-fg"
                : "text-fg-muted hover:bg-hover hover:text-fg"
            )}
          >
            {a.key}
            <span className="tabular text-fg-subtle">{a.count}</span>
          </button>
        ))}
      </div>

      {unclassified > 0 && (
        <Meta className="block">
          {unclassified} of your {data.totals.my_papers} papers carry no subject area — their
          journal could not be matched against our reference data, so they are not counted
          above.
        </Meta>
      )}

      {data.interests.length > 0 && (
        <p className="text-base text-fg-muted">
          You have also said you are interested in {data.interests.join(", ")}.
        </p>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* The field                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * What the wider field published in this area, priced against our own tables.
 *
 * Fetched only once a topic is chosen: three upstream APIs answer in their
 * own time, and firing all of them on page load makes the whole screen wait
 * on the slowest one for information nobody has asked for yet.
 */
function Field({ topic }: { topic: string | null }) {
  const search = useApi<SearchPayload>(
    ["research", "search", topic],
    `/api/research/search?q=${encodeURIComponent(topic ?? "")}&limit=12`,
    { enabled: Boolean(topic), staleTime: 10 * 60_000 }
  )

  if (!topic) return null

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle>Lately in {topic}</SectionTitle>
        <Meta>OpenAlex · Crossref · arXiv</Meta>
      </div>

      {search.isLoading ? (
        <SkeletonRows rows={5} rowHeight={56} />
      ) : search.isError ? (
        <InlineError
          message="The field search did not answer. Your own record above is unaffected."
          onRetry={() => search.refetch()}
        />
      ) : !search.data || search.data.results.length === 0 ? (
        <p className="border-y border-line py-8 text-center text-sm text-fg-muted">
          Nothing came back for {topic}. Try one of your other areas.
        </p>
      ) : (
        <>
          {search.data.failed.length > 0 && (
            // Said plainly: a thin list of results should read as one source
            // being down, not as a thin field.
            <Callout tone="caution" title={`${search.data.failed.join(" and ")} did not answer`}>
              These results come from the sources that did. There is likely more out there than
              is shown here.
            </Callout>
          )}

          <ul className="divide-y divide-line border-y border-line">
            {search.data.results.map((r, i) => (
              <li key={r.doi || `${r.title}-${i}`} className="space-y-1 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-start gap-1 text-base underline-offset-4 hover:underline"
                      >
                        <span className="min-w-0">{r.title}</span>
                        <ExternalLink className="mt-1 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                      </a>
                    ) : (
                      <span className="text-base">{r.title}</span>
                    )}
                    <Meta className="mt-0.5 block truncate">
                      {[
                        r.journal,
                        r.year,
                        r.authors.slice(0, 3).join(", "),
                        r.citations != null ? `${r.citations} citations` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Meta>
                  </div>

                  {/* Priced only where we recognise the journal. An amount
                      beside a venue we cannot identify is a number somebody
                      would plan around, and we have no basis for it. */}
                  <div className="shrink-0 text-right">
                    {r.journal_known ? (
                      <>
                        <p className="text-base font-medium tabular">
                          {r.payout?.amount != null ? money(r.payout.amount) : "—"}
                        </p>
                        <Meta className="block text-xs">
                          {r.quartile ? `${r.quartile} · ` : ""}
                          {r.payout?.amount != null ? "if you published here" : "not priceable"}
                        </Meta>
                      </>
                    ) : (
                      <Meta className="block text-xs">Journal not in our tables</Meta>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-3">
                  {r.open_access && <Meta className="text-positive">Open access</Meta>}
                  <Meta className="text-xs">{r.sources.join(" + ")}</Meta>
                  {r.payout?.why_not && <Meta className="text-xs">{r.payout.why_not}</Meta>}
                </div>
              </li>
            ))}
          </ul>

          <Meta className="block">
            Amounts are an estimate for a single author, from our own payout tables — what a
            paper actually pays depends on your position and the number of authors.
          </Meta>
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Who else is here                                                          */
/* ------------------------------------------------------------------------ */

function Colleagues({ data }: { data: Programme }) {
  if (data.colleagues.length === 0) {
    return (
      <section className="space-y-2">
        <SectionTitle>Who else works on this</SectionTitle>
        <p className="border-y border-line py-8 text-center text-sm text-fg-muted">
          Nobody else here has filed a paper in your areas yet.
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle>Who else works on this</SectionTitle>
        <Link to="/collaborate" className="text-sm text-accent underline-offset-4 hover:underline">
          The whole graph
        </Link>
      </div>
      <p className="max-w-2xl text-base text-fg-muted">
        Ranked by how many of your subject areas they also publish in. This is derived from
        filed papers, so it is who is genuinely working nearby rather than who says they are.
      </p>
      <ul className="divide-y divide-line border-y border-line">
        {data.colleagues.map((p) => (
          <li key={p.id} className="row">
            <Link to={`/people/${p.id}`} className="flex items-center gap-4 px-1 py-2.5 sm:px-2">
              <Users className="size-4 shrink-0 text-fg-subtle" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base">{p.name}</span>
                <Meta className="block truncate">
                  {[p.department, p.designation].filter(Boolean).join(" · ")} ·{" "}
                  {p.areas.slice(0, 3).join(", ")}
                  {p.areas.length > 3 ? ` +${p.areas.length - 3}` : ""}
                </Meta>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-base tabular">{p.shared}</span>
                <Meta className="block text-xs">shared areas</Meta>
              </span>
              <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* What is being filed here now                                              */
/* ------------------------------------------------------------------------ */

/**
 * The live front inside the college: the most recent papers filed in your
 * areas by anybody else.
 *
 * Carries no amount. A colleague's payout is not a claimant's business, and
 * the endpoint behind this omits it rather than trusting the screen to.
 */
function LiveHere({ data }: { data: Programme }) {
  if (data.live.length === 0) return null

  return (
    <section className="space-y-2">
      <SectionTitle>Filed here recently, in your areas</SectionTitle>
      <ul className="divide-y divide-line border-y border-line">
        {data.live.map((l) => (
          <li key={l.id} className="row">
            <Link to={`/papers/${l.id}`} className="flex items-center gap-4 px-1 py-2.5 sm:px-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base">{l.paper_title || "Untitled"}</span>
                <Meta className="block truncate">
                  {[l.owner_name, l.owner_department, l.journal_title, l.publication_year]
                    .filter(Boolean)
                    .join(" · ")}
                </Meta>
              </span>
              {l.quartile && (
                <span className="shrink-0 text-sm tabular text-fg-muted">{l.quartile}</span>
              )}
              <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      <ColumnLabel className="block">
        Papers filed by colleagues — no amounts, by design
      </ColumnLabel>
    </section>
  )
}
