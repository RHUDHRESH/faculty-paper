import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight, Copy, MessageSquare, RefreshCw, Sparkles, ThumbsDown, ThumbsUp, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Checkbox, Field, Input, Select, Textarea } from "@/ui/field"
import { Avatar, initialsOf } from "@/ui/person"
import { Picture } from "@/ui/picture"
import { Callout, EmptyState, InlineError, Skeleton, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { ChoiceChips } from "@/pages/record-bits"

/**
 * The research helper (docs/ux/20-ai.md, "Where to publish next" and "Intro
 * message drafts"): a faculty member pastes an abstract or an idea, or picks
 * one of their own papers, and gets journals that fit, colleagues who work on
 * the same topic, and related papers, all read from the college's record.
 *
 * What is on screen is counted by the server first. The model, when there is
 * one, only chooses among those rows, puts them in order and says why in a
 * sentence; it cannot add a journal or a person (the server drops anything it
 * invents). So with AI off the same lists are here, in the counted order, and
 * the page is whole.
 *
 * Every sentence a model wrote carries the AI mark, the panel says which
 * model and where it runs, and every part has thumbs. A message draft is only
 * text in a box: "Use this" opens Messages with it in the composer, and the
 * person presses send. Nothing here sends anything, and nothing here shows
 * money or anything about a claim.
 */

/* ------------------------------------------------------------------------ */
/* Types — frontend2/API.md "Research helper"                                */
/* ------------------------------------------------------------------------ */

export type AiBlock = {
  /** off | ready (can be asked) | used (answered) | failed | limit */
  state: "off" | "ready" | "used" | "failed" | "limit"
  label: string
  model: string
  host: string
  hosted: boolean
  detail: string | null
  cached: boolean
  per_day: number
  left: number
}

export type VenueHistory = {
  papers: number
  on_topic: number
  first_year: number | null
  last_year: number | null
  citations: number
  colleagues: number
  quartiles: Record<string, number>
}

export type Caution = { kind: "watch" | "removed" | "unlisted"; level: "warning" | "check"; text: string }

export type HelperVenue = {
  id: string
  title: string
  issn: string | null
  quartile: string | null
  subject: string | null
  sjr: number | null
  snip: number | null
  dataset_year: number | null
  indexed: boolean
  source: "history" | "title" | "subject"
  history: VenueHistory | null
  caution: Caution | null
  why: string
  picked: boolean
  ai_why: string | null
  fit: "strong" | "good" | "possible" | null
}

export type HelperColleague = {
  id: string
  user_id: string
  name: string
  department: string | null
  designation: string | null
  photo_url?: string | null
  initials?: string
  papers_on_topic: number
  papers_together: number
  shared_coauthors: { user_id: string | null; name: string }[]
  shared_count: number
  papers: { id: string; title: string; year: number | null; venue: string | null; doi: string | null }[]
  why: string
  picked: boolean
  ai_why: string | null
}

export type HelperPaper = {
  id: string
  title: string
  year: number | null
  venue: string | null
  quartile: string | null
  doi: string | null
  mine: boolean
  authors: { user_id: string; name: string }[]
  authors_more: number
  matched: string[]
}

export type HelperResult = {
  input: { hash: string; title: string; chars: number; terms: string[]; paper_id: string | null; matched_papers: number }
  venues: HelperVenue[]
  colleagues: HelperColleague[]
  papers: HelperPaper[]
  ai: AiBlock
  summary: string | null
}

export type HelperSetup = { ai: AiBlock; papers: { id: string; title: string; year: number | null }[] }

type Body = { title?: string; text?: string; paper_id?: string; ai?: boolean; refresh?: boolean }
type DraftResult = { to: { user_id: string; name: string }; message: string; template: boolean; ai: AiBlock }

const MAX_TEXT = 4000
const MIN_CHARS = 20

/* ------------------------------------------------------------------------ */
/* The panel                                                                 */
/* ------------------------------------------------------------------------ */

export function ResearchHelper() {
  const setup = useApi<HelperSetup>(["research-helper", "setup"], "/api/research-helper", { retry: false })
  const papers = setup.data?.papers ?? []
  const ai = setup.data?.ai

  const [mode, setMode] = useState<"text" | "paper">("text")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [paperId, setPaperId] = useState("")
  const [useAi, setUseAi] = useState(true)
  const [result, setResult] = useState<HelperResult | null>(null)
  const [asked, setAsked] = useState<Body | null>(null)
  const [aiProblem, setAiProblem] = useState<string | null>(null)

  const lists = useApiMutation<Body, HelperResult>("/api/research-helper")
  const rank = useApiMutation<Body, HelperResult>("/api/research-helper", { invalidates: [["research-helper", "setup"]] })

  const body: Body =
    mode === "paper"
      ? { paper_id: paperId || undefined, text: text.trim() || undefined }
      : { title: title.trim() || undefined, text: text.trim() }
  const enough = mode === "paper" ? !!paperId : (title.trim() + text.trim()).length >= MIN_CHARS
  const canAi = ai?.state === "ready"

  if (setup.isError && setup.error.status === 403)
    return (
      <EmptyState
        illustration="empty-no-results"
        title="The research helper is for people who file their own research"
        message="Your role does not publish through the college, so there is nothing here for you."
      />
    )

  function askAi(from: Body, refresh = false) {
    setAiProblem(null)
    rank.mutate(
      { ...from, ai: true, refresh },
      {
        onSuccess: (r) => {
          setResult(r)
          if (r.ai.state === "failed" || r.ai.state === "limit") setAiProblem(r.ai.detail)
        },
        onError: () => setAiProblem("The AI did not answer this time. The lists below are counted from the college's record."),
      }
    )
  }

  function find() {
    const from = { ...body }
    setAsked(from)
    setAiProblem(null)
    lists.mutate(
      { ...from, ai: false },
      {
        onSuccess: (r) => {
          setResult(r)
          if (useAi && r.ai.state === "ready" && (r.venues.length || r.colleagues.length)) askAi(from)
        },
      }
    )
  }

  return (
    <div className="space-y-10" data-testid="research-helper">
      <form
        className="well space-y-4 p-4 sm:p-5"
        aria-label="Research helper"
        onSubmit={(e) => {
          e.preventDefault()
          if (enough && !lists.isPending && !rank.isPending) find()
        }}
      >
        {papers.length > 0 && (
          <ChoiceChips
            label="What to look up"
            value={mode}
            onChange={setMode}
            options={[
              { id: "text", label: "An abstract or idea" },
              { id: "paper", label: "One of my papers" },
            ]}
          />
        )}
        {mode === "paper" ? (
          <>
            <Field label="Your paper" hint="We look for journals and colleagues near this paper's topics.">
              <Select value={paperId} onChange={(e) => setPaperId(e.target.value)}>
                <option value="">Choose a paper</option>
                {papers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.year ? `${p.year}, ` : ""}
                    {p.title.length > 90 ? `${p.title.slice(0, 90)}…` : p.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Anything to add (optional)" hint="A sentence on the new angle you want to take.">
              <Textarea rows={2} maxRows={6} maxLength={MAX_TEXT} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Title (optional)">
              <Input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="A working title" />
            </Field>
            <Field
              label="Abstract or idea"
              hint={`${text.length.toLocaleString("en-IN")} of ${MAX_TEXT.toLocaleString("en-IN")} characters. A few sentences is enough.`}
            >
              <Textarea
                rows={5}
                maxRows={12}
                maxLength={MAX_TEXT}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste your abstract, or describe the paper you have in mind"
              />
            </Field>
          </>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button kind="primary" type="submit" disabled={!enough} loading={lists.isPending}>
            <Sparkles aria-hidden />
            Find journals and colleagues
          </Button>
          {canAi && (
            <Checkbox
              checked={useAi}
              onCheckedChange={(v) => setUseAi(v === true)}
              label="Let AI rank and explain"
            />
          )}
        </div>
        <AiNote ai={ai} useAi={useAi && canAi} />
      </form>

      {lists.isError ? (
        <InlineError message={lists.error.message} onRetry={() => find()} />
      ) : lists.isPending ? (
        <div className="space-y-3" aria-live="polite">
          <Meta>Reading the college's record…</Meta>
          <SkeletonRows rows={4} rowHeight={72} />
        </div>
      ) : result && asked ? (
        <Results
          result={result}
          asked={asked}
          thinking={rank.isPending}
          aiProblem={aiProblem}
          onTryAgain={() => askAi(asked, true)}
        />
      ) : (
        <FirstUse />
      )}
    </div>
  )
}

function FirstUse() {
  return (
    <div className="flex items-center gap-5">
      <Picture name="collaboration" className="hidden size-28 shrink-0 sm:block" />
      <div className="max-w-xl space-y-1.5 text-sm text-fg-muted">
        <p className="text-base font-medium text-fg">What you get</p>
        <p>
          Journals that fit, with their quartile and SNIP and what the college has published in them, and a warning
          for any journal to be careful with. Colleagues who work on the same topic, and the papers they have written.
          A short message you can send them yourself.
        </p>
        <p>Everything shown is from the college's own record.</p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* What the AI is, and where it runs                                         */
/* ------------------------------------------------------------------------ */

function AiNote({ ai, useAi }: { ai: AiBlock | undefined; useAi: boolean }) {
  if (!ai) return null
  if (ai.state === "off")
    return <Meta className="block">{ai.detail ?? "AI is off for this college. The lists are counted from the college's record."}</Meta>
  const where = ai.hosted
    ? `${ai.model} at ${ai.host}. What you paste is sent there to be answered.`
    : `${ai.model}, running on this server. Nothing you paste is sent anywhere else.`
  return (
    <Meta className="block">
      {useAi ? `AI suggestion from ${where}` : "AI is switched off for this search. The lists are still counted from the college's record."}{" "}
      {ai.left} of {ai.per_day} AI suggestions left today.
    </Meta>
  )
}

/** The mark on anything a model wrote. */
function AiMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium text-accent", className)}>
      <Sparkles aria-hidden className="size-3.5" strokeWidth={1.75} />
      AI suggestion
    </span>
  )
}

function Thumbs({ part, hash }: { part: "venues" | "people" | "draft"; hash: string }) {
  const [sent, setSent] = useState<"up" | "down" | null>(null)
  const send = useApiMutation<{ part: string; value: string; input_hash: string }>("/api/research-helper/feedback")
  if (sent)
    return (
      <span role="status" className="text-sm text-fg-muted">
        Thanks, noted.
      </span>
    )
  const give = (value: "up" | "down") =>
    send.mutate(
      { part, value, input_hash: hash },
      { onSuccess: () => setSent(value), onError: (e) => toast.fail(e) }
    )
  return (
    <span className="inline-flex items-center gap-1" role="group" aria-label="Was this useful?">
      <Button kind="quiet" size="sm" onClick={() => give("up")} disabled={send.isPending} aria-label="This helps">
        <ThumbsUp aria-hidden />
      </Button>
      <Button kind="quiet" size="sm" onClick={() => give("down")} disabled={send.isPending} aria-label="This does not help">
        <ThumbsDown aria-hidden />
      </Button>
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* Results                                                                   */
/* ------------------------------------------------------------------------ */

function Results({
  result,
  asked,
  thinking,
  aiProblem,
  onTryAgain,
}: {
  result: HelperResult
  asked: Body
  thinking: boolean
  aiProblem: string | null
  onTryAgain: () => void
}) {
  const { venues, colleagues, papers, ai } = result
  const nothing = venues.length === 0 && colleagues.length === 0 && papers.length === 0
  if (nothing)
    return (
      <EmptyState
        illustration="empty-no-results"
        title="Nothing at the college matches this yet"
        message="Try the main method and the field in your own words, or add a sentence of the abstract. Nothing was changed."
      />
    )
  const year = venues.find((v) => v.dataset_year)?.dataset_year
  return (
    <div className="space-y-10">
      <div className="space-y-2" aria-live="polite">
        {result.input.terms.length > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
            <span>What we read in it</span>
            {result.input.terms.slice(0, 8).map((t) => (
              <Chip key={t} tone="area">
                {t}
              </Chip>
            ))}
          </p>
        )}
        {thinking && (
          <p className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
            <Sparkles aria-hidden className="size-4 animate-pulse text-accent" strokeWidth={1.75} />
            The AI is reading these and picking the best fits. The lists are already here.
          </p>
        )}
        {ai.state === "used" && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <AiMark />
            <Meta>
              {ai.model}
              {ai.hosted ? ` at ${ai.host}` : ", on this server"}
              {ai.cached ? ", from an earlier answer to the same text" : ""}
            </Meta>
            <Button kind="quiet" size="sm" onClick={onTryAgain} disabled={thinking}>
              <RefreshCw aria-hidden />
              Try again
            </Button>
          </div>
        )}
        {ai.state === "used" && result.summary && (
          <p className="max-w-3xl text-base text-fg">
            <span className="sr-only">AI suggestion: </span>
            {result.summary}
          </p>
        )}
        {aiProblem && <Meta className="block">{aiProblem}</Meta>}
      </div>

      <Journals venues={venues} year={year ?? null} hash={result.input.hash} aiUsed={ai.state === "used"} />
      <Colleagues colleagues={colleagues} hash={result.input.hash} asked={asked} aiUsed={ai.state === "used"} />
      <RelatedPapers papers={papers} />
    </div>
  )
}

function Section({ id, title, lead, children }: { id: string; title: string; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="space-y-1">
        <SectionTitle id={id}>{title}</SectionTitle>
        {lead && <p className="text-sm text-fg-muted">{lead}</p>}
      </div>
      {children}
    </section>
  )
}

const SHOW = 6

/** The first few, and the rest behind one honest button. */
function Few<T>({ items, render, noun }: { items: T[]; render: (item: T) => React.ReactNode; noun: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, SHOW)
  return (
    <>
      <ul className="divide-y divide-line">{shown.map(render)}</ul>
      {items.length > SHOW && !all && (
        <Button kind="quiet" size="sm" onClick={() => setAll(true)}>
          Show {items.length - SHOW} more {noun}
        </Button>
      )}
    </>
  )
}

/* ---- journals ------------------------------------------------------------ */

const FIT: Record<NonNullable<HelperVenue["fit"]>, string> = {
  strong: "Strong fit",
  good: "Good fit",
  possible: "Possible",
}

function Journals({ venues, year, hash, aiUsed }: { venues: HelperVenue[]; year: number | null; hash: string; aiUsed: boolean }) {
  if (venues.length === 0)
    return (
      <Section id="rh-journals" title="Journals that fit">
        <Meta className="block">No journal on record matches this yet.</Meta>
      </Section>
    )
  return (
    <Section
      id="rh-journals"
      title="Journals that fit"
      lead={
        <>
          Quartile and SNIP are the {year ?? "latest"} figures from Scimago. The college's own history with each journal is
          counted from its papers.
        </>
      }
    >
      <Few items={venues} noun="journals" render={(v) => <VenueRow key={v.id} v={v} />} />
      {aiUsed && (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <span>Were the AI's picks useful?</span>
          <Thumbs part="venues" hash={hash} />
        </div>
      )}
    </Section>
  )
}

function VenueRow({ v }: { v: HelperVenue }) {
  const h = v.history
  const quartiles = h ? Object.entries(h.quartiles).map(([q, n]) => `${q} ${n}`).join(", ") : ""
  return (
    <li className="space-y-2 py-4" data-testid="venue-row">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h3 className="min-w-0 text-base font-semibold text-fg">{v.title}</h3>
        {v.quartile && <Chip tone={v.quartile === "Q1" ? "gold" : "neutral"}>{v.quartile}</Chip>}
        {v.snip != null && <Chip>SNIP {v.snip.toFixed(2)}</Chip>}
        {v.picked && v.fit && <Chip tone="clay">{FIT[v.fit]}</Chip>}
      </div>
      {v.caution && <Caution c={v.caution} />}
      <p className="text-sm text-fg">
        {v.picked && v.ai_why ? (
          <>
            <AiMark className="mr-1.5" />
            {v.ai_why}
          </>
        ) : (
          v.why
        )}
      </p>
      {v.picked && v.ai_why && <p className="text-sm text-fg-muted">{v.why}</p>}
      <p className="text-sm text-fg-muted">
        {[v.subject, v.issn ? `ISSN ${v.issn}` : null].filter(Boolean).join(", ")}
        {h && h.papers > 0 && (
          <>
            {v.subject || v.issn ? ". " : ""}
            The college: {h.papers} {h.papers === 1 ? "paper" : "papers"}
            {h.first_year && h.last_year ? `, ${h.first_year === h.last_year ? h.first_year : `${h.first_year} to ${h.last_year}`}` : ""}
            , {h.colleagues} {h.colleagues === 1 ? "colleague" : "colleagues"}, {h.citations} citations
            {quartiles ? `, quartiles on record ${quartiles}` : ""}.
          </>
        )}
      </p>
    </li>
  )
}

function Caution({ c }: { c: Caution }) {
  const warn = c.level === "warning"
  return (
    <Callout tone={warn ? "critical" : "caution"} title={warn ? "Be careful with this journal" : "Check before you submit"} className="max-w-3xl">
      <p className="flex items-start gap-2">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
        <span>{c.text}</span>
      </p>
    </Callout>
  )
}

/* ---- colleagues -------------------------------------------------------- */

function Colleagues({ colleagues, hash, asked, aiUsed }: { colleagues: HelperColleague[]; hash: string; asked: Body; aiUsed: boolean }) {
  return (
    <Section
      id="rh-people"
      title="Colleagues on the same topic"
      lead="People at the college with papers near this one, and who you both have written with."
    >
      {colleagues.length === 0 ? (
        <Meta className="block">Nobody else at the college has papers near this yet.</Meta>
      ) : (
        <Few items={colleagues} noun="colleagues" render={(c) => <ColleagueRow key={c.id} c={c} asked={asked} hash={hash} />} />
      )}
      {aiUsed && colleagues.length > 0 && (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <span>Were the AI's picks useful?</span>
          <Thumbs part="people" hash={hash} />
        </div>
      )}
    </Section>
  )
}

function ColleagueRow({ c, asked, hash }: { c: HelperColleague; asked: Body; hash: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="space-y-3 py-4" data-testid="colleague-row">
      <div className="flex items-start gap-3">
        <Avatar person={{ name: c.name, initials: c.initials ?? initialsOf(c.name), photo_url: c.photo_url ?? null }} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 text-base font-semibold text-fg">
              <Link to={`/u/${c.user_id}`} className="hover:underline">
                {c.name}
              </Link>
            </h3>
            <Meta>{[c.department, c.designation].filter(Boolean).join(", ")}</Meta>
            {c.papers_together > 0 && <Chip tone="positive">Written together</Chip>}
          </div>
          <p className="text-sm text-fg">
            {c.picked && c.ai_why ? (
              <>
                <AiMark className="mr-1.5" />
                {c.ai_why}
              </>
            ) : (
              c.why
            )}
          </p>
          {c.picked && c.ai_why && <p className="text-sm text-fg-muted">{c.why}</p>}
          <ul className="space-y-0.5 text-sm text-fg-muted">
            {c.papers.slice(0, 2).map((p) => (
              <li key={p.id} className="min-w-0 break-words">
                {p.doi ? (
                  <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer" className="hover:underline">
                    {p.title}
                  </a>
                ) : (
                  p.title
                )}
                {p.year ? `, ${p.year}` : ""}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <MessageSquare aria-hidden />
              {open ? "Hide the draft" : "Draft a message"}
            </Button>
          </div>
        </div>
      </div>
      {open && <DraftBox c={c} asked={asked} hash={hash} />}
    </li>
  )
}

/** The introduction: editable text, opened in Messages only when the person says so. */
function DraftBox({ c, asked, hash }: { c: HelperColleague; asked: Body; hash: string }) {
  const [message, setMessage] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ template: boolean; ai: AiBlock } | null>(null)
  const make = useApiMutation<Body & { colleague_id: string }, DraftResult>("/api/research-helper/draft")
  const started = make.isIdle && message === null

  const run = (refresh: boolean) =>
    make.mutate(
      { ...asked, colleague_id: c.user_id, refresh },
      {
        onSuccess: (d) => {
          setMessage(d.message)
          setMeta({ template: d.template, ai: d.ai })
        },
      }
    )

  if (started) {
    // One press makes it: asking a model for words is not something a page
    // does for somebody who only wanted to read.
    return (
      <div className="well space-y-3 p-4 sm:ml-13">
        <Meta className="block">A short first message to {c.name}, which you can change before you use it. Nothing is sent.</Meta>
        <Button kind="primary" size="sm" onClick={() => run(false)}>
          <Sparkles aria-hidden />
          Write a draft
        </Button>
      </div>
    )
  }
  if (make.isPending && message === null)
    return (
      <div className="well space-y-2 p-4 sm:ml-13" aria-live="polite">
        <Meta>Writing a draft…</Meta>
        <Skeleton className="h-24 w-full" />
      </div>
    )
  if (make.isError && message === null) return <InlineError message={make.error.message} onRetry={() => run(false)} />

  const to = `/messages?to=${encodeURIComponent(c.user_id)}&draft=${encodeURIComponent(message ?? "")}`
  return (
    <div className="well space-y-3 p-4 sm:ml-13" data-testid="draft-box">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {meta?.template ? <Chip>A plain starting point</Chip> : <AiMark />}
        {!meta?.template && meta && (
          <Meta>
            {meta.ai.model}
            {meta.ai.hosted ? ` at ${meta.ai.host}` : ", on this server"}
          </Meta>
        )}
      </div>
      {meta && meta.ai.detail && (meta.ai.state === "failed" || meta.ai.state === "limit") && <Meta className="block">{meta.ai.detail}</Meta>}
      <Textarea
        aria-label={`Message to ${c.name}`}
        rows={8}
        maxRows={16}
        value={message ?? ""}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button kind="primary" size="sm" asChild>
          <Link to={to}>
            Use this
            <ArrowRight aria-hidden />
          </Link>
        </Button>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(message ?? "")
            toast.ok("Copied")
          }}
        >
          <Copy aria-hidden />
          Copy
        </Button>
        <Button kind="quiet" size="sm" onClick={() => run(true)} loading={make.isPending}>
          <RefreshCw aria-hidden />
          Try again
        </Button>
        {!meta?.template && <Thumbs part="draft" hash={hash} />}
      </div>
      <Meta className="block">
        Nothing is sent. Use this opens Messages with this text in the box, and you press send yourself.
      </Meta>
    </div>
  )
}

/* ---- related papers ---------------------------------------------------- */

function RelatedPapers({ papers }: { papers: HelperPaper[] }) {
  if (papers.length === 0) return null
  return (
    <Section id="rh-papers" title="Related papers at the college" lead="Papers on the college's record with topics near yours.">
      <ul className="divide-y divide-line">
        {papers.map((p) => (
          <li key={p.id} className="space-y-1 py-3" data-testid="paper-row">
            <p className="text-sm font-medium text-fg">
              {p.doi ? (
                <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer" className="hover:underline">
                  {p.title}
                </a>
              ) : (
                p.title
              )}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
              <span>{[p.venue, p.year].filter(Boolean).join(", ")}</span>
              {p.quartile && <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"}>{p.quartile}</Chip>}
              {p.mine && <Chip tone="clay">Yours</Chip>}
            </p>
            <p className="text-sm text-fg-muted">
              {p.authors.map((a, i) => (
                <span key={a.user_id}>
                  {i > 0 ? ", " : ""}
                  <Link to={`/u/${a.user_id}`} className="hover:underline">
                    {a.name}
                  </Link>
                </span>
              ))}
              {p.authors_more > 0 ? ` and ${p.authors_more} more` : ""}
              {p.matched.length > 0 && <span>. Matches {p.matched.join(", ")}</span>}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/* ------------------------------------------------------------------------ */
/* An entry point for other pages                                            */
/* ------------------------------------------------------------------------ */

export const RESEARCH_HELPER_PATH = "/research?tab=helper"

/** One quiet line that leads to the panel, for Discover. */
export function ResearchHelperLink({ className }: { className?: string }) {
  return (
    <p className={cn("text-sm text-fg-muted", className)}>
      Have an abstract or a paper idea?{" "}
      <Link to={RESEARCH_HELPER_PATH} className="inline-flex items-center gap-1 text-accent hover:underline">
        <Sparkles aria-hidden className="size-4" strokeWidth={1.75} />
        Ask the research helper
      </Link>
      <span className="sr-only"> for journals and colleagues that fit</span>
    </p>
  )
}
