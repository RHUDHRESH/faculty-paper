import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Compass, LoaderCircle, Search, Sparkles, X } from "lucide-react"

import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Field, Input, NumberInput, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, InlineError, SkeletonRows, SkeletonText } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The one screen that is useful before a paper exists — everything else in
 * this app deals with work already done. Three things live here: where a
 * draft paper could go and what it would pay, what to write next, and the
 * research domains that feed both of those plus collaborator matching.
 *
 * Without the split this screen draws between a journal we resolved against
 * our own Scimago/SNIP rows and a name the model produced that we could not
 * identify, a plausible-sounding venue with a confident payout beside it is
 * how somebody submits a paper to a journal that does not exist and loses
 * months over it. That split is not a nicety here — it is the whole safety
 * argument of the feature.
 */
export function Discover() {
  const status = useApi<DiscoverStatus>(["discover", "status"], "/api/discover/status")

  return (
    <div className="page space-y-10">
      <header>
        <PageTitle>Discover</PageTitle>
        <Sub className="mt-1">Where this paper could go, and what to write after it.</Sub>
      </header>

      {status.isLoading ? (
        <SkeletonText lines={2} className="max-w-md" />
      ) : status.isError ? (
        <ErrorState
          title="Could not tell whether suggestions are switched on"
          message={status.error.message}
          onRetry={() => status.refetch()}
        />
      ) : status.data && !status.data.available ? (
        <Callout tone="caution" title="AI suggestions are switched off">
          No model is configured for this deployment, so venue and direction suggestions cannot
          run. The domains you work in, below, still work — they feed collaborator matching even
          without this.
        </Callout>
      ) : status.data ? (
        <>
          <VenueFinder />
          <Directions />
        </>
      ) : null}

      <Interests />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Types — mirrors API.md's "Discovery — the two AI features"               */
/* ------------------------------------------------------------------------ */

type DiscoverStatus = { available: boolean; model: string }

type Payout = {
  amount: number | null
  base?: number | null
  qf?: number | null
  author_point?: number | null
  category?: string | null
  note?: string | null
  why_not?: string | null
}

type VerifiedJournal = {
  title: string
  issn: string | null
  quartile: string | null
  subject: string | null
  sjr: number | null
  snip: number | null
  dataset_year: number | null
  why: string
  payout: Payout
}

type UnverifiedJournal = { title: string; why: string }

type Assumed = { author_position: number; total_authors: number; publication_type: string }

type VenuesResult = {
  journals: VerifiedJournal[]
  unverified: UnverifiedJournal[]
  assumed: Assumed
}

type VenueBody = {
  title: string
  abstract?: string
  keywords?: string
  author_position: number
  total_authors: number
}

type Direction = { topic: string; why: string; first_step: string }

type DirectionsResult = {
  directions: Direction[]
  grounded_on: { papers: number; interests: string[] }
  note?: string
}

/* ------------------------------------------------------------------------ */
/* Where could I publish this?                                              */
/* ------------------------------------------------------------------------ */

function toPositiveInt(text: string): number {
  const n = Math.floor(Number(text))
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/**
 * The venue search: a title (and, better, an abstract and keywords) in,
 * a split list of journals out.
 *
 * The position/total-authors fields double as the request's inputs and the
 * live control over them — changing either re-asks the server for a fresh
 * `payout` rather than recomputing the formula here, because the formula
 * lives on the server and a client-side reimplementation of it is exactly
 * the kind of drift that turns an estimate into a wrong promise.
 */
function VenueFinder() {
  const [title, setTitle] = useState("")
  const [abstract, setAbstract] = useState("")
  const [keywords, setKeywords] = useState("")
  const [authorPositionText, setAuthorPositionText] = useState("1")
  const [totalAuthorsText, setTotalAuthorsText] = useState("1")
  const [titleError, setTitleError] = useState<string | null>(null)

  const [result, setResult] = useState<VenuesResult | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [pending, setPending] = useState<"search" | "reposition" | null>(null)
  const hasSearched = useRef(false)

  const authorPosition = toPositiveInt(authorPositionText)
  const totalAuthors = toPositiveInt(totalAuthorsText)

  const mutation = useApiMutation<VenueBody, VenuesResult>("/api/discover/venues")

  function runSearch(kind: "search" | "reposition") {
    if (pending) return
    const trimmed = title.trim()
    if (trimmed.length < 8) {
      if (kind === "search") setTitleError("Give the title — at least 8 characters — so there is something to search from.")
      return
    }
    setTitleError(null)
    setSearchError(null)
    setPending(kind)
    mutation.mutate(
      {
        title: trimmed,
        abstract: abstract.trim() || undefined,
        keywords: keywords.trim() || undefined,
        author_position: authorPosition,
        total_authors: totalAuthors,
      },
      {
        onSuccess: (data) => {
          setResult(data)
          hasSearched.current = true
        },
        onError: (err) => setSearchError(err.message),
        onSettled: () => setPending(null),
      }
    )
  }

  // Position or total-authors changed after at least one search has already
  // run — re-ask for real payouts rather than leaving the reader looking at
  // figures computed for somebody else's author order.
  useEffect(() => {
    if (!hasSearched.current) return
    const t = setTimeout(() => runSearch("reposition"), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorPosition, totalAuthors])

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    runSearch("search")
  }

  return (
    <section className="space-y-4">
      <SectionTitle>Where could I publish this?</SectionTitle>

      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Paper title" error={titleError ?? undefined}>
          <Input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              if (titleError && e.target.value.trim().length >= 8) setTitleError(null)
            }}
            placeholder="The title of the paper you have not yet submitted anywhere"
          />
        </Field>

        <Field label="Abstract" hint="Optional, but a better match than the title alone.">
          <Textarea
            value={abstract}
            onChange={(e) => setAbstract(e.target.value)}
            placeholder="A few sentences on what the paper does"
            maxRows={5}
          />
        </Field>

        <Field label="Keywords" hint="Optional. Comma-separated.">
          <Input
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="e.g. composite materials, fatigue testing, finite element"
          />
        </Field>

        <div className="flex flex-wrap items-end gap-4">
          <div className="grid w-full max-w-xs grid-cols-2 gap-3">
            <Field label="Your position" hint="Among the authors.">
              <NumberInput
                min={1}
                value={authorPositionText}
                onChange={(e) => setAuthorPositionText(e.target.value)}
              />
            </Field>
            <Field label="Total authors">
              <NumberInput
                min={1}
                value={totalAuthorsText}
                onChange={(e) => setTotalAuthorsText(e.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" kind="primary" disabled={pending === "search"}>
            {pending === "search" ? <LoaderCircle className="animate-spin" /> : <Search />}
            {pending === "search" ? "Searching…" : "Find venues"}
          </Button>
        </div>
        {pending === "search" && (
          <Meta className="block">
            Naming real journals and checking each against our own data takes a few seconds.
          </Meta>
        )}
      </form>

      {searchError && (
        <ErrorState
          title={
            /model|upstream|502/i.test(searchError) ? "The model did not answer" : "Could not load this"
          }
          message={searchError}
          onRetry={() => runSearch(hasSearched.current ? "reposition" : "search")}
        />
      )}

      {result && (
        <div className="space-y-6">
          <Callout tone="info" title="Every amount below is an estimate">
            Computed for a {result.assumed.publication_type.toLowerCase()}, as though you are
            author {result.assumed.author_position} of {result.assumed.total_authors} — change
            the position above and these figures are asked for again.
            {pending === "reposition" && (
              <span className="mt-1 flex items-center gap-1.5 text-fg-muted">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                Updating for the new position…
              </span>
            )}
          </Callout>

          {result.journals.length === 0 && result.unverified.length === 0 ? (
            <EmptyState
              icon={Search}
              title="Nothing came back"
              message="The model did not name anything for this title. Adding an abstract or a few keywords usually helps."
            />
          ) : (
            <>
              {result.journals.length > 0 && (
                <ul className={pending === "reposition" ? "divide-y divide-line border-y border-line opacity-60 transition-opacity duration-[var(--dur-2)] ease-out" : "divide-y divide-line border-y border-line"}>
                  {result.journals.map((j) => (
                    <JournalCard key={j.title} journal={j} />
                  ))}
                </ul>
              )}

              {result.unverified.length > 0 && (
                <Callout tone="caution" title="Names we could not verify">
                  <p className="mb-2">
                    The model suggested these too, but we could not find them in our own journal
                    data — no quartile, no SNIP, no payout, because attaching a number to a
                    journal we cannot identify is how somebody ends up submitting to a venue that
                    does not exist.
                  </p>
                  <ul className="space-y-2.5">
                    {result.unverified.map((u) => (
                      <li key={u.title} className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                        <span>
                          <span className="block font-medium text-fg">{u.title}</span>
                          <span className="block text-fg-muted">{u.why}</span>
                          <span className="block text-xs">
                            Unconfirmed — not in our journal data.
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Callout>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

/** One verified journal: real quartile, real SNIP, real payout — or, when
 *  the payout cannot be worked out, the sentence saying why rather than a
 *  blank or a zero, because either of those reads as "nothing to pay". */
function JournalCard({ journal }: { journal: VerifiedJournal }) {
  const payout = journal.payout
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium text-fg">{journal.title}</p>
          <Meta className="mt-0.5 block">
            {[journal.quartile, journal.subject, journal.issn].filter(Boolean).join(" · ") || "—"}
          </Meta>
          {journal.why && <p className="mt-1.5 text-sm text-fg-muted">{journal.why}</p>}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-subtle">
            <span>SNIP {journal.snip != null ? journal.snip.toFixed(2) : "—"}</span>
            <span>SJR {journal.sjr != null ? journal.sjr.toFixed(3) : "—"}</span>
            {journal.dataset_year && <span>{journal.dataset_year} data</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {payout.amount != null ? (
            <>
              <span className="block text-lg font-semibold tabular">{money(payout.amount)}</span>
              <span className="block text-xs text-caution">Estimate</span>
              {payout.note && <span className="mt-0.5 block max-w-[14rem] text-xs text-fg-muted">{payout.note}</span>}
            </>
          ) : (
            <span className="block max-w-[14rem] text-xs text-fg-muted">
              {payout.why_not || "The amount could not be worked out."}
            </span>
          )}
        </div>
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* What could I work on next?                                               */
/* ------------------------------------------------------------------------ */

/**
 * Directions grounded on what has actually been filed and what domains are
 * followed. Shown alongside the suggestions themselves, always — a thin
 * answer is usually an empty history rather than a bad model, and a reader
 * cannot tell those two apart unless the screen says which one it is.
 */
function Directions() {
  const q = useApi<DirectionsResult>(["discover", "directions"], "/api/discover/directions")

  return (
    <section className="space-y-4">
      <SectionTitle>What could I work on next?</SectionTitle>

      {q.isLoading ? (
        <div className="space-y-3">
          <SkeletonText lines={1} className="max-w-sm" />
          <SkeletonRows rows={3} rowHeight={84} />
          <Meta className="block">Thinking this through can take a few seconds.</Meta>
        </div>
      ) : q.isError ? (
        q.error.status === 503 ? (
          <Callout tone="caution" title="Suggestions are switched off">
            No model is configured, so this cannot run right now.
          </Callout>
        ) : (
          <ErrorState
            title={q.error.status === 502 ? "The model did not answer" : "Could not load this"}
            message={q.error.message}
            onRetry={() => q.refetch()}
          />
        )
      ) : q.data ? (
        q.data.directions.length === 0 ? (
          <EmptyState
            icon={Compass}
            title="Nothing to go on yet"
            message={
              q.data.note ||
              "File a paper, or pick the domains you work in below, and this will have something to work from."
            }
          />
        ) : (
          <>
            <Meta className="block">{groundedOnLine(q.data.grounded_on)}</Meta>
            <ul className="divide-y divide-line border-y border-line">
              {q.data.directions.map((d, i) => (
                <li key={i} className="py-4">
                  <p className="text-base font-semibold text-fg">{d.topic}</p>
                  <p className="mt-1 text-sm text-fg-muted">{d.why}</p>
                  <p className="mt-2.5 flex flex-wrap items-start gap-x-2 gap-y-1 text-sm">
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent-wash px-1.5 py-0.5 text-xs font-medium text-accent">
                      <Sparkles className="size-3" aria-hidden />
                      First step
                    </span>
                    <span className="text-fg">{d.first_step}</span>
                  </p>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </section>
  )
}

function groundedOnLine(g: DirectionsResult["grounded_on"]): string {
  const papers = `${g.papers} paper${g.papers === 1 ? "" : "s"} you have filed`
  if (g.interests.length === 0) return `Based on ${papers}.`
  const domains = `${g.interests.length} domain${g.interests.length === 1 ? "" : "s"} you follow`
  return `Based on ${papers} and ${domains}.`
}

/* ------------------------------------------------------------------------ */
/* The domains you work in                                                  */
/* ------------------------------------------------------------------------ */

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

const MAX_INTERESTS = 20

/**
 * The domains that ground both features above, and collaborator matching
 * besides. Chosen from the server's own 302-category vocabulary rather than
 * typed, because a domain outside it can never be matched against anything
 * later — so this is a `Combobox` used purely to append, never a text box.
 */
function Interests() {
  const interests = useApi<{ domains: string[] }>(["me", "interests"], "/api/me/interests")
  const domains = useApi<{ domains: string[] }>(
    ["research-domains"],
    "/api/meta/research-domains?limit=302"
  )

  const [selected, setSelected] = useState<string[] | null>(null)
  useEffect(() => {
    if (interests.data && selected === null) setSelected(interests.data.domains)
  }, [interests.data, selected])

  const current = selected ?? []
  const dirty = interests.data ? !sameSet(current, interests.data.domains) : false

  const save = useApiMutation<{ domains: string[] }, { domains: string[] }>("/api/me/interests", {
    method: "PUT",
  })

  function persist() {
    save.mutate(
      { domains: current },
      {
        onSuccess: (data) => {
          setSelected(data.domains)
          toast.ok(`Saved — ${data.domains.length} domain${data.domains.length === 1 ? "" : "s"}`)
        },
        onError: (err) => toast.fail(err),
      }
    )
  }

  const options: ComboboxOption[] = (domains.data?.domains ?? [])
    .filter((d) => !current.includes(d))
    .map((d) => ({ value: d, label: d }))

  return (
    <section className="space-y-3 border-t border-line pt-8">
      <div>
        <SectionTitle>The domains you work in</SectionTitle>
        <Sub className="mt-1">
          Feeds the suggestions above and who you might collaborate with. Up to {MAX_INTERESTS}.
        </Sub>
      </div>

      {interests.isLoading ? (
        <SkeletonRows rows={2} rowHeight={32} />
      ) : interests.isError ? (
        <ErrorState message={interests.error.message} onRetry={() => interests.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {current.length === 0 && <Meta>No domains chosen yet.</Meta>}
            {current.map((d) => (
              <span
                key={d}
                className="inline-flex max-w-full items-center gap-1 rounded-sm bg-accent-wash py-1 pl-2.5 pr-1.5 text-sm text-accent"
              >
                <span className="truncate">{d}</span>
                <button
                  type="button"
                  onClick={() => setSelected(current.filter((x) => x !== d))}
                  aria-label={`Remove ${d}`}
                  className="shrink-0 rounded-sm p-0.5 hover:bg-accent-line"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </span>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Combobox
              value={null}
              onChange={(v) => setSelected([...current, v])}
              options={options}
              placeholder={
                domains.isLoading
                  ? "Loading…"
                  : current.length >= MAX_INTERESTS
                    ? "20 chosen — remove one to add another"
                    : "Add a domain…"
              }
              disabled={domains.isLoading || domains.isError || current.length >= MAX_INTERESTS}
              aria-label="Add a domain"
              className="max-w-xs"
            />
            <Button kind="primary" size="sm" onClick={persist} disabled={!dirty || save.isPending}>
              {save.isPending && <LoaderCircle className="animate-spin" />}
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>

          {domains.isError && (
            <InlineError
              message="Could not load the domain list."
              onRetry={() => domains.refetch()}
            />
          )}
        </>
      )}
    </section>
  )
}
