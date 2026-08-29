import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Compass, LoaderCircle, Search, Sparkles, X } from "lucide-react"

import { ApiError, api } from "@/lib/api"
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
        <ModelUnavailable status={status.data} onRetry={() => void status.refetch()} />
      ) : status.data ? (
        <>
          <ModelBadge status={status.data} />
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

type DiscoverStatus = {
  available: boolean
  model: string
  /** "ollama" (a laptop) or "harness" (the college's own inference service). */
  provider?: string
  /** ready | service_down | model_missing | misconfigured */
  code?: string
  /** What to do about it, when it is not ready. */
  detail?: string | null
  base_url?: string
}

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

/** One line of the progress stream. See `/discover/venues/stream`. */
type StreamEvent =
  | {
      event: "start"
      token: string
      model: string
      expected_seconds: number
      expected_tokens: number
    }
  | { event: "step"; phase: string; elapsed: number; tokens?: number; chars?: number }
  | { event: "tick"; phase: string; elapsed: number }
  | { event: "result"; elapsed: number; data: VenuesResult }
  | { event: "error"; status: number; code: string; detail: string; elapsed: number }
  | { event: "cancelled"; elapsed: number }

/** Where the search has got to, as the server last reported it. */
type Wait = {
  phase: string
  elapsed: number
  tokens: number
  expectedSeconds: number
  expectedTokens: number
}

/** What each phase is, in a sentence somebody outside this file would write. */
const PHASE_SAYS: Record<string, string> = {
  connecting: "Starting the model and reading what you typed",
  generating: "Naming journals that publish this kind of work",
  reading: "Checking every name against our own journal data",
}

type RepriceResult = { journals: Omit<VerifiedJournal, "why">[]; assumed: Assumed }

/**
 * Read the venue search as it happens, rather than waiting for all of it.
 *
 * The model runs on this server's processor at a few tokens a second, so this
 * request takes about a minute and a half and no amount of front-end work
 * will change that. What it changes is whether the minute and a half is
 * legible: the server sends a line whenever it has something to say and once
 * a second regardless, so the screen can show a count that rises rather than
 * a spinner that cannot distinguish slow from dead.
 *
 * Not `useApiMutation`, because that resolves once with a whole body and has
 * nowhere to put the progress — and no way to abort. Aborting the signal ends
 * the reader's wait; what ends the model's work is the separate cancel
 * `stopSearch` sends, because dropping the connection was measured not to be
 * noticed on this server at all.
 */
async function streamVenues(
  body: VenueBody,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  // Fetched per search rather than cached: a search is ninety seconds and one
  // extra loopback request is nothing, whereas a token cached across a
  // sign-out is a 403 at the end of a long wait.
  const csrfRes = await fetch("/api/auth/csrf", { credentials: "same-origin", signal })
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }

  const res = await fetch("/api/discover/venues/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    // Everything the server can refuse, it refuses before the first byte, so
    // these still arrive as real statuses with a real body.
    if (res.status === 401) window.dispatchEvent(new CustomEvent("auth:expired"))
    const text = await res.text()
    let detail = `Request failed (${res.status})`
    try {
      const parsed = JSON.parse(text) as { detail?: unknown }
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail
    } catch {
      /* a body that is not JSON tells us nothing more than the status did */
    }
    throw new ApiError(res.status, detail)
  }

  if (!res.body) throw new ApiError(0, "This browser could not read the response.")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut = buffer.indexOf("\n")
      while (cut !== -1) {
        const line = buffer.slice(0, cut).trim()
        buffer = buffer.slice(cut + 1)
        if (line) onEvent(JSON.parse(line) as StreamEvent)
        cut = buffer.indexOf("\n")
      }
    }
  } catch (err) {
    // Leaving the body locked and half-read holds the connection open for a
    // response nobody is going to look at.
    void reader.cancel().catch(() => undefined)
    throw err
  }
}

/** Best paying first, then by quartile — the order the server sorts in. */
function byPayout(a: VerifiedJournal, b: VerifiedJournal): number {
  const left = a.payout.amount
  const right = b.payout.amount
  if ((left == null) !== (right == null)) return left == null ? 1 : -1
  if (left != null && right != null && left !== right) return right - left
  return (a.quartile ?? "Z").localeCompare(b.quartile ?? "Z")
}

