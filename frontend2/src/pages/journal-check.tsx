import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { AlertTriangle, CheckCircle2, CircleHelp, Search, XCircle } from "lucide-react"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Section } from "@/ui/section"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { FollowTopicButton } from "@/pages/follow-topics"

/**
 * Check a journal before you send a paper to it: is it still in Scopus, is it
 * on the college watch list or a discontinued or hijacked list, how has the
 * college fared there, and what the paper would earn. See
 * `core/services/journal_check.py`; a list that has not been loaded is shown
 * as unknown, never as fine.
 */

export type CheckStatus = "ok" | "warn" | "bad" | "unknown"

export type JournalCheck = {
  query: string
  kind: "name" | "issn" | "url"
  domain: string | null
  data_latest_year: number
  matches: { id: string; name: string; issns: string[]; quartile: string | null; latest_year_in_data: number }[]
  journal: {
    id: string
    name: string
    issns: string[]
    publisher: string | null
    quartile: string | null
    subject: string | null
    sjr: number | null
    snip: number | null
    categories: { name: string; quartile: string | null }[]
    latest_year_in_data: number
  } | null
  checks: { key: string; status: CheckStatus; title: string; detail: string }[]
  verdict: { level: "safe" | "caution" | "avoid"; text: string }
  college: {
    papers: number
    colleagues: { id: string; name: string }[]
    colleague_count: number
    mine: { id: string; title: string; year: number | null }[]
    claims: Record<string, number>
  }
  estimate?: {
    needs?: string
    assumes?: string
    positions?: { position: number; amount: number | null; why_not: string | null }[]
  }
  estimate_hidden?: boolean
}

const ICON: Record<CheckStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  ok: { icon: CheckCircle2, className: "text-positive", label: "Fine" },
  warn: { icon: AlertTriangle, className: "text-caution", label: "Warning" },
  bad: { icon: XCircle, className: "text-critical", label: "Problem" },
  unknown: { icon: CircleHelp, className: "text-fg-subtle", label: "Not known" },
}

const VERDICT_TONE = { safe: "positive", caution: "caution", avoid: "critical" } as const

const CLAIM_LABEL: Record<string, string> = {
  in_review: "in review",
  cleared: "cleared",
  paid: "paid",
  sent_back: "sent back",
  under_review: "under review",
  approved: "approved",
  completed: "completed",
  not_yet_filed: "not yet filed",
}

function checkPath(q: string, pick?: string | null) {
  return `/api/journals/check?q=${encodeURIComponent(q)}${pick ? `&pick=${encodeURIComponent(pick)}` : ""}`
}

export function useJournalCheck(q: string, pick?: string | null) {
  const query = q.trim()
  return useApi<JournalCheck>(["journal-check", query, pick ?? null], checkPath(query, pick), {
    enabled: query.length >= 3,
    staleTime: 60_000,
  })
}

function ordinal(n: number) {
  return n === 1 ? "First author" : n === 2 ? "Second author" : n === 3 ? "Third author" : `Author ${n}`
}

export function JournalCheckPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get("q") || ""
  const pick = params.get("pick")
  const [text, setText] = useState(q)
  useEffect(() => setText(q), [q])
  const res = useJournalCheck(q, pick)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const v = text.trim()
    setParams(v ? { q: v } : {})
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Check a journal"
        sub="Before you submit, see whether a journal is still in Scopus, whether the college has flagged it, and what a paper there would earn."
      />
      <form onSubmit={submit} className="flex max-w-2xl gap-2" role="search">
        <Input
          aria-label="Journal name, ISSN or website"
          placeholder="Journal name, ISSN or website"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" kind="primary">
          <Search className="size-4" aria-hidden />
          Check
        </Button>
      </form>

      {!q ? (
        <Meta className="block">Type a journal's name, its ISSN, or paste the website that asked you for a paper.</Meta>
      ) : q.trim().length < 3 ? (
        <Meta className="block">Type at least three characters.</Meta>
      ) : res.isError ? (
        <ErrorState what="the journal check" message={res.error.message} onRetry={() => void res.refetch()} />
      ) : res.isLoading || !res.data ? (
        <SkeletonRows rows={5} rowHeight={44} />
      ) : (
        <Result data={res.data} onPick={(id) => setParams({ q, pick: id })} />
      )}
    </div>
  )
}

