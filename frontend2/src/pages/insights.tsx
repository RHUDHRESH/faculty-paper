import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Download, ExternalLink, Send } from "lucide-react"

import { can, useAuth, type Role } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Distribution, RankedBars, Trend, type Point } from "@/ui/chart"
import { Input, Select } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { Section } from "@/ui/section"
import { InlineError, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta } from "@/ui/text"
import { claimHref } from "@/pages/track-data"

/**
 * Ask the data: a question in plain English, answered from the college's own
 * counts (core/services/insights.py).
 *
 * The model, when there is one, only chooses which of a fixed set of
 * questions was asked and fills in its settings; every number on this page is
 * counted on the server. So the page is built to be used without it: the
 * suggested questions run straight away, and the settings under an answer
 * (department, year, quartile) refine it without retyping. A refusal (money,
 * for a head of department) and the AI being off are said in a line, in
 * place; only a failed request is drawn as an error.
 */

export type InsightParams = Record<string, string | number | null | undefined>

export type InsightRow = {
  kind: "paper" | "person" | "journal" | "claim" | "topic"
  id: string | null
  label: string
  value: number | string | null
  detail?: string
  doi?: string | null
  claim_id?: string | null
  source?: string
  is_mine?: boolean
  stage?: string
  user_id?: string
  name?: string
  photo_url?: string | null
  initials?: string
}

export type InsightAnswer = {
  answer: string
  query: string | null
  title: string
  params: InsightParams
  param_keys: string[]
  chart: "" | "bar" | "columns" | "line"
  unit: "count" | "money"
  series_label: string
  value_label: string
  series: { label: string; value: number; count?: number; key?: string | null }[]
  rows: InsightRow[]
  total_rows: number
  counted_how: string
  counted: boolean
  refused: boolean
  off_topic: boolean
  notices: string[]
  suggestions?: InsightChip[]
}

export type InsightChip = { label: string; query: string; params: InsightParams }

export type InsightSuggestions = {
  chips: InsightChip[]
  departments: string[]
  department: string | null
  years: number[]
  financial_years: { value: number; label: string }[]
  queries: { key: string; title: string; params: string[]; money: boolean }[]
  ai: boolean
}

type Run = { query: string; params: InsightParams }

const QUARTILES = [
  { value: "", label: "Any quartile" },
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
  { value: "top", label: "Q1 or Q2" },
]

/**
 * The chips this reader may run. The server already leaves a head's money
 * questions out; this is the net under it, so a chip the server sent by
 * mistake is never drawn for somebody who may not see what it answers.
 */
export function chipsFor(role: Role | undefined, s: InsightSuggestions | undefined, chips?: InsightChip[]): InsightChip[] {
  if (!s) return []
  const allowed = new Map(s.queries.map((q) => [q.key, q.money]))
  const seeMoney = can(role).seeMoney
  return (chips ?? s.chips).filter((c) => allowed.has(c.query) && (seeMoney || !allowed.get(c.query)))
}

/** Where a row of the answer lives, for this reader. */
export function rowHref(role: Role | undefined, r: InsightRow): { to: string; external?: boolean } | null {
  if (r.kind === "person") return r.id ? { to: `/u/${r.id}` } : null
  if (r.kind === "journal") return { to: `/search?scope=journals&q=${encodeURIComponent(r.label)}` }
  if (r.kind === "topic") return { to: `/search?q=${encodeURIComponent(r.label)}` }
  if (r.kind === "claim") return r.id ? { to: claimHref(role, { id: r.id, is_mine: !!r.is_mine }) } : null
  // A paper: a head reads a department's paper in their own view; everybody
  // else opens the claim behind it, or the paper at its DOI.
  if (role === "HOD" && (r.source === "record" || r.claim_id)) {
    return { to: `/department/papers/${encodeURIComponent(r.source === "record" ? (r.id ?? "") : (r.claim_id ?? ""))}` }
  }
  if (r.claim_id) return { to: `/papers/${r.claim_id}` }
  if (r.doi) return { to: `https://doi.org/${r.doi}`, external: true }
  return null
}

/** The download for the whole list behind an answer, not the rows on screen. */
export function csvHref(a: Pick<InsightAnswer, "query" | "params">): string {
  const q = new URLSearchParams({ query: a.query ?? "" })
  for (const [k, v] of Object.entries(a.params)) if (v !== null && v !== undefined && v !== "") q.set(k, String(v))
  return `/api/insights/run.csv?${q.toString()}`
}

function failure(e: ApiError): string {
  return e.status === 429 || e.status === 400 || e.status === 403 ? e.message : `${e.message} Try again.`
}

