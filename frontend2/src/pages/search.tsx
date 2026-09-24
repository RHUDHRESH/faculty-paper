import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { AlertTriangle, ExternalLink, FileText, Search as SearchIcon } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { Stage, money, stageOf } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, SkeletonRows, SkeletonText } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * One box that searches everything this college can see: the literature
 * (Crossref, OpenAlex and Scopus, de-duplicated by DOI), the journals in our
 * own Scimago/SNIP tables, the people here, and the claims already filed.
 *
 * It is one screen rather than four because the question a person arrives
 * with is not "which index holds this" — it is "does this paper exist, is
 * that journal real, has anybody here already filed it". Four screens make
 * them ask it four times and compare the answers themselves, which is where
 * a duplicate claim comes from.
 *
 * Two rules are load-bearing and neither is cosmetic.
 *
 * The first is the split between a venue we resolved against our own journal
 * data and one we only have a name for. A resolved venue carries its
 * quartile and its metrics; an unresolved one carries no number of any kind,
 * enforced by its type having none to render. A plausible-sounding journal
 * shown beside a confident figure is how somebody submits to a venue that
 * does not exist and loses months over it.
 *
 * The second is that a source being down is its own answer. Three indexes
 * answering and one failing is not a short list — it is an incomplete one,
 * and presenting it as complete is how a paper gets filed twice because the
 * search that would have found the first claim quietly skipped it.
 */
export function Search() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const query = q.trim()
  const enabled = query.length >= MIN_QUERY

  const results = useApi<SearchResults>(
    ["search", query],
    `/api/search?q=${encodeURIComponent(query)}`,
    { enabled }
  )

  return (
    <div className="page space-y-8">
      <header>
        <PageTitle>Search</PageTitle>
        <Sub className="mt-1">
          Papers, journals, people here, and claims already filed — all at once.
        </Sub>
      </header>

      <SearchBox q={q} setSearchParams={setSearchParams} />

      {!enabled ? (
        <Prompt typed={q.length > 0} />
      ) : results.isLoading ? (
        <Loading />
      ) : results.isError ? (
        <ErrorState
          title="The search did not run"
          message={results.error.message}
          onRetry={() => void results.refetch()}
        />
      ) : results.data ? (
        <Results data={results.data} onRetry={() => void results.refetch()} />
      ) : null}
    </div>
  )
}

/** Below this a query matches most of the literature, so it is not a search
 *  and the server is not asked one. */
const MIN_QUERY = 2

/* ------------------------------------------------------------------------ */
/* Types — the client's view of GET /api/search?q=…                         */
/* ------------------------------------------------------------------------ */

/**
 * Whether one index or table answered this search.
 *
 * Every source reports itself whether or not it worked, so the screen can
 * tell "Scopus found nothing" from "Scopus was not asked" from "Scopus
 * refused". Those are three different sentences and only the first of them
 * means the paper is not there.
 */
type SourceReport = {
  /** `crossref` | `openalex` | `scopus` | `journals` | `college` */
  id: string
  /** What to call it in front of a reader. */
  label: string
  ok: boolean
  /** How many results it contributed, when it answered. */
  count?: number | null
  /** Why it did not, when it did not. */
  detail?: string | null
  /** `rate_limit` | `unauthorized` | `timeout` | `error` | `not_configured` */
  code?: string | null
}

/**
 * One article, as the indexes describe it — not a claim, not our record.
 *
 * `found_in` is the de-duplication made visible: the server merges by DOI, so
 * a paper all three indexes hold appears once and says so. A reader deciding
 * whether a record is trustworthy is better served by "Crossref, OpenAlex and
 * Scopus" than by the same row three times.
 */
type FoundPaper = {
  doi: string | null
  title: string
  authors: string[]
  year: number | null
  journal_title: string | null
  issn: string | null
  publication_type: string | null
  cited_by: number | null
  /** Where to read it. `https://doi.org/…` unless the index gave a better one. */
  url: string | null
  /** Source ids that returned this same record. */
  found_in: string[]
  /** The claim already filed here for this DOI, if there is one. */
  claim: { id: string; status: string; mine: boolean } | null
}