function Result({ data, onPick }: { data: JournalCheck; onPick: (id: string) => void }) {
  const j = data.journal
  return (
    <div className="space-y-8">
      {data.matches.length > 1 && (
        <Section title="Which journal did you mean?">
          <ul className="flex flex-wrap gap-2" aria-label="Matching journals">
            {data.matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onPick(m.id)}
                  aria-pressed={j?.id === m.id}
                  className={cn(
                    "rounded-control px-3 py-1.5 text-left text-sm ring-1 ring-inset ring-edge hover:bg-hover",
                    j?.id === m.id && "bg-active font-medium ring-accent"
                  )}
                >
                  {m.name}
                  <span className="ml-1.5 text-xs text-fg-muted">
                    {[m.quartile, m.issns[0], `${m.latest_year_in_data} data`].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Callout tone={VERDICT_TONE[data.verdict.level]} title={j ? j.name : data.query}>
        <p className="text-base font-medium" data-testid="verdict">{data.verdict.text}</p>
        {j && (
          <p className="mt-1 text-sm text-fg-muted">
            {[j.issns.join(", "), j.publisher, j.subject].filter(Boolean).join(" · ")}
          </p>
        )}
      </Callout>

      <Section title="Checks">
        <ul className="divide-y divide-line" aria-label="Checks">
          {data.checks.map((c) => {
            const s = ICON[c.status]
            const Icon = s.icon
            return (
              <li key={c.key} className="flex gap-3 py-3">
                <Icon className={cn("mt-0.5 size-5 shrink-0", s.className)} aria-label={s.label} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{c.title}</p>
                  <p className="text-sm text-fg-muted">{c.detail}</p>
                </div>
              </li>
            )
          })}
        </ul>
      </Section>

      <Section title="The college here">
        <College data={data} />
      </Section>

      {!data.estimate_hidden && data.estimate && (
        <Section title="What a paper here would earn">
          {data.estimate.needs ? (
            <Meta className="block">{data.estimate.needs}</Meta>
          ) : (
            <>
              <ul className="grid gap-3 sm:grid-cols-3">
                {data.estimate.positions?.map((p) => (
                  <li key={p.position} className="panel rounded-panel p-4">
                    <Meta className="block">{ordinal(p.position)}</Meta>
                    {p.amount != null ? (
                      <span className="block text-lg font-semibold tabular">{money(p.amount)}</span>
                    ) : (
                      <span className="block text-sm text-fg-muted">{p.why_not || "Could not be worked out."}</span>
                    )}
                  </li>
                ))}
              </ul>
              <Meta className="mt-2 block">Estimates. {data.estimate.assumes}</Meta>
            </>
          )}
        </Section>
      )}

      {j && (
        <div className="flex flex-wrap gap-3">
          <FollowTopicButton journal={j.name} />
          <Button asChild kind="quiet">
            <Link to={`/search?q=${encodeURIComponent(j.name)}`}>See colleagues' papers</Link>
          </Button>
        </div>
      )}
    </div>
  )
}

function College({ data }: { data: JournalCheck }) {
  const c = data.college
  const claimBits = Object.entries(c.claims)
    .filter(([k, n]) => k !== "total" && n > 0)
    .map(([k, n]) => `${formatCount(n)} ${CLAIM_LABEL[k] || k.replace(/_/g, " ")}`)
  return (
    <div className="space-y-3 text-sm">
      <p>
        {c.papers === 0
          ? "The college has no papers here yet."
          : `The college has ${formatCount(c.papers)} ${c.papers === 1 ? "paper" : "papers"} here, by ${formatCount(c.colleague_count)} ${c.colleague_count === 1 ? "colleague" : "colleagues"} besides you.`}
      </p>
      {c.colleagues.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Colleagues who published here">
          {c.colleagues.map((p) => (
            <li key={p.id}>
              <Link to={`/u/${p.id}`} className="text-accent hover:underline">
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p>
        {c.mine.length === 0
          ? "You have no papers here."
          : `You have ${c.mine.length} ${c.mine.length === 1 ? "paper" : "papers"} here: ${c.mine.map((m) => m.title).join("; ")}.`}
      </p>
      <p>
        {c.claims.total
          ? `Claims filed for this journal: ${formatCount(c.claims.total)}${claimBits.length ? ` (${claimBits.join(", ")})` : ""}.`
          : "No claims have been filed for this journal."}
      </p>
    </div>
  )
}

/** A short verdict beside the journal field while filing. */
export function JournalVerdictInline({ journal, issn }: { journal: string; issn?: string }) {
  const raw = (issn || "").trim().length >= 8 ? (issn as string) : journal
  const [q, setQ] = useState(raw.trim())
  useEffect(() => {
    const t = setTimeout(() => setQ(raw.trim()), 500)
    return () => clearTimeout(t)
  }, [raw])
  const res = useJournalCheck(q)
  if (q.length < 3 || !res.data) return null
  const level = res.data.verdict.level
  const Icon = level === "safe" ? CheckCircle2 : level === "avoid" ? XCircle : AlertTriangle
  const tone = level === "safe" ? "text-positive" : level === "avoid" ? "text-critical" : "text-caution"
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-sm" data-testid="inline-verdict">
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
      <span>
        {res.data.verdict.text}{" "}
        <Link to={`/journal-check?q=${encodeURIComponent(q)}`} className="font-medium text-accent hover:underline">
          See the full check
        </Link>
      </span>
    </p>
  )
}

export default JournalCheckPage