export function Insights() {
  const { me } = useAuth()
  const s = useApi<InsightSuggestions>(["insights", "suggestions"], "/api/insights/suggestions")
  const ask = useApiMutation<{ question: string }, InsightAnswer>("/api/insights/ask")
  const run = useApiMutation<Run, InsightAnswer>("/api/insights/run")
  const [text, setText] = useState("")
  const [result, setResult] = useState<InsightAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = ask.isPending || run.isPending

  useEffect(() => {
    document.title = "Ask the data"
  }, [])

  function onAnswer(a: InsightAnswer) {
    setError(null)
    setResult(a)
  }

  function submit(question: string) {
    const q = question.trim()
    if (!q || busy) return
    setError(null)
    ask.mutate({ question: q }, { onSuccess: onAnswer, onError: (e) => setError(failure(e)) })
  }

  function runQuery(query: string, params: InsightParams) {
    if (busy) return
    setError(null)
    run.mutate({ query, params }, { onSuccess: onAnswer, onError: (e) => setError(failure(e)) })
  }

  const chips = chipsFor(me?.role, s.data)

  return (
    <div className="page space-y-8">
      <PageHeader
        title="Ask the data"
        sub="Ask about papers, journals, people, claims or payouts. Every number is counted from the college's records."
        about="The question is matched to one of a fixed set of questions, and the server counts the answer from the same records the reports use. The AI, when it is on, only picks the question; it never writes a number. With the AI off, the suggestions below work just the same."
      />

      <form
        className="flex max-w-3xl gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit(text)
        }}
      >
        <Input
          size="lg"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="How many Q1 papers did we publish this year against last?"
          aria-label="Your question"
          maxLength={300}
          className="min-w-0 flex-1"
        />
        <Button type="submit" kind="primary" size="lg" disabled={!text.trim() || busy}>
          <Send />
          Ask
        </Button>
      </form>

      {s.isError ? (
        <InlineError message={`Could not load the suggested questions. ${s.error.message}`} onRetry={() => void s.refetch()} />
      ) : chips.length > 0 ? (
        <div className="space-y-2">
          <Meta className="block">{s.data?.ai ? "Or try one of these." : "AI is off right now. These questions still work."}</Meta>
          <div className="flex max-w-4xl flex-wrap gap-2" role="group" aria-label="Try asking">
            {chips.map((c) => (
              <Button key={c.label} size="sm" kind="quiet" className="ring-control-edge" disabled={busy} onClick={() => runQuery(c.query, c.params)}>
                {c.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {error && <InlineError message={error} />}

      {busy ? (
        <div role="status" className="space-y-3">
          <Meta className="block">Counting…</Meta>
          <SkeletonRows rows={4} rowHeight={40} />
        </div>
      ) : result ? (
        <AnswerView
          a={result}
          role={me?.role}
          s={s.data}
          onRefine={(params) => result.query && runQuery(result.query, params)}
          onChip={(c) => runQuery(c.query, c.params)}
        />
      ) : null}
    </div>
  )
}

function AnswerView({
  a,
  role,
  s,
  onRefine,
  onChip,
}: {
  a: InsightAnswer
  role: Role | undefined
  s: InsightSuggestions | undefined
  onRefine: (params: InsightParams) => void
  onChip: (c: InsightChip) => void
}) {
  const shown = !a.refused && !a.off_topic
  const offered = a.off_topic ? chipsFor(role, s, a.suggestions ?? []) : []
  return (
    <section aria-label="The answer" className="space-y-8">
      <div className="space-y-3">
        <p role="status" className="display text-display max-w-[40ch] text-balance text-fg">
          {a.answer}
        </p>
        {a.notices.map((n) => (
          <Meta key={n} className="block">
            {n}
          </Meta>
        ))}
      </div>

      {offered.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Questions I can answer">
          {offered.map((c) => (
            <Button key={c.label} size="sm" kind="quiet" className="ring-control-edge" onClick={() => onChip(c)}>
              {c.label}
            </Button>
          ))}
        </div>
      )}

      {shown && <Settings a={a} s={s} role={role} onChange={onRefine} />}
      {shown && a.chart && a.series.length > 0 && <AnswerChart a={a} role={role} />}

      {shown && a.counted_how && (
        <Section title="How this was counted">
          <p className="max-w-prose text-sm text-fg-muted">{a.counted_how}</p>
        </Section>
      )}

      {shown && a.rows.length > 0 && <AnswerList a={a} role={role} />}
    </section>
  )
}

/** The answer's settings, editable: change one and the same question runs again. */
function Settings({
  a,
  s,
  role,
  onChange,
}: {
  a: InsightAnswer
  s: InsightSuggestions | undefined
  role: Role | undefined
  onChange: (params: InsightParams) => void
}) {
  const keys = new Set(a.param_keys)
  const set = (k: string, v: string | number | null) => onChange({ ...a.params, [k]: v })
  const value = (k: string) => (a.params[k] == null ? "" : String(a.params[k]))
  const head = role === "HOD"
  const years = s?.years ?? []
  const pieces = []
  if (keys.has("department") && !head && s) {
    pieces.push(
      <label key="department" className="space-y-1">
        <ColumnLabel className="block">Department</ColumnLabel>
        <Select size="sm" aria-label="Department" value={value("department")} onChange={(e) => set("department", e.target.value || null)}>
          <option value="">The whole college</option>
          {s.departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      </label>
    )
  }
  if (keys.has("year")) {
    const options = Array.from(new Set([...years, ...(a.params.year ? [Number(a.params.year)] : [])])).sort((x, y) => y - x)
    pieces.push(
      <label key="year" className="space-y-1">
        <ColumnLabel className="block">Year</ColumnLabel>
        <Select
          size="sm"
          aria-label="Year"
          value={value("year")}
          onChange={(e) => onChange({ ...a.params, year: e.target.value ? Number(e.target.value) : null, year_to: null })}
        >
          <option value="">All years</option>
          {options.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </Select>
      </label>
    )
  }
  if (keys.has("quartile")) {
    pieces.push(
      <label key="quartile" className="space-y-1">
        <ColumnLabel className="block">Quartile</ColumnLabel>
        <Select size="sm" aria-label="Quartile" value={value("quartile")} onChange={(e) => set("quartile", e.target.value || null)}>
          {QUARTILES.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label}
            </option>
          ))}
        </Select>
      </label>
    )
  }
  if (keys.has("financial_year") && s?.financial_years.length) {
    pieces.push(
      <label key="financial_year" className="space-y-1">
        <ColumnLabel className="block">Financial year</ColumnLabel>
        <Select size="sm" aria-label="Financial year" value={value("financial_year")} onChange={(e) => set("financial_year", Number(e.target.value))}>
          {s.financial_years.map((f) => (
            <option key={f.value} value={String(f.value)}>
              {f.label}
            </option>
          ))}
        </Select>
      </label>
    )
  }
  if (pieces.length === 0) return null
  return (
    <div className="well flex flex-wrap items-end gap-4 px-4 py-3" role="group" aria-label="Change the question">
      {head && keys.has("department") && <Meta className="self-center">{s?.department ?? "Your department"} only</Meta>}
      {pieces.map((p) => (
        <div key={p.key} className="w-44 min-w-0">
          {p}
        </div>
      ))}
    </div>
  )
}

function AnswerChart({ a, role }: { a: InsightAnswer; role: Role | undefined }) {
  const isMoney = a.unit === "money"
  const points: Point[] = a.series.map((s) =>
    isMoney ? { key: s.label, count: s.count ?? 0, amount: s.value } : { key: s.label, count: s.value }
  )
  const common = {
    title: a.title,
    dimension: a.chart === "line" ? "Period" : "Item",
    points,
    unit: isMoney ? ("money" as const) : ("count" as const),
    showAmounts: isMoney && can(role).seeMoney,
    countLabel: a.series_label || "Papers",
  }
  if (a.chart === "line") return <Trend {...common} />
  if (a.chart === "columns") return <Distribution {...common} />
  return <RankedBars {...common} limit={12} />
}

function shownValue(a: InsightAnswer, r: InsightRow): string | null {
  if (r.value == null || r.value === "") return null
  if (typeof r.value === "number") return a.unit === "money" ? money(r.value) : formatCount(r.value)
  return r.value
}

function AnswerList({ a, role }: { a: InsightAnswer; role: Role | undefined }) {
  return (
    <Section
      title="What this counts"
      action={
        a.query ? (
          <Button size="sm" asChild>
            <a href={csvHref(a)} download>
              <Download />
              Download CSV
            </a>
          </Button>
        ) : undefined
      }
    >
      {a.value_label && (
        <p className="mb-1 flex justify-end px-1">
          <ColumnLabel>{a.value_label}</ColumnLabel>
        </p>
      )}
      {/* Rows' own hairline, on a list that names itself for a screen reader. */}
      <ul className="divide-y divide-line" aria-label="What this counts">
        {a.rows.map((r, i) => {
          const href = rowHref(role, r)
          const value = shownValue(a, r)
          const label = r.label || "Untitled"
          return (
            <li key={`${r.kind}-${r.id ?? i}-${i}`} className="flex items-center gap-3 px-1 py-2.5">
              {r.kind === "person" && (
                <Avatar size="sm" person={{ name: r.label, initials: r.initials ?? initialsOf(r.label), photo_url: r.photo_url ?? null }} />
              )}
              <div className="min-w-0 flex-1">
                {href?.external ? (
                  <a href={href.to} target="_blank" rel="noreferrer" className="font-medium underline-offset-4 hover:underline">
                    {label}
                    <ExternalLink className="ml-1 inline size-3 text-fg-subtle" aria-label="opens the paper at its DOI" />
                  </a>
                ) : href ? (
                  <Link to={href.to} className="font-medium underline-offset-4 hover:underline">
                    {label}
                  </Link>
                ) : (
                  <span className="font-medium">{label}</span>
                )}
                {r.detail && <Meta className="block truncate">{r.detail}</Meta>}
              </div>
              {value && <span className="tabular shrink-0 text-sm font-medium">{value}</span>}
            </li>
          )
        })}
      </ul>
      {a.total_rows > a.rows.length && (
        <p className="mt-2 px-1 text-sm text-fg-muted">
          Showing {formatCount(a.rows.length)} of {formatCount(a.total_rows)}. The download has all of them.
        </p>
      )}
    </Section>
  )
}