/**
 * A journal we found in our own Scimago/SNIP tables. Only these carry
 * numbers, and that is the point of the type existing separately.
 */
type ResolvedVenue = {
  title: string
  issn: string | null
  /** Q1..Q4, or null when our row records none. Absent is not the same as
   *  unresolved — we know this journal exists, we just have no quartile. */
  quartile: string | null
  subject: string | null
  sjr: number | null
  snip: number | null
  dataset_year: number | null
  publisher: string | null
}

/**
 * A venue name we could not resolve against our own data.
 *
 * It has no numeric field at all, deliberately. The rule "never show a metric
 * beside a journal we cannot identify" is not left to whoever writes the
 * markup — there is nothing here to show.
 */
type UnresolvedVenue = {
  title: string
  publisher: string | null
  issn: string | null
}

/** Somebody here, and how much of their work this system holds. */
type FoundPerson = {
  id: string
  name: string
  department: string | null
  designation: string | null
  /** Claims filed by this person. Never an amount — see the note in `Money`. */
  papers: number
}

/** A claim already filed in this college. */
type FoundTicket = {
  id: string
  paper_title: string | null
  doi: string | null
  journal_title: string | null
  /** A `Claim.status` value; rendered through `stageOf`. */
  status: string
  publication_year: number | null
  department: string | null
  claimant: { id: string; name: string } | null
  /** Omitted entirely by the server for a head of department, and guarded
   *  again here. Two locks, because either one alone has been the one that
   *  quietly stopped working. */
  amount?: number | null
}

type SearchResults = {
  query: string
  sources: SourceReport[]
  papers: FoundPaper[]
  venues: { resolved: ResolvedVenue[]; unresolved: UnresolvedVenue[] }
  people: FoundPerson[]
  tickets: FoundTicket[]
}

function countOf(data: SearchResults): number {
  return (
    data.papers.length +
    data.venues.resolved.length +
    data.venues.unresolved.length +
    data.people.length +
    data.tickets.length
  )
}

/* ------------------------------------------------------------------------ */
/* The box                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The query, and the URL, kept as the same thing.
 *
 * A search that lives only in component state cannot be sent to a colleague
 * and cannot be returned to with Back — and on this screen the whole point is
 * that somebody found a paper and wants to show it to the person who has to
 * decide about it. So `?q=` is the state, and the box is a draft of it.
 *
 * The URL is replaced rather than pushed while typing: a history entry per
 * keystroke turns Back into forty presses to leave one page. Arriving at the
 * screen and leaving it are the navigations worth recording, and both still
 * are.
 */
function SearchBox({
  q,
  setSearchParams,
}: {
  q: string
  setSearchParams: ReturnType<typeof useSearchParams>[1]
}) {
  const [draft, setDraft] = useState(q)

  // The URL is the source of truth, so a Back press or a shared link that
  // changes it puts the box right rather than the box overwriting it.
  useEffect(() => setDraft(q), [q])

  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => commit(draft), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, q])

  function commit(value: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value.trim()) next.set("q", value)
        else next.delete("q")
        return next
      },
      { replace: true }
    )
  }

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        commit(draft)
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <div className="relative min-w-0 flex-1 basis-64">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden
        />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          size="lg"
          className="pl-9"
          type="search"
          autoComplete="off"
          // A placeholder is not a name: it disappears the moment somebody
          // types, and a screen reader announcing "edit text" with no label
          // leaves them guessing what this box searches.
          aria-label="Search papers, journals, people and claims"
          placeholder="A title, a DOI, a journal, or somebody's name"
        />
      </div>
      <Button type="submit" kind="primary" size="lg">
        Search
      </Button>
    </form>
  )
}

/* ------------------------------------------------------------------------ */
/* The four states before results                                           */
/* ------------------------------------------------------------------------ */

/**
 * Nothing has been searched for yet.
 *
 * Not an empty state and not an error: nobody has asked anything, so nothing
 * is missing. Rendering "no results" here would tell a reader their first
 * two characters matched nothing in the literature, which is a lie with
 * consequences on a screen people use to check whether a paper exists.
 */
