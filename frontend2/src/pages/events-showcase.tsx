import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { keepPreviousData } from "@tanstack/react-query"

import { formatCount } from "@/lib/count"
import { unshout } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { DetailLink } from "@/ui/detail-sheet"
import { Select } from "@/ui/field"
import { Rows, Section } from "@/ui/section"
import { Delayed, EmptyState, ErrorState, Skeleton } from "@/ui/state"
import { Segmented } from "@/ui/toggle"
import {
  DEFAULT_PERIOD,
  PERIODS,
  isPeriod,
  shortDay,
  showcaseSentence,
  type HighlightPaper,
  type Highlights,
  type Period,
} from "@/pages/events-model"

/**
 * What the college has published lately, from the record and nowhere else.
 *
 * Research work was visible to whoever went looking for it. This puts it in
 * front of everybody: a sentence that says how much there was, then the papers
 * worth a look, each with the plain reason it is here. A part with nothing in
 * it is not drawn, and a stretch with nothing at all says so and points to
 * Discover, so the page is never an empty box.
 *
 * Counted, not judged: there is no model behind any line, and no money.
 */

/** Papers shown in a part before "Show more". */
const FIRST = 5

export function Showcase() {
  const [params, setParams] = useSearchParams()
  const asked = params.get("period")
  const period: Period = isPeriod(asked) ? asked : DEFAULT_PERIOD
  const department = params.get("department") ?? ""

  function change(changes: Record<string, string | null>) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        return next
      },
      { replace: true }
    )
  }

  const query = useApi<Highlights>(
    ["research", "highlights", period, department],
    `/api/research/highlights?period=${period}${department ? `&department=${encodeURIComponent(department)}` : ""}`,
    { placeholderData: keepPreviousData }
  )
  const data = query.data

  return (
    <div className="space-y-10">
      <div className="well flex flex-wrap items-center gap-3 p-3 sm:p-4">
        <Segmented
          label="Time"
          value={period}
          onChange={(id) => change({ period: id === DEFAULT_PERIOD ? null : id })}
          items={PERIODS.map((p) => ({ id: p.id, label: p.label }))}
        />
        <div className="max-sm:w-full sm:w-60">
          <Select aria-label="Department" value={department} onChange={(e) => change({ department: e.target.value || null })}>
            <option value="">All departments</option>
            {(data?.departments ?? (department ? [department] : [])).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {query.isError ? (
        <ErrorState what="the research showcase" onRetry={() => void query.refetch()} />
      ) : !data ? (
        <Delayed>
          <Skeleton className="h-64" />
        </Delayed>
      ) : data.empty ? (
        <Nothing data={data} period={period} department={department} change={change} />
      ) : (
        <Found data={data} />
      )}
    </div>
  )
}

const WIDER: Partial<Record<Period, Period>> = { month: "quarter", quarter: "year" }

/** Nothing in the stretch asked for: say so kindly, and offer a longer one or somewhere else to look. */
function Nothing({
  data,
  period,
  department,
  change,
}: {
  data: Highlights
  period: Period
  department: string
  change: (changes: Record<string, string | null>) => void
}) {
  const wider = WIDER[period]
  const label = data.label.toLowerCase()
  return (
    <EmptyState
      illustration="empty-no-results"
      title={department ? `Nothing new from ${department} in the ${label}` : `Nothing new in the ${label}`}
      message="Nothing new has come onto the college's record in that time. A longer stretch may have more."
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {wider && (
            <Button kind="primary" onClick={() => change({ period: wider === DEFAULT_PERIOD ? null : wider })}>
              Try the {PERIODS.find((p) => p.id === wider)?.label.toLowerCase()}
            </Button>
          )}
          {department && <Button onClick={() => change({ department: null })}>Show every department</Button>}
          <Button asChild>
            <Link to="/discover">Look at Discover</Link>
          </Button>
        </div>
      }
    />
  )
}