/**
 * The venue search: a title (and, better, an abstract and keywords) in,
 * a split list of journals out.
 *
 * Two things here exist because the model runs on this server's processor
 * rather than in a data centre, and takes about a minute and a half.
 *
 * The search reads a progress stream instead of waiting for a whole body, and
 * can be stopped. Before that it showed a button reading "Searching…" and
 * nothing else for ninety seconds, which is indistinguishable from a hang —
 * so the feature worked and was reported as broken, and the only way out
 * anybody had was to reload, which left the model still generating.
 *
 * Changing the author position asks `/discover/reprice`, not the model. The
 * answer to "which journals suit this paper" cannot depend on where somebody
 * sits in the author list, so re-asking it was another ninety seconds for a
 * list that could not have changed. The figures themselves still come from
 * the server — a client-side reimplementation of the formula is exactly the
 * drift that turns an estimate into a wrong promise.
 */
function VenueFinder() {
  const [title, setTitle] = useState("")
  const [abstract, setAbstract] = useState("")
  const [keywords, setKeywords] = useState("")
  const [authorPositionText, setAuthorPositionText] = useState("1")
  const [totalAuthorsText, setTotalAuthorsText] = useState("1")
  const [titleError, setTitleError] = useState<string | null>(null)

  const [result, setResult] = useState<VenuesResult | null>(null)
  // The status, not just the sentence. Sniffing the message text with a
  // regex for "model|upstream|502" broke the moment the wording changed, and
  // it could never tell a 503 (nothing to talk to, fixable on the server)
  // from a 502 (the model answered badly, worth retrying).
  const [searchError, setSearchError] = useState<{ message: string; status: number } | null>(null)
  const [pending, setPending] = useState<"search" | "reposition" | null>(null)
  const [wait, setWait] = useState<Wait | null>(null)
  const [stoppedAfter, setStoppedAfter] = useState<number | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  const runToken = useRef<string | null>(null)
  // In a ref rather than read off `wait`, because the handler that needs it
  // is the one that runs after the search was abandoned, and by then the
  // state it closed over is a render old.
  const secondsSoFar = useRef(0)

  const authorPosition = toPositiveInt(authorPositionText)
  const totalAuthors = toPositiveInt(totalAuthorsText)

  /**
   * Stop the search, both ends.
   *
   * Two things, because dropping the connection is not enough on its own:
   * the server is not reliably told that a reader has gone, and a search that
   * carries on is ninety seconds of this machine's four cores spent on an
   * answer with nowhere to go — with the next person's search queued behind
   * it. So the run is named when it starts and stopped by name here.
   */
  function stopSearch() {
    const token = runToken.current
    if (token) {
      void api("/api/discover/venues/cancel", { method: "POST", json: { token } }).catch(
        () => {
          /* the search is being abandoned either way; it ends at the server's
             own timeout if this did not reach it */
        }
      )
    }
    inFlight.current?.abort()
  }

  // Leaving the page is giving up on it too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => stopSearch(), [])

  async function runSearch() {
    if (pending) return
    const trimmed = title.trim()
    if (trimmed.length < 8) {
      setTitleError("Give the title — at least 8 characters — so there is something to search from.")
      return
    }
    setTitleError(null)
    setSearchError(null)
    setStoppedAfter(null)
    setPending("search")
    secondsSoFar.current = 0
    setWait({ phase: "connecting", elapsed: 0, tokens: 0, expectedSeconds: 95, expectedTokens: 450 })

    const controller = new AbortController()
    inFlight.current = controller
    try {
      await streamVenues(
        {
          title: trimmed,
          abstract: abstract.trim() || undefined,
          keywords: keywords.trim() || undefined,
          author_position: authorPosition,
          total_authors: totalAuthors,
        },
        controller.signal,
        (event) => {
          if (event.event === "start") {
            runToken.current = event.token
            setWait((w) =>
              w ? { ...w, expectedSeconds: event.expected_seconds, expectedTokens: event.expected_tokens } : w
            )
          } else if (event.event === "step" || event.event === "tick") {
            const tokens = event.event === "step" ? event.tokens : undefined
            secondsSoFar.current = event.elapsed
            setWait((w) =>
              w
                ? { ...w, phase: event.phase, elapsed: event.elapsed, tokens: tokens ?? w.tokens }
                : w
            )
          } else if (event.event === "result") {
            setResult(event.data)
          } else if (event.event === "cancelled") {
            setStoppedAfter(event.elapsed)
          } else {
            // A failure after the first byte. It carries the status it would
            // have had, so the same panel reads both.
            throw new ApiError(event.status, event.detail)
          }
        }
      )
    } catch (err) {
      if (controller.signal.aborted) {
        // Not a failure. Nothing went wrong; somebody changed their mind.
        setStoppedAfter(secondsSoFar.current)
      } else {
        setSearchError({
          message: err instanceof Error ? err.message : "The search did not finish.",
          status: err instanceof ApiError ? err.status : 0,
        })
      }
    } finally {
      inFlight.current = null
      runToken.current = null
      setPending(null)
      setWait(null)
    }
  }

  /**
   * The same journals, priced for a different place in the author list.
   *
   * Every journal on screen or none of them. A list where the top three rows
   * are priced for author two and the rest for author one is not a slower
   * answer, it is a wrong one — so anything that cannot be re-priced by ISSN
   * sends the whole thing back to the model rather than being left behind.
   */
  async function repriceFor(shown: VenuesResult) {
    const codes = shown.journals.map((j) => j.issn ?? "")
    let merged: VerifiedJournal[] | null = null
    let assumed: Assumed | null = null

    if (!codes.some((c) => !c)) {
      setPending("reposition")
      setSearchError(null)
      try {
        const data = await api<RepriceResult>("/api/discover/reprice", {
          method: "POST",
          json: { issns: codes, author_position: authorPosition, total_authors: totalAuthors },
        })
        const byIssn = new Map(data.journals.map((j) => [j.issn ?? "", j]))
        const priced: VerifiedJournal[] = []
        for (const journal of shown.journals) {
          const row = byIssn.get(journal.issn ?? "")
          if (!row) break
          // `why` is the model's sentence about this paper; re-pricing is
          // arithmetic and never had it to give back.
          priced.push({ ...row, why: journal.why })
        }
        if (priced.length === shown.journals.length) {
          merged = priced
          assumed = data.assumed
        }
      } catch (err) {
        setSearchError({
          message: err instanceof Error ? err.message : "The amounts could not be worked out again.",
          status: err instanceof ApiError ? err.status : 0,
        })
        setPending(null)
        return
      }
      setPending(null)
    }

    if (merged && assumed) {
      merged.sort(byPayout)
      setResult({ ...shown, journals: merged, assumed })
    } else {
      void runSearch()
    }
  }

  // Whenever what is on screen was worked out for a different place in the
  // author list than the one now in the boxes, put that right. Written as the
  // disagreement rather than as "the number changed" so that it also catches
  // a search that started before the reader moved themselves down the list
  // and came back priced for where they used to be.
  useEffect(() => {
    if (pending || !result) return
    if (
      result.assumed.author_position === authorPosition &&
      result.assumed.total_authors === totalAuthors
    ) {
      return
    }
    const t = setTimeout(() => void repriceFor(result), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorPosition, totalAuthors, result, pending])

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    void runSearch()
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
          <Button type="submit" kind="primary" disabled={pending !== null}>
            {pending === "search" ? <LoaderCircle className="animate-spin" /> : <Search />}
            {pending === "search" ? "Searching…" : "Find venues"}
          </Button>
          {pending === "search" && (
            <Button type="button" onClick={stopSearch}>
              <X />
              Stop
            </Button>
          )}
        </div>
        {wait && <SearchProgress wait={wait} />}
        {stoppedAfter !== null && pending === null && (
          <Meta className="block">
            Stopped{stoppedAfter > 0 ? ` after ${Math.round(stoppedAfter)}s` : ""}. The model was
            told to stop too, so nothing is still running.
          </Meta>
        )}
      </form>

      {searchError && (
        <ErrorState
          title={
            searchError.status === 503
              ? "The model is not available"
              : searchError.status === 502
                ? "The model did not answer"
                : "Could not load this"
          }
          message={searchError.message}
          onRetry={() => void runSearch()}
        />
      )}

      {result && (
        <div className="space-y-6">
          <Callout tone="info" title="Every amount below is an estimate">
            Computed for a {result.assumed.publication_type.toLowerCase()}, as though you are
            author {result.assumed.author_position} of {result.assumed.total_authors} — change
            the position above and these figures are worked out again. That is arithmetic over
            journals we have already identified, so it answers at once: the model is not asked
            twice for a list that cannot have changed.
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

/**
 * What the wait is doing, while it does it.
 *
 * Three things, and each answers a question somebody asked out loud of the
 * spinner this replaced: a bar that moves (is it working?), the seconds so
 * far against the seconds expected (how much longer?), and the word count
 * rising (is it actually producing anything?). The bar is driven by tokens
 * once tokens exist, because that is real progress rather than a clock
 * animated to look like some.
 *
 * The one thing it must never do is claim to know the finish. It says "about"
 * and it stops short of the end, because a bar that sits full for twenty
 * seconds is the hang all over again with extra steps.
 */
function SearchProgress({ wait }: { wait: Wait }) {
  const fraction =
    wait.phase === "reading"
      ? 0.97
      : wait.tokens > 0
        ? Math.min(0.95, wait.tokens / Math.max(1, wait.expectedTokens))
        : Math.min(0.12, wait.elapsed / Math.max(1, wait.expectedSeconds))
  const percent = Math.round(fraction * 100)

  return (
    <div className="space-y-2">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Finding venues"
        className="h-1 w-full max-w-md overflow-hidden rounded-sm bg-sunken"
      >
        <div
          className="h-full bg-accent transition-[width] duration-[var(--dur-2)] ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Live, but only the sentence: the counter beside it changes twice a
          second and reading that aloud would be unusable. */}
      <p className="text-sm text-fg-muted" aria-live="polite">
        {PHASE_SAYS[wait.phase] ?? "Working"}
      </p>

      <Meta className="block tabular" aria-hidden>
        {Math.round(wait.elapsed)}s of about {wait.expectedSeconds}s
        {wait.tokens > 0 ? ` · ${wait.tokens} words written` : ""}
      </Meta>

      <Meta className="block">
        The model runs on this server's processor rather than in a data centre,
        so it is slower and nothing you typed leaves the building. Stopping is
        safe at any point.
      </Meta>
    </div>
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
          <Meta className="block">
            Thinking this through takes a minute or two — the model runs here
            rather than in a data centre.
          </Meta>
        </div>
      ) : q.isError ? (
        q.error.status === 503 ? (
          <Callout tone="caution" title="Suggestions are switched off">
            No model is configured, so this cannot run right now.
          </Callout>
        ) : (
          <ErrorState
            title={
              q.error.status === 503
                ? "The model is not available"
                : q.error.status === 502
                  ? "The model did not answer"
                  : "Could not load this"
            }
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


/**
 * Which model answered, said quietly.
 *
 * Worth one line because these suggestions are generated, not looked up, and
 * a reader deciding how much to trust a venue list should be able to see what
 * produced it. It also makes "it runs on this machine" visible, which is the
 * substantive change from the hosted API this replaced: a paper's unpublished
 * title and abstract no longer leave the building.
 */
function ModelBadge({ status }: { status: DiscoverStatus }) {
  if (!status.model) return null
  return (
    <Meta className="block">
      Suggestions come from {status.model}, running on this server. Nothing you
      type here is sent anywhere else.
    </Meta>
  )
}

/**
 * Why the suggestions cannot run, and what fixes it.
 *
 * Three different situations hide behind "switched off", and they have three
 * different one-command remedies — the service is not running, the model is
 * not installed, or the provider name is wrong. The old copy asserted the
 * third for all of them, so somebody who could have fixed it in ten seconds
 * was told the deployment had no model configured and stopped there.
 */
function ModelUnavailable({
  status,
  onRetry,
}: {
  status: DiscoverStatus
  onRetry: () => void
}) {
  // The laptop commands are only true of the laptop provider. In production
  // the harness answers, and the backend's detail sentence already names the
  // remedy for that arrangement — so this card says what it is told and adds
  // a command only where one exists to run.
  const fix =
    status.provider !== "ollama"
      ? null
      : status.code === "model_missing"
        ? `ollama pull ${status.model}`
        : status.code === "service_down"
          ? "ollama serve"
          : null

  return (
    <Callout
      tone="caution"
      title={
        status.code === "model_missing"
          ? "The suggestion model is not loaded"
          : status.code === "service_down"
            ? "The model service is not answering"
            : "Suggestions are switched off"
      }
    >
      <p>{status.detail || "No model is available, so suggestions cannot run."}</p>
      {fix ? (
        <p className="mt-2">
          On the machine running this server:{" "}
          <code className="rounded bg-sunken px-1.5 py-0.5 text-sm">{fix}</code>
        </p>
      ) : null}
      <p className="mt-2 text-sm text-fg-muted">
        The domains you work in, below, still work — they feed collaborator
        matching even without this.
      </p>
      <Button kind="quiet" size="sm" className="mt-3" onClick={onRetry}>
        Check again
      </Button>
    </Callout>
  )
}