function Prompt({ typed }: { typed: boolean }) {
  return (
    <div className="well rounded-lg px-6 py-10 text-center">
      <p className="text-base font-medium text-fg">
        {typed ? `Keep typing — at least ${MIN_QUERY} characters.` : "Search for anything"}
      </p>
      <p className="mx-auto mt-1 max-w-md text-pretty text-base text-fg-muted">
        A paper title or DOI looks it up in Crossref, OpenAlex and Scopus. A
        journal name is checked against our own Scimago and SNIP data. A
        person&rsquo;s name finds them and the claims they have filed.
      </p>
    </div>
  )
}

function Loading() {
  return (
    <div className="space-y-6">
      <SkeletonText lines={1} className="max-w-xs" />
      <SkeletonRows rows={4} rowHeight={76} />
      <SkeletonRows rows={2} rowHeight={76} />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Results                                                                  */
/* ------------------------------------------------------------------------ */

function Results({ data, onRetry }: { data: SearchResults; onRetry: () => void }) {
  const { me } = useAuth()
  const seeMoney = can(me?.role).seeMoney

  const down = useMemo(() => data.sources.filter((s) => !s.ok), [data.sources])
  const answered = useMemo(() => data.sources.filter((s) => s.ok), [data.sources])
  const total = countOf(data)

  // Every source refused. The request itself succeeded, so this never reached
  // the page's error branch — but there is no result set here, only a failure
  // wearing one, and it has to read as one.
  if (down.length > 0 && answered.length === 0) {
    return (
      <ErrorState
        title="Nothing could be searched"
        message={`None of the ${down.length} sources answered. ${down
          .map((s) => `${s.label}: ${s.detail || "did not answer"}`)
          .join(" · ")}`}
        onRetry={onRetry}
      />
    )
  }

  return (
    <div className="space-y-10">
      {down.length > 0 && <Partial down={down} answered={answered} onRetry={onRetry} />}

      <p className="text-sm text-fg-muted" aria-live="polite">
        {total === 0
          ? `Nothing matched “${data.query}”.`
          : `${total} result${total === 1 ? "" : "s"} for “${data.query}”.`}
      </p>

      {total === 0 ? (
        <EmptyState
          art="no-results"
          title="Nothing matched that"
          message={
            down.length > 0
              ? "Nothing came back from the sources that did answer. The ones listed above were not searched, so this is not the whole picture — try again in a moment."
              : "A DOI is the surest way in. Otherwise try fewer words of the title, or the journal name on its own."
          }
        />
      ) : (
        <>
          <Papers papers={data.papers} />
          <Venues venues={data.venues} />
          <People people={data.people} />
          <Tickets tickets={data.tickets} seeMoney={seeMoney} />
        </>
      )}
    </div>
  )
}

/**
 * One or more sources are down and the rest answered.
 *
 * Its own state, above the results rather than beside them, because the
 * damage a partial search does is silent: a shorter list is indistinguishable
 * from a complete one, and the person reading it concludes the paper is not
 * indexed or that nobody has claimed it. Naming the source and what it said
 * also tells whoever can fix it which one to look at.
 */
function Partial({
  down,
  answered,
  onRetry,
}: {
  down: SourceReport[]
  answered: SourceReport[]
  onRetry: () => void
}) {
  return (
    <Callout tone="caution" title="This is not the whole search">
      <p className="mb-2">
        {answered.length} of {answered.length + down.length} sources answered. What is below is
        everything they had, and nothing from the rest — so treat &ldquo;not found&rdquo; as
        &ldquo;not found yet&rdquo;.
      </p>
      <ul className="space-y-1.5">
        {down.map((s) => (
          <li key={s.id} className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <span className="font-medium text-fg">{s.label}</span>
              <span className="text-fg-muted"> — {s.detail || "did not answer"}</span>
            </span>
          </li>
        ))}
      </ul>
      <Button kind="quiet" size="sm" className="mt-3" onClick={onRetry}>
        Search again
      </Button>
    </Callout>
  )
}

/** A group of results, or nothing at all. An empty group is not drawn: four
 *  headings over three empty lists is how a screen with results in it reads
 *  as a screen with none. */
function Group({
  title,
  count,
  note,
  children,
}: {
  title: string
  count: number
  note?: React.ReactNode
  children: React.ReactNode
}) {
  if (count === 0) return null
  // `aria-label` rather than `aria-labelledby`: `SectionTitle` renders only
  // its children and class, so an id handed to it never reaches the DOM and
  // the region would end up with a name pointing at nothing.
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <SectionTitle>{title}</SectionTitle>
        <Meta className="tabular">
          {count} result{count === 1 ? "" : "s"}
        </Meta>
      </div>
      {note}
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Papers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Everything this paper is known by, packed into the address of the filing
 * form.
 *
 * The claim is filed on `/papers/new`, which was rebuilt as a
 * one-question-per-screen walk behind three confirmations and has its own
 * Scopus lookup. None of that is worth reproducing here, and a second filing
 * path is a second place for the eligibility gate to be got wrong — so this
 * hands over what it knows and stops.
 */
function fileLink(p: FoundPaper): string {
  const params = new URLSearchParams()
  if (p.doi) params.set("doi", p.doi)
  if (p.title) params.set("title", p.title)
  if (p.journal_title) params.set("journal", p.journal_title)
  if (p.issn) params.set("issn", p.issn)
  if (p.year != null) params.set("year", String(p.year))
  return `/papers/new?${params.toString()}`
}

function authorLine(authors: string[]): string {
  if (authors.length === 0) return "Authors not recorded"
  if (authors.length <= 3) return authors.join(", ")
  return `${authors.slice(0, 3).join(", ")} and ${authors.length - 3} more`
}

function Papers({ papers }: { papers: FoundPaper[] }) {
  return (
    <Group title="Papers" count={papers.length}>
      <ul className="divide-y divide-line border-y border-line">
        {papers.map((p) => (
          <li key={p.doi ?? p.title} className="py-4">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div className="min-w-0 flex-1 basis-64">
                <p className="text-base font-medium text-fg">
                  {p.url ? (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-start gap-1.5 hover:underline"
                    >
                      <span>{p.title}</span>
                      <ExternalLink className="mt-1 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                    </a>
                  ) : (
                    p.title
                  )}
                </p>
                <Meta className="mt-0.5 block">{authorLine(p.authors)}</Meta>
                <Meta className="mt-0.5 block">
                  {[p.journal_title, p.year, p.publication_type, p.doi]
                    .filter(Boolean)
                    .join(" · ")}
                </Meta>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-subtle">
                  {/* Which indexes hold it. Two agreeing is a stronger record
                      than one, and a reader checking a suspect DOI is exactly
                      who needs to know that. */}
                  <span>
                    Found in{" "}
                    {p.found_in.length > 0 ? p.found_in.join(", ") : "one index"}
                  </span>
                  {p.cited_by != null && <span className="tabular">Cited by {p.cited_by}</span>}
                </div>
              </div>

              <div className="shrink-0">
                {p.claim ? (
                  <Link to={`/papers/${p.claim.id}`} className="block text-right">
                    <span className="block text-sm font-medium text-fg underline-offset-2 hover:underline">
                      Already filed here
                    </span>
                    <Meta className="mt-0.5 block text-xs">
                      {p.claim.mine ? "By you" : "By somebody here"} ·{" "}
                      {stageOf(p.claim.status).label}
                    </Meta>
                  </Link>
                ) : (
                  <Button asChild size="sm">
                    <Link to={fileLink(p)}>
                      <FileText />
                      File a claim
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Group>
  )
}

/* ------------------------------------------------------------------------ */
/* Venues                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Journals, in two lists that must never become one.
 *
 * The top list is journals resolved against our own Scimago and SNIP rows:
 * these carry a quartile and real metrics because we can say which record
 * they are. The bottom list is names we have and cannot place, and it carries
 * no figure of any kind — the type it renders has none.
 *
 * Merging them, or "helpfully" showing an estimated quartile for the second
 * list, is the failure this whole screen is arranged to prevent: a plausible
 * journal beside a confident number is how somebody submits to a venue that
 * does not exist.
 */
function Venues({ venues }: { venues: { resolved: ResolvedVenue[]; unresolved: UnresolvedVenue[] } }) {
  const count = venues.resolved.length + venues.unresolved.length

  return (
    <Group title="Journals" count={count}>
      {venues.resolved.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {venues.resolved.map((v) => (
            <li key={v.issn ?? v.title} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-base font-medium text-fg">
                    <Link
                      to={`/journals/${encodeURIComponent(v.title)}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {v.title}
                    </Link>
                  </p>
                  <Meta className="mt-0.5 block">
                    {[v.publisher, v.subject, v.issn].filter(Boolean).join(" · ") || "—"}
                  </Meta>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-subtle">
                    <span className="tabular">SNIP {v.snip != null ? v.snip.toFixed(2) : "—"}</span>
                    <span className="tabular">SJR {v.sjr != null ? v.sjr.toFixed(3) : "—"}</span>
                    {v.dataset_year != null && <span>{v.dataset_year} data</span>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <ColumnLabel className="block">Quartile</ColumnLabel>
                  <span className="tabular text-base font-medium text-fg">
                    {v.quartile ?? "Not recorded"}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {venues.unresolved.length > 0 && (
        <Callout tone="caution" title="Names we could not verify">
          <p className="mb-2">
            These came back as journal names but are not in our own Scimago or SNIP data — so no
            quartile, no SNIP, no payout. Attaching a number to a journal we cannot identify is
            how somebody ends up submitting to a venue that does not exist.
          </p>
          <ul className="space-y-2.5">
            {venues.unresolved.map((v) => (
              <li key={v.issn ?? v.title} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0">
                  <span className="block font-medium text-fg">{v.title}</span>
                  {(v.publisher || v.issn) && (
                    <span className="block text-fg-muted">
                      {[v.publisher, v.issn].filter(Boolean).join(" · ")}
                    </span>
                  )}
                  <span className="block text-xs">Unconfirmed — not in our journal data.</span>
                </span>
              </li>
            ))}
          </ul>
        </Callout>
      )}
    </Group>
  )
}

/* ------------------------------------------------------------------------ */
/* People                                                                   */
/* ------------------------------------------------------------------------ */

function People({ people }: { people: FoundPerson[] }) {
  return (
    <Group title="People here" count={people.length}>
      <ul className="divide-y divide-line border-y border-line">
        {people.map((p) => (
          <li key={p.id} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-base font-medium text-fg">
                  <Link to={`/u/${p.id}`} className="underline-offset-2 hover:underline">
                    {p.name}
                  </Link>
                </p>
                <Meta className="mt-0.5 block">
                  {[p.designation, p.department].filter(Boolean).join(" · ") ||
                    "Department not recorded"}
                </Meta>
              </div>
              <Meta className="shrink-0 tabular">
                {p.papers} paper{p.papers === 1 ? "" : "s"} filed
              </Meta>
            </div>
          </li>
        ))}
      </ul>
    </Group>
  )
}

/* ------------------------------------------------------------------------ */
/* Our own claims                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Claims already filed here.
 *
 * The amount is the one thing on this screen a head of department must never
 * see. The server leaves the key off for them; this checks `can().seeMoney`
 * as well, because a defence that exists only on one side stops working
 * silently the first time somebody changes the other.
 */
function Tickets({ tickets, seeMoney }: { tickets: FoundTicket[]; seeMoney: boolean }) {
  return (
    <Group
      title="Claims filed here"
      count={tickets.length}
      note={
        <Meta className="block">
          Papers this college has already filed against. Check here before filing — a second claim
          for the same paper is refused at clearing, after the work of filing it.
        </Meta>
      }
    >
      <ul className="divide-y divide-line border-y border-line">
        {tickets.map((t) => {
          const stage = stageOf(t.status)
          return (
            <li key={t.id} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-base font-medium text-fg">
                    <Link to={`/papers/${t.id}`} className="underline-offset-2 hover:underline">
                      {t.paper_title || "Untitled claim"}
                    </Link>
                  </p>
                  <Meta className="mt-0.5 block">
                    {[t.claimant?.name, t.department, t.journal_title, t.publication_year]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </Meta>
                  {t.doi && <Meta className="mt-0.5 block text-xs">{t.doi}</Meta>}
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <Stage stage={stage} />
                  {seeMoney && t.amount != null && (
                    <span className="tabular text-base font-medium text-fg">
                      {money(t.amount)}
                    </span>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </Group>
  )
}
