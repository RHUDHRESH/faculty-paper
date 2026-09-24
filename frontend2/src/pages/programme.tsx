import { firstName } from "@/lib/names"
import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import {
  ArrowUpRight,
  Binoculars,
  Building2,
  Compass,
  ExternalLink,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Papers, type Profile } from "@/pages/person"
import { Button } from "@/ui/button"
import { money } from "@/ui/paper"
import { Avatar, PersonLink } from "@/ui/person"
import { Callout, EmptyState, ErrorState, InlineError, SkeletonRows, SkeletonText } from "@/ui/state"
import { ColumnLabel, Figure, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * Two pages: a faculty member's own research (`Programme`, `/programme`), and
 * the college's (`CollegeResearch`, `/research`).
 *
 * They were one page until the owner's rule: "X's research" shows X's work
 * and only that. So the first is the person's papers, areas and co-authors,
 * and everything about other people moved to the second — what the college
 * is working on, who is nearby, what was filed lately, and what to try next.
 *
 * The important thing about the college page is which parts can be wrong. Most
 * are counted from papers people have actually filed — they need no model, no
 * key and no network, and they render immediately. Only the last one is
 * generated, and it is kept behind its own request, its own button and its own
 * bounded region with an accent edge, because inference here runs on this
 * server's CPU at about four and a half tokens a second and a reader deserves
 * to know which sentences on a page were counted and which were written.
 *
 * That separation is structural, not cosmetic: the suggestions live at a
 * different endpoint, so a model that is missing, slow or wrong cannot delay
 * or blank a single measured figure above it.
 *
 * No money anywhere. A head of department may read all of this, and the
 * endpoints behind it carry no rupee figure to strip — the one exception is
 * the field search, which prices a *hypothetical* paper of the reader's own
 * and is already guarded server-side.
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

/** `/api/programme/me` — the person's own work and nothing else. */
type Programme = Pick<Profile, "papers" | "counts" | "coauthors"> & {
  areas: { key: string; count: number }[]
  interests: string[]
  /** What to ask the field about — your areas, or your stated interests. */
  search_terms: string[]
  totals: { my_papers: number; my_areas: number }
  classified: number
}

/** `/api/programme/around` — the college around a person's areas. */
type Around = {
  areas: string[]
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
}

type TrendName = "new" | "growing" | "steady" | "fading" | "unknown"

type AreaRow = {
  area: string
  papers: number
  prior: number
  change: number
  trend: TrendName
  share: number
  people: number
  departments: string[]
}

type Landscape = {
  window: {
    latest_year: number
    recent_from: number
    recent_to: number
    prior_from: number
    prior_to: number
  }
  totals: {
    papers: number
    papers_prior: number
    classified: number
    unclassified: number
    areas: number
    departments: number
    people: number
    truncated: boolean
    /** Whether the earlier window holds enough papers to be compared against.
     *  When it does not, every direction is withheld rather than guessed —
     *  see `not_comparable_why`. */
    comparable: boolean
    not_comparable_why: string | null
  }
  areas: AreaRow[]
  rising: AreaRow[]
  fading: AreaRow[]
  departments: {
    department: string
    papers: number
    areas: string[]
    moving_into: { area: string; papers: number; prior: number }[]
  }[]
  journals: { title: string; papers: number; quartile: string | null; people: number }[]
  years: { year: number; papers: number }[]
}

type NearbyPeople = {
  people: {
    id: string
    name: string
    department: string | null
    designation: string | null
    papers: number
    shared_areas: string[]
    shared_interests: string[]
    overlap: number
    why: string
    recent: {
      title: string
      journal: string | null
      year: number | null
      quartile: string | null
    }
  }[]
  grounded_on: { areas: string[]; interests: string[]; since: number }
  /** Why the list is empty, when it is. Two different reasons, two different
   *  remedies, so the server says which rather than leaving the screen to
   *  guess. */
  why_empty: string | null
}

/** Whether the suggestion half can run, and if not, which of the three ways
 *  it is off — each has a different one-command fix. */
type AiState = {
  available: boolean
  code: string | null
  detail: string | null
  model: string
  provider: string | null
  /** True when the question is sent to a hosted service; `host` names it. */
  hosted?: boolean
  host?: string
}

type Overview = { college: Landscape; people: NearbyPeople; ai: AiState }

type OpeningsPayload = {
  openings: {
    topic: string
    why: string
    first_step: string
    /** Present only when the area the model named exists in our own data,
     *  and then it carries that area's real paper count. */
    area: { name: string; papers: number; trend: TrendName } | null
    /** Present only when the name resolved to one active person here. */
    with_whom: { id: string; name: string; department: string | null } | null
  }[]
  unverified: { people: string[]; areas: string[] }
  grounded_on: {
    papers: number
    interests: string[]
    college_areas: string[]
    colleagues_offered: string[]
  }
  note?: string
  model: string
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

/**
 * "X's research": X's own work, and nothing else.
 *
 * The owner's rule, after this page opened on the whole college's picture
 * under a heading with somebody's name on it. The same paper list their
 * public profile shows (`social.research_record` behind both), so what a
 * person sees of their own work and what a colleague sees of it cannot
 * disagree. The college picture moved to `/research`.
 */
export function Programme() {
  const { me } = useAuth()
  const programme = useApi<Programme>(["programme", "me"], "/api/programme/me")
  const first = firstName(me?.name)

  return (
    <div className="page max-w-3xl space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <PageTitle>{first ? `${first}'s research` : "Your research"}</PageTitle>
          <Sub className="mt-1">Your papers, the areas they fall in, and who you wrote them with.</Sub>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {me && (
            <Button kind="default" size="md" asChild>
              <Link to={`/u/${me.id}`}>
                <Users />
                Your public profile
              </Link>
            </Button>
          )}
          <Button kind="quiet" size="md" asChild>
            <Link to="/research">
              <Binoculars />
              The college's research
            </Link>
          </Button>
        </div>
      </header>

      {programme.isError ? (
        <ErrorState
          title="Could not load your research"
          message="The server did not answer. Nothing you filed has been lost."
          onRetry={() => void programme.refetch()}
        />
      ) : programme.isPending ? (
        <SkeletonRows rows={6} rowHeight={40} />
      ) : programme.data.totals.my_papers === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing of your own here yet"
          message="Your papers, their subject areas and the colleagues you wrote them with are assembled from what you file. File your first one and it appears here."
          action={
            <Button kind="primary" asChild>
              <Link to="/papers/new">File a paper</Link>
            </Button>
          }
        />
      ) : (
        <>
          <MyCounts counts={programme.data.counts} />
          <Areas data={programme.data} />
          <Papers papers={programme.data.papers} isMe name={me?.name ?? ""} />
          {programme.data.coauthors.length > 0 && (
            <section className="space-y-3">
              <SectionTitle>Who you have written with, here</SectionTitle>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {programme.data.coauthors.map((c) => (
                  <li key={c.id} className="flex items-center gap-3">
                    <Avatar person={c} size="sm" />
                    <span className="min-w-0 flex-1">
                      <PersonLink id={c.id} name={c.name} className="block truncate text-sm" />
                      <Meta className="block truncate text-xs">
                        {[c.department, `${c.together} paper${c.together === 1 ? "" : "s"} together`]
                          .filter(Boolean)
                          .join(" · ")}
                      </Meta>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function MyCounts({ counts }: { counts: Programme["counts"] }) {
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-2">
      {[
        { label: counts.papers === 1 ? "paper" : "papers", value: counts.papers },
        { label: "in Q1 journals", value: counts.q1 },
        { label: "as first author", value: counts.first_author },
        { label: counts.areas === 1 ? "subject area" : "subject areas", value: counts.areas },
      ].map((i) => (
        <span key={i.label} className="flex items-baseline gap-2">
          <Figure className="text-2xl">{i.value}</Figure>
          <Meta>{i.label}</Meta>
        </span>
      ))}
    </div>
  )
}

/**
 * The college's research, and where the reader stands in it.
 *
 * Everything that used to sit on "X's research" and was about other people:
 * what the college is publishing, who else works in the reader's areas, what
 * was filed here lately, the wider field, and the suggestions. Counted, not
 * generated, except the last part — which says so.
 */
export function CollegeResearch() {
  // Its own request, because it is the same answer for everybody and it must
  // appear whether or not the reader has filed anything.
  const overview = useApi<Overview>(["trends", "me"], "/api/trends/me", {
    staleTime: 10 * 60_000,
  })
  const around = useApi<Around>(["programme", "around"], "/api/programme/around?limit=12")

  const [topic, setTopic] = useState<string | null>(null)
  const activeTopic = topic ?? around.data?.areas[0] ?? null

  return (
    <div className="page space-y-10">
      <header>
        <PageTitle>The college's research</PageTitle>
        <Sub className="mt-1">
          What this college is working on, who works near your areas, and what to try next. Your
          own work is on{" "}
          <Link to="/programme" className="text-accent underline-offset-4 hover:underline">
            your research
          </Link>
          .
        </Sub>
      </header>

      <CollegeNow
        data={overview.data?.college}
        loading={overview.isLoading}
        error={overview.isError}
        onRetry={() => void overview.refetch()}
        onPick={setTopic}
        active={activeTopic}
      />

      <Field topic={activeTopic} />

      <Nearby
        data={overview.data?.people}
        loading={overview.isLoading}
        error={overview.isError}
        onRetry={() => void overview.refetch()}
        fallback={around.data?.colleagues ?? []}
      />

      {around.isError ? (
        <InlineError
          message="Could not load what was filed lately in your areas. Everything above is unaffected."
          onRetry={() => void around.refetch()}
        />
      ) : (
        around.data && <LiveHere live={around.data.live} />
      )}

      <Openings ai={overview.data?.ai} loading={overview.isLoading} />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* What this college is working on                                           */
/* ------------------------------------------------------------------------ */

/**
 * The measured landscape: areas and journals by volume over the last three
 * years, which departments are moving into what, and what is growing or
 * fading against the three years before that.
 *
 * Counted from filed papers, so it needs no model and cannot be wrong in the
 * way a suggestion can. It is first on the page for that reason — it is the
 * part that always works, and the part everything below it is measured
 * against.
 */
function CollegeNow({
  data,
  loading,
  error,
  onRetry,
  onPick,
  active,
}: {
  data: Landscape | undefined
  loading: boolean
  error: boolean
  onRetry: () => void
  onPick: (topic: string) => void
  active: string | null
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <SectionTitle>What this college is working on</SectionTitle>
        {data && data.totals.papers > 0 && (
          <Meta>
            {data.window.recent_from}&ndash;{data.window.recent_to}
            {data.totals.comparable
              ? `, against ${data.window.prior_from}–${data.window.prior_to}`
              : ""}
          </Meta>
        )}
      </div>

      {loading ? (
        <SkeletonRows rows={5} rowHeight={48} />
      ) : error ? (
        <InlineError
          message="Could not load the college picture. Your own record below is unaffected."
          onRetry={onRetry}
        />
      ) : !data ? null : data.totals.papers === 0 ? (
        <EmptyState
          icon={Binoculars}
          title="No papers filed in the last three years"
          message="This picture is counted from papers people here have filed. Once the first ones are in, the subject areas, the journals and what each department is moving into all appear here."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="flex items-baseline gap-2">
              <Figure className="text-2xl">{data.totals.papers}</Figure>
              <Meta>papers</Meta>
            </span>
            <span className="flex items-baseline gap-2">
              <Figure className="text-2xl">{data.totals.areas}</Figure>
              <Meta>subject areas</Meta>
            </span>
            <span className="flex items-baseline gap-2">
              <Figure className="text-2xl">{data.totals.people}</Figure>
              <Meta>people</Meta>
            </span>
            <span className="flex items-baseline gap-2">
              <Figure className="text-2xl">{data.totals.departments}</Figure>
              <Meta>departments</Meta>
            </span>
          </div>

          <ul className="divide-y divide-line border-y border-line">
            {data.areas.map((a) => (
              <li key={a.area} className="row">
                <button
                  type="button"
                  onClick={() => onPick(a.area)}
                  aria-pressed={active === a.area}
                  className={cn(
                    "flex w-full items-center gap-3 px-1 py-2.5 text-left sm:gap-4 sm:px-2",
                    active === a.area && "bg-selected"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base">{a.area}</span>
                    <Meta className="block truncate">
                      {a.people} {a.people === 1 ? "person" : "people"}
                      {a.departments.length > 0 ? ` · ${a.departments.join(", ")}` : ""}
                    </Meta>
                  </span>
                  <TrendTag row={a} />
                  <span className="w-10 shrink-0 text-right text-base tabular sm:w-14">
                    {a.papers}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <ColumnLabel className="block">
            A paper counts once in each of its subject areas, so these add up to more than{" "}
            {data.totals.papers}. Pick one to search the wider field for it.
          </ColumnLabel>

          {data.totals.comparable ? (
            <div className="grid grid-cols-1 gap-x-8 gap-y-6 pt-2 sm:grid-cols-2">
              <Moving rows={data.rising} title="Growing" tone="up" since={data.window.prior_to} />
              <Moving rows={data.fading} title="Fading" tone="down" since={data.window.prior_to} />
            </div>
          ) : (
            // Not an error and not an omission. The earlier years are barely
            // in the system, so a direction computed against them would be
            // the shape of the import reported as a change in the college.
            <Callout tone="info" title="No direction is shown for these areas">
              {data.totals.not_comparable_why}
            </Callout>
          )}

          <div className="grid grid-cols-1 gap-x-8 gap-y-6 pt-2 sm:grid-cols-2">
            <Departments rows={data.departments} />
            <Journals rows={data.journals} />
          </div>

          {data.totals.unclassified > 0 && (
            <Meta className="block">
              {data.totals.unclassified} of the {data.totals.papers} papers carry no subject
              area — their journal could not be matched against our reference data, so they
              are counted in the total and in nothing else.
            </Meta>
          )}
        </>
      )}
    </section>
  )
}

/**
 * How an area moved, said in a word and a signed number.
 *
 * Both, always. Colour alone would leave a reader who cannot use it with two
 * identical rows and no idea which way either of them went.
 */
function TrendTag({ row }: { row: AreaRow }) {
  // Nothing at all when the earlier window is too thin to compare against.
  // A blank is honest; "steady" would be an assertion nobody can support.
  if (row.trend === "unknown") return null
  if (row.trend === "steady") {
    return <span className="hidden w-20 shrink-0 text-right text-xs text-fg-subtle sm:block">steady</span>
  }
  const up = row.trend !== "fading"
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs tabular",
        up ? "text-positive" : "text-caution"
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {row.trend === "new" ? "new" : `${row.change > 0 ? "+" : ""}${row.change}`}
    </span>
  )
}

function Moving({
  rows,
  title,
  tone,
  since,
}: {
  rows: AreaRow[]
  title: string
  tone: "up" | "down"
  since: number
}) {
  return (
    <div className="space-y-2">
      <ColumnLabel className="block">{title}</ColumnLabel>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Nothing here moved by more than a paper since {since}. That is steadiness, not a
          missing answer.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((a) => (
            <li key={a.area} className="flex items-baseline justify-between gap-3 text-base">
              <span className="min-w-0 truncate">{a.area}</span>
              <span
                className={cn(
                  "shrink-0 text-sm tabular",
                  tone === "up" ? "text-positive" : "text-caution"
                )}
              >
                {a.prior} &rarr; {a.papers}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Departments({ rows }: { rows: Landscape["departments"] }) {
  return (
    // `min-w-0` guards this item against a long unbreakable string; the page
    // width itself is held by `grid-cols-1` on the container above. Both are
    // needed and they fix different things: below `sm` the wrapper declared no
    // columns at all, so children landed in an implicit `grid-auto-columns:
    // auto` track that sizes from *max*-content -- and `min-width: 0` lowers an
    // item's minimum, never its maximum. That was 1,158px of page in a 375px
    // window, and it survived the first fix.
    <div className="min-w-0 space-y-2">
      <ColumnLabel className="block">Departments, and what they are moving into</ColumnLabel>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No department is recorded against these papers.</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.slice(0, 6).map((d) => (
            <li key={d.department} className="flex items-start gap-2">
              <Building2 className="mt-1 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-base">
                  {d.department} <span className="tabular text-fg-subtle">{d.papers}</span>
                </span>
                <Meta className="block">
                  {d.moving_into.length > 0
                    ? `moving into ${d.moving_into.map((m) => m.area).join(", ")}`
                    : d.areas.join(", ")}
                </Meta>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Journals({ rows }: { rows: Landscape["journals"] }) {
  return (
    <div className="space-y-2">
      <ColumnLabel className="block">Where it is being published</ColumnLabel>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No journal is recorded against these papers.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.slice(0, 8).map((j) => (
            <li key={j.title} className="flex items-baseline justify-between gap-3">
              <Link
                to={`/journals?title=${encodeURIComponent(j.title)}`}
                className="min-w-0 truncate text-base underline-offset-4 hover:underline"
              >
                {j.title}
              </Link>
              <span className="shrink-0 text-sm tabular text-fg-muted">
                {j.quartile ? `${j.quartile} · ` : ""}
                {j.papers}
              </span>
            </li>
          ))}
        </ul>
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
function Areas({ data }: { data: Programme }) {
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
          <span
            key={a.key}
            className="inline-flex h-7 items-center gap-1.5 rounded-sm bg-sunken px-2 text-sm text-fg"
          >
            {a.key}
            <span className="tabular text-fg-subtle">{a.count}</span>
          </span>
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
/* Who to work with                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Colleagues whose *recent* output overlaps this person's areas, or the
 * domains they have said they follow.
 *
 * Recency is the whole point of the panel. Somebody who worked on this six
 * years ago and has since moved on is not who to start a project with this
 * month, and an all-time collaborator list cannot tell the two apart.
 *
 * Every name is a person in our own records and every overlap is a subject
 * area both people have published in — the sentence under each name is built
 * from those counts, not written by anything.
 */
function Nearby({
  data,
  loading,
  error,
  onRetry,
  fallback,
}: {
  data: NearbyPeople | undefined
  loading: boolean
  error: boolean
  onRetry: () => void
  fallback: Around["colleagues"]
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle>Who to work with</SectionTitle>
        <Link to="/collaborate" className="text-sm text-accent underline-offset-4 hover:underline">
          The whole graph
        </Link>
      </div>

      {loading ? (
        <SkeletonRows rows={4} rowHeight={56} />
      ) : error ? (
        <>
          <InlineError message="The overlap could not be worked out." onRetry={onRetry} />
          {/* The simpler match from the other endpoint still stands, so the
              section degrades to a shorter answer rather than to nothing. */}
          {fallback.length > 0 && (
            <ul className="divide-y divide-line border-y border-line">
              {fallback.map((p) => (
                <li key={p.id} className="row">
                  <Link
                    to={`/u/${p.id}`}
                    className="flex items-center gap-4 px-1 py-2.5 sm:px-2"
                  >
                    <Users className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base">{p.name}</span>
                      <Meta className="block truncate">
                        {[p.department, p.designation].filter(Boolean).join(" · ")} ·{" "}
                        {p.areas.slice(0, 3).join(", ")}
                      </Meta>
                    </span>
                    <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : !data ? null : data.people.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nobody nearby yet"
          message={
            data.why_empty ||
            "Nobody else here has filed a paper in your areas recently. That is a gap, not a fault."
          }
        />
      ) : (
        <>
          <p className="max-w-2xl text-base text-fg-muted">
            Ranked by how much of your recent work they overlap, counted from papers filed
            since {data.grounded_on.since}. It is who is genuinely working nearby rather than
            who says they are.
          </p>
          <ul className="divide-y divide-line border-y border-line">
            {data.people.map((p) => (
              <li key={p.id} className="row">
                <Link
                  to={`/u/${p.id}`}
                  className="flex items-start gap-3 px-1 py-3 sm:gap-4 sm:px-2"
                >
                  <Users className="mt-1 size-4 shrink-0 text-fg-subtle" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base">{p.name}</span>
                    <Meta className="block truncate">
                      {[p.department, p.designation].filter(Boolean).join(" · ")}
                    </Meta>
                    <span className="mt-1 block text-sm text-fg-muted">{p.why}</span>
                    {p.shared_interests.length > 0 && (
                      <Meta className="mt-0.5 block truncate">
                        Also in a domain you follow: {p.shared_interests.join(", ")}
                      </Meta>
                    )}
                    <Meta className="mt-0.5 block truncate">
                      Latest: {p.recent.title}
                      {p.recent.year ? ` (${p.recent.year})` : ""}
                    </Meta>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-base tabular">{p.overlap}</span>
                    <Meta className="block text-xs">shared</Meta>
                  </span>
                  <ArrowUpRight className="reveal mt-1 size-4 shrink-0 text-fg-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          <ColumnLabel className="block">
            Counted from filed papers — no amounts, by design
          </ColumnLabel>
        </>
      )}
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
function LiveHere({ live }: { live: Around["live"] }) {
  if (live.length === 0) return null

  return (
    <section className="space-y-2">
      <SectionTitle>Filed here recently, in your areas</SectionTitle>
      <ul className="divide-y divide-line border-y border-line">
        {live.map((l) => (
          <li key={l.id} className="row">
            {/* To the colleague who wrote it, not to the claim: a claimant
                cannot open somebody else's ticket, and the person is the
                useful thing to find. */}
            <Link to={`/u/${l.owner_id}`} className="flex items-center gap-4 px-1 py-2.5 sm:px-2">
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

/* ------------------------------------------------------------------------ */
/* What to try next — the generated part                                     */
/* ------------------------------------------------------------------------ */

/**
 * THE ONE PART OF THIS PAGE THAT CAN BE WRONG, and the reason it looks
 * different from everything above it.
 *
 * Everything else here was counted. This was written by a model, so it sits
 * inside its own bounded region with an accent edge and a label saying so —
 * a reader must be able to tell, without reading a word, which sentences on
 * the page are facts about the college and which are somebody's suggestion.
 *
 * Three further things this shape is doing:
 *
 * - It is asked for rather than fetched. Generation runs on this server's CPU
 *   at about four and a half tokens a second, so an automatic request would
 *   spend a minute and a half of four cores every time anybody opened the
 *   page, most of the time for a suggestion nobody wanted.
 * - The wait says how long it has been going. A silent spinner at this
 *   latency reads as a hang, and the remedy a reader reaches for is a reload,
 *   which leaves the model generating an answer that is no longer going
 *   anywhere.
 * - What the model named and we could not find is shown separately and bare.
 *   A colleague who does not work here, printed next to a paper count, is how
 *   somebody emails a person who does not exist.
 */
function Openings({ ai, loading }: { ai: AiState | undefined; loading: boolean }) {
  const [asked, setAsked] = useState(false)
  const q = useApi<OpeningsPayload>(["trends", "openings"], "/api/trends/openings", {
    enabled: asked,
    staleTime: 30 * 60_000,
    // A retry here is another ninety seconds of somebody's afternoon spent on
    // the failure they have already been told about.
    retry: false,
  })
  const elapsed = useElapsed(q.isFetching)

  return (
    <section className="space-y-3 rounded-lg border border-accent-line px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <SectionTitle>What to try next</SectionTitle>
        <Meta className="inline-flex items-center gap-1">
          <Sparkles className="size-3.5" aria-hidden />
          Suggested, not counted
        </Meta>
      </div>

      <p className="max-w-2xl text-base text-fg-muted">
        Everything above this line is counted from papers people filed. This part is written
        by {ai?.hosted ? "a hosted model" : "a model running on this server"} — it can be wrong,
        so every area and every person it names is checked against our own records before it is
        shown here.
      </p>

      {loading ? (
        <SkeletonText lines={1} className="max-w-sm" />
      ) : ai && !ai.available && ai.code === "not_configured" ? (
        <Meta className="block">
          AI suggestions are not set up on this server. Everything above is counted from our own
          records and never needed a model.
        </Meta>
      ) : ai && !ai.available ? (
        <ModelOff ai={ai} />
      ) : !asked ? (
        <div className="space-y-2">
          <Button kind="primary" size="sm" onClick={() => setAsked(true)}>
            <Compass className="size-4" aria-hidden />
            Suggest some directions
          </Button>
          <Meta className="block">
            {ai?.hosted
              ? `Takes a few seconds. ${ai.model} at ${ai.host} is sent your paper titles and areas to answer.`
              : `Takes a minute or two${ai?.model ? ` — ${ai.model} runs on this server's CPU` : ""}, and nothing you have written leaves this machine.`}
          </Meta>
        </div>
      ) : q.isError ? (
        <>
          <InlineError
            message={
              q.error.status === 503
                ? q.error.message
                : q.error.status === 502
                  ? "The model did not answer in the shape we asked for."
                  : q.error.message
            }
            onRetry={() => void q.refetch()}
          />
          <Meta className="block">
            Nothing above is affected — all of it was counted from our own records.
          </Meta>
        </>
      ) : q.isPending || q.isFetching ? (
        <div className="space-y-3">
          <SkeletonRows rows={3} rowHeight={72} />
          {/* A live region, not decoration: the skeleton is hidden from
              assistive technology, so without this the wait is silent for a
              minute and a half and indistinguishable from nothing happening. */}
          <p role="status" aria-live="polite">
            <Meta className="block">
              {ai?.hosted
                ? `Thinking. ${elapsed}s so far. The figures above are already final.`
                : `Thinking. ${elapsed}s so far, of a minute or two — the model runs on this server's CPU rather than in a data centre. The figures above are already final.`}
            </Meta>
          </p>
        </div>
      ) : q.data ? (
        q.data.openings.length === 0 ? (
          <EmptyState
            icon={Compass}
            title="Nothing to go on yet"
            message={
              q.data.note ||
              "File a paper, or pick the domains you work in, and this will have something to build on."
            }
          />
        ) : (
          <>
            <ul className="divide-y divide-line border-y border-line">
              {q.data.openings.map((o, i) => (
                <li key={`${o.topic}-${i}`} className="py-4">
                  <p className="text-base font-semibold text-fg">{o.topic}</p>
                  {o.why && <p className="mt-1 text-sm text-fg-muted">{o.why}</p>}

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {/* Both of these are here only because the database found
                        them. The count is ours, not the model's. */}
                    {o.area && (
                      <Meta className="inline-flex items-center gap-1">
                        {o.area.name}
                        <span className="tabular text-fg-subtle">
                          {o.area.papers} here
                        </span>
                      </Meta>
                    )}
                    {o.with_whom && (
                      <Link
                        to={`/u/${o.with_whom.id}`}
                        className="inline-flex items-center gap-1 text-sm text-accent underline-offset-4 hover:underline"
                      >
                        <Users className="size-3.5" aria-hidden />
                        {o.with_whom.name}
                        {o.with_whom.department ? ` · ${o.with_whom.department}` : ""}
                      </Link>
                    )}
                  </div>

                  {o.first_step && (
                    <p className="mt-2.5 flex flex-wrap items-start gap-x-2 gap-y-1 text-sm">
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent-wash px-1.5 py-0.5 text-xs font-medium text-accent">
                        First step
                      </span>
                      <span className="text-fg">{o.first_step}</span>
                    </p>
                  )}
                </li>
              ))}
            </ul>

            {(q.data.unverified.people.length > 0 || q.data.unverified.areas.length > 0) && (
              // Separately, and with nothing beside them. These are names the
              // model produced that our own tables do not have, and a count
              // next to one would make it look checked.
              <Callout tone="caution" title="Named, but not found in our records">
                {q.data.unverified.people.length > 0 && (
                  <p>
                    No colleague here is called{" "}
                    {q.data.unverified.people.map((n) => `"${n}"`).join(", ")}. Treat those
                    names as the model guessing.
                  </p>
                )}
                {q.data.unverified.areas.length > 0 && (
                  <p className="mt-1">
                    Nobody here publishes under{" "}
                    {q.data.unverified.areas.map((n) => `"${n}"`).join(", ")}, so there is no
                    figure to put beside it.
                  </p>
                )}
              </Callout>
            )}

            <Meta className="block">{groundedOn(q.data)}</Meta>
          </>
        )
      ) : null}
    </section>
  )
}

function groundedOn(data: OpeningsPayload): string {
  const bits = [`${data.grounded_on.papers} paper${data.grounded_on.papers === 1 ? "" : "s"} you filed`]
  if (data.grounded_on.interests.length > 0) {
    bits.push(`${data.grounded_on.interests.length} domain${data.grounded_on.interests.length === 1 ? "" : "s"} you follow`)
  }
  if (data.grounded_on.college_areas.length > 0) {
    bits.push(`${data.grounded_on.college_areas.length} areas growing here`)
  }
  return `Based on ${bits.join(", ")}${data.model ? `, via ${data.model}` : ""}.`
}

/**
 * Why the suggestions cannot run, and what to do about it.
 *
 * Three different situations hide behind "switched off" — the service is not
 * answering, the model is not loaded, or the provider name is wrong — and
 * they have three different remedies. Saying only that it is off tells
 * somebody who could have fixed it in ten seconds to give up. The remedy
 * sentence comes from the backend, which knows which provider is configured;
 * the laptop commands here are the only case where a command is ours to add.
 */
function ModelOff({ ai }: { ai: AiState }) {
  const fix =
    ai.provider !== "ollama"
      ? null
      : ai.code === "model_missing"
        ? `ollama pull ${ai.model}`
        : ai.code === "service_down"
          ? "ollama serve"
          : null

  return (
    <Callout
      tone="caution"
      title={
        ai.code === "model_missing"
          ? "The suggestion model is not loaded"
          : ai.code === "service_down"
            ? "The model service is not answering"
            : "Suggestions are switched off"
      }
    >
      <p>{ai.detail || "No model is available, so this part cannot run."}</p>
      {fix && (
        <p className="mt-2">
          On the machine running this server:{" "}
          <code className="rounded bg-sunken px-1.5 py-0.5 text-sm">{fix}</code>
        </p>
      )}
      <p className="mt-2 text-sm text-fg-muted">
        Everything above still works — it is counted from our own records and never needed a
        model.
      </p>
    </Callout>
  )
}

/**
 * Seconds since a wait started, for a request that takes long enough that a
 * still spinner reads as a crash. Stops and resets when the wait ends, so an
 * interval never outlives the thing it was counting.
 */
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0)
  const started = useRef<number | null>(null)

  useEffect(() => {
    if (!running) {
      started.current = null
      setSeconds(0)
      return
    }
    started.current = Date.now()
    setSeconds(0)
    const id = window.setInterval(() => {
      if (started.current != null) {
        setSeconds(Math.round((Date.now() - started.current) / 1000))
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [running])

  return seconds
}