function Found({ data }: { data: Highlights }) {
  const sentence = showcaseSentence(data)
  const months = Math.round(data.windows.most_cited_days / 30.4)
  return (
    <div className="space-y-10">
      {/* The answer, in the display face, but at the title's size: the answer
          sentence here is eighty characters long, and at the largest size it
          outweighed every paper under it. */}
      {sentence && <p className="display text-display max-w-[34ch] text-balance text-fg">{sentence}</p>}
      <PaperSection title="New in Q1 journals" papers={data.q1} total={data.counts.q1} sub="Papers in a Q1 journal, newest first." />
      <PaperSection
        title="First papers in a journal"
        papers={data.first_papers}
        total={data.counts.first_papers}
        sub="Journals the college had not published in before."
      />
      <PaperSection
        title="Most cited lately"
        papers={data.most_cited}
        total={data.counts.most_cited}
        sub={`Papers from the last ${months} months with the most citations. A count is everything since the paper came out.`}
      />
      <PaperSection
        title="New names"
        papers={data.new_names}
        total={data.counts.new_names}
        sub="People whose first paper on the college record came out in this time."
      />
      <ByDepartment data={data} />
    </div>
  )
}

function PaperSection({ title, sub, papers, total }: { title: string; sub: string; papers: HighlightPaper[]; total: number }) {
  const [all, setAll] = useState(false)
  if (papers.length === 0) return null
  const shown = all ? papers : papers.slice(0, FIRST)
  const hidden = papers.length - FIRST
  return (
    <Section
      title={title}
      sub={sub}
      showSub
      action={total > papers.length ? <span className="text-fg-muted">{formatCount(total)} in all</span> : undefined}
    >
      <Rows>
        {shown.map((p) => (
          <li key={p.id}>
            <PaperCard paper={p} />
          </li>
        ))}
      </Rows>
      {hidden > 0 && (
        <Button kind="quiet" size="sm" className="mt-2" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show ${hidden} more`}
        </Button>
      )}
    </Section>
  )
}

/**
 * One paper: its title and journal open their panels, so does each college
 * author, and the line at the foot is the plain reason it is on the page.
 */
function PaperCard({ paper: p }: { paper: HighlightPaper }) {
  return (
    <article aria-label={p.title} className="min-w-0 space-y-2 py-4">
      <h3 className="text-pretty text-base font-medium">
        <DetailLink kind="paper" id={p.id}>
          {unshout(p.title)}
        </DetailLink>
      </h3>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
        {p.venue && <DetailLink kind="journal" name={p.venue} />}
        {p.quartile && (
          <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"} title="The journal's quartile on the college's record">
            {p.quartile}
          </Chip>
        )}
        {p.date && <span>{shortDay(p.date)}</span>}
        {p.citations > 0 && <span className="tabular">{formatCount(p.citations)} citations</span>}
      </p>
      <p className="flex flex-wrap gap-1.5">
        {p.authors.map((a) => (
          <DetailLink
            key={a.id}
            kind="person"
            id={a.id}
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-hover px-2.5 text-xs font-medium text-fg hover:bg-active hover:no-underline"
          >
            {a.name}
            {a.department && <span className="font-normal text-fg-muted">{a.department}</span>}
          </DetailLink>
        ))}
        {p.authors_more > 0 && <span className="inline-flex h-7 items-center text-xs text-fg-muted">and {p.authors_more} more</span>}
      </p>
      <p className="text-sm text-fg">{p.reason}</p>
    </article>
  )
}

const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`

/** Each department's papers as a bar: the longest is the whole width, so the bars say "how many compared with whom". */
function ByDepartment({ data }: { data: Highlights }) {
  const rows = data.by_department.slice(0, 10)
  if (rows.length === 0) return null
  const longest = Math.max(...rows.map((r) => r.papers), 1)
  return (
    <Section
      title="By department"
      sub="Papers published in this time, counted once for each department they involve."
      showSub
    >
      <ul aria-label="By department" className="space-y-2.5">
        {rows.map((r) => {
          const mine = r.department === data.department
          return (
            <li
              key={r.department}
              aria-label={`${r.department}: ${plural(r.papers, "paper", "papers")}${r.q1 ? `, ${r.q1} in ${r.q1 === 1 ? "a Q1 journal" : "Q1 journals"}` : ""}`}
              className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
            >
              <span className={mine ? "truncate font-semibold" : "truncate"}>{r.department}</span>
              <span aria-hidden className="h-2 overflow-hidden rounded-full bg-hover">
                <span className="block h-full rounded-full bg-area-research" style={{ width: `${Math.max(3, (r.papers / longest) * 100)}%` }} />
              </span>
              <span aria-hidden className="tabular min-w-12 text-right font-medium">
                {formatCount(r.papers)}
                {r.q1 > 0 && <span className="ml-1.5 font-normal text-fg-muted">{r.q1} Q1</span>}
              </span>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
