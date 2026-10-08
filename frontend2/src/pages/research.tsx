import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { AlarmClock, ArrowRight, Hourglass, Lightbulb, Sparkles, TrendingUp, UserRound } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useCollegeName } from "@/app/institution"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi, useApiMutation } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { MixBar, RankedBars, Sparkline, Trend } from "@/ui/chart"
import { Chip } from "@/ui/chip"
import { JournalRow, PersonRow } from "@/ui/entity"
import { Input } from "@/ui/field"
import { GoalRing } from "@/ui/goal-rings"
import { PageHeader } from "@/ui/page-header"
import { Picture } from "@/ui/picture"
import { Avatar, initialsOf } from "@/ui/person"
import { RecordStrip } from "@/ui/record-strip"
import { Details } from "@/ui/section"
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { Timeline, type TimelineEvent, type TimelineKind } from "@/ui/timeline"
import { toast } from "@/ui/toast"
import { DetailLink, detailHref } from "@/ui/detail-sheet"
import { ChoiceChips } from "@/pages/record-bits"
import { ResearchHelper } from "@/pages/research-helper"
import { CompassCard } from "@/pages/compass-parts"
import { unshout } from "@/lib/names"
/**
 * My research (docs/ux/05): one page, two tabs. "Me" validates the past
 * (record, timeline, citations), informs the present (topics, venues,
 * co-authors, this year — docs/ux/13 folds My goals in here) and gives ideas
 * for the future, each with its reason. "The college" is the picture the old
 * "college's research" page promised: a topic map, departments by topic,
 * rising topics and who works near you. Everything is counted from the
 * publication record (`/api/me/research`, `/api/college/research`).
 */

/* ------------------------------------------------------------------------ */
/* Types — frontend2/API.md "My research, the college picture"              */
/* ------------------------------------------------------------------------ */

type YearCount = { year: number; count: number }

type Coauthor = {
  key: string
  user_id: string | null
  name: string
  department: string | null
  papers_together: number
  last_year_together: number | null
  institutions: string[]
  photo_url?: string | null
  initials?: string
}

export type Idea = {
  kind: "topic" | "venue" | "person"
  id: string
  title: string
  reason: string
  source: "counted" | "model"
  to?: string
  quartile?: string | null
  department?: string | null
  via?: { id: string; name: string } | null
}

export type MyResearch = {
  headline: string | null
  metrics: {
    papers: number
    citations: number | null
    h_index: number | null
    i10_index: number | null
    q1: number
    first_author: number
    first_year: number | null
    cited_papers: number
  }
  papers_by_year: YearCount[]
  citations_by_year: YearCount[]
  strip: { month: string; papers: number }[]
  timeline: { year: number; kind: string; text: string; ref: string | null }[]
  top_papers: {
    id: string
    title: string
    year: number | null
    venue: string | null
    citations: number
    quartile: string | null
    doi: string | null
    position: number | null
    authors: number
  }[]
  topics: { id: string; label: string; papers: number; recent: number }[]
  venues: { id: string; name: string; quartile: string | null; papers: number; colleagues: number }[]
  mix: Record<string, number>
  coauthors: { inside_count: number; outside_count: number; inside: Coauthor[]; outside: Coauthor[] }
  this_year: {
    year: number
    papers: number
    same_date_last_year: number
    last_year_total: number
    target: number | null
    under_review: number
    drafts: number
  }
  ideas: Idea[]
}

export type CollegePicture = {
  totals: { papers: number; people: number; departments: number; this_year: number; last_year: number; citations: number }
  papers_by_year: YearCount[]
  topics: { id: string; label: string; papers: number; now: number; before: number; growth: number; mine: boolean }[]
  rising: { id: string; label: string; now: number; before: number }[]
  departments: { name: string; papers: number }[]
  dept_topic: { dept: string; topic: string; papers: number }[]
  near_me: {
    id: string
    name: string
    department: string | null
    designation: string | null
    papers: number
    reason: string
    /** Added to every person-shaped dict on the way out (backend/core/faces.py). */
    photo_url?: string | null
    initials?: string
  }[]
  my_topics: string[]
}

const topicHref = (q: string) => `/search?scope=topics&q=${encodeURIComponent(q)}`

/* ------------------------------------------------------------------------ */
/* Page                                                                     */
/* ------------------------------------------------------------------------ */

export function Research() {
  const [params, setParams] = useSearchParams()
  const { me } = useAuth()
  // The helper is for people who file their own research; the office roles
  // that only run the college never see it (the server refuses them too).
  const canHelp = !!me && me.role !== "SUPER_ADMIN"
  const wanted = params.get("tab")
  const tab = wanted === "college" ? "college" : wanted === "helper" && canHelp ? "helper" : "me"
  const mine = useApi<MyResearch>(["research", "me"], "/api/me/research", { enabled: tab === "me" })

  const sentence =
    tab === "college"
      ? "Where the college publishes, what is rising, and who works near you."
      : tab === "helper"
        ? "Paste an abstract or an idea, and find journals and colleagues at the college that fit."
        : mine.isLoading
        ? "Reading your record…"
        : mine.data?.headline
          ? "Your record, what you work on now and ideas for what's next."
          : "We will learn your topics from your papers' keywords once your record is matched."

  return (
    <div className="page space-y-10" data-area="research">
      <PageHeader
        spot="spot-my-research"
        title="My research"
        sub={<span aria-live="polite">{sentence}</span>}
        action={
          me?.id ? (
            <Button asChild>
              <Link to={`/u/${me.id}`}>
                <UserRound />
                Your public profile
              </Link>
            </Button>
          ) : undefined
        }
      >
        <div className="mt-4">
          <ChoiceChips
            label="Whose research"
            value={tab}
            onChange={(v) => setParams(v === "me" ? {} : { tab: v }, { replace: true })}
            options={[
              { id: "me", label: "Me" },
              { id: "college", label: "The college" },
              ...(canHelp ? [{ id: "helper" as const, label: "Research helper" }] : []),
            ]}
          />
        </div>
      </PageHeader>

      {tab === "college" ? <CollegeTab /> : tab === "helper" ? <ResearchHelper /> : <MeTab q={mine} />}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Me                                                                       */
/* ------------------------------------------------------------------------ */

type Q<T> = ReturnType<typeof useApi<T>>

function MeTab({ q }: { q: Q<MyResearch> }) {
  if (q.isError)
    return (
      <ErrorState
        title="Could not load your research"
        message={`${q.error.message} Nothing has been lost.`}
        onRetry={() => void q.refetch()}
      />
    )
  const d = q.data
  const m = d?.metrics
  const noRecord = d && m?.papers === 0
  const year = d?.this_year.year

  return (
    <>
      <div className="space-y-6">
        {d?.headline && <p className="display max-w-[30ch] text-balance text-display leading-tight text-fg">{d.headline}</p>}
        <CompassCard variant="research" />
      </div>
      <Answer
        items={[
          {
            value: m?.papers,
            label: "papers on your record",
            zero: "No papers on your record yet",
            to: "/papers",
            detail: m?.papers ? { kind: "metric", metric: "papers" } : undefined,
          },
          {
            value: m ? (m.citations ?? "Not yet") : null,
            label:
              m && m.citations == null
                ? "Citations arrive with your Scopus record"
                : `citations, h-index ${m?.h_index ?? 0}`,
            detail: m?.citations ? { kind: "metric", metric: "citations" } : undefined,
          },
          {
            value: d?.this_year.papers,
            label: `papers so far in ${year}`,
            zero: `None yet in ${year}`,
            to: `/papers?year=${year}`,
            detail: d?.this_year.papers ? { kind: "metric", metric: "year", value: year } : undefined,
          },
          {
            value: m?.first_author,
            label: "as first author",
            zero: "None as first author",
            detail: m?.first_author ? { kind: "metric", metric: "first_author" } : undefined,
          },
        ]}
      />

      {q.isLoading || !d ? (
        <SkeletonRows rows={6} rowHeight={56} />
      ) : noRecord ? (
        <EmptyRecord />
      ) : (
        <>
          <Past d={d} />
          <Present d={d} />
        </>
      )}
      {d && <Future d={d} />}
    </>
  )
}

function EmptyRecord() {
  return (
    <EmptyState
      illustration="empty-no-papers"
      title="Your record will build itself"
      message="Once we match you to your Scopus or OpenAlex profile, every paper you have published appears here, with its citations, your topics and co-authors."
      action={
        <Button kind="primary" asChild>
          <Link to="/papers">Check my record</Link>
        </Button>
      }
    />
  )
}

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string
  eyebrow: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id ?? eyebrow}-h`} className="space-y-6 scroll-mt-20">
      <div>
        <SectionTitle>
          <span id={`${id ?? eyebrow}-h`}>
            {title}
          </span>
        </SectionTitle>
      </div>
      {children}
    </section>
  )
}

const TL_KIND: Record<string, TimelineKind> = {
  first_q1: "first-q1",
  most_cited: "citation",
  milestone: "award",
}

function Past({ d }: { d: MyResearch }) {
  // Every entry opens what it names: a "first" opens its paper, a year's
  // count opens that year's papers.
  const events: TimelineEvent[] = d.timeline.map((e) => ({
    date: String(e.year),
    kind: TL_KIND[e.kind] ?? "paper",
    title:
      e.kind === "year" ? (
        <DetailLink kind="metric" metric="year" params={{ value: e.year }}>
          {e.text}
        </DetailLink>
      ) : e.ref ? (
        <DetailLink kind="paper" id={e.ref}>
          {e.text}
        </DetailLink>
      ) : (
        e.text
      ),
  }))
  const cites = d.citations_by_year.filter((c) => c.year >= (d.metrics.first_year ?? 0))
  const endYear = new Date().getFullYear()
  const h = d.metrics.h_index
  return (
    <Section eyebrow="Past" title="Your record">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="min-w-0">
          <Timeline events={events} />
        </div>
        <div className="flex min-w-0 flex-col gap-10">
          {d.metrics.citations ? (
            <div className="min-w-0">
              <Trend
                title="Citations by year of publication"
                caption="What the papers you published each year have been cited since."
                dimension="Year"
                points={cites.map((c) => ({
                  key: String(c.year),
                  count: c.count,
                  to: detailHref({ kind: "metric", metric: "year", value: c.year }),
                }))}
                height={200}
              />
              {!!h && (
                <p className="mt-3 text-sm text-fg-muted">
                  <DetailLink kind="metric" metric="h_index" number className="text-fg">
                    h-index {h}
                  </DetailLink>{" "}
                  means {h} of your papers have at least {h} citations each.
                </p>
              )}
            </div>
          ) : (
            <Meta>Citations arrive with your Scopus record.</Meta>
          )}
          {d.top_papers.length > 0 && (
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-fg">Your most-cited papers</h3>
              <ol className="mt-2 divide-y divide-line">
                {d.top_papers.map((p) => (
                  <li key={p.id} className="flex items-start gap-3 py-3">
                    <span className="figure w-10 shrink-0 text-right text-lg text-(--area)">
                      <DetailLink kind="paper" id={p.id} number label={`${p.citations} citations: ${unshout(p.title)}`}>
                        {p.citations}
                      </DetailLink>
                    </span>
                    <div className="min-w-0">
                      <p className="line-clamp-2 text-sm font-medium text-fg">
                        <DetailLink kind="paper" id={p.id}>
                          {unshout(p.title)}
                        </DetailLink>
                      </p>
                      <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
                        {p.venue && <DetailLink kind="journal" name={p.venue} />}
                        {p.venue && p.year ? " · " : ""}
                        {p.year}
                        {p.position && (
                          <span>
                            · {p.position === 1 ? "first author" : `author ${p.position} of ${p.authors}`}
                          </span>
                        )}
                        {p.quartile && <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"}>{p.quartile}</Chip>}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <Details label="papers by month, last ten years">
            <RecordStrip data={d.strip} endYear={endYear} label="Your papers by month" />
          </Details>
        </div>
      </div>
    </Section>
  )
}

function Present({ d }: { d: MyResearch }) {
  const mix = Object.entries(d.mix).map(([k, n]) => ({ key: k, count: n }))
  const co = [...d.coauthors.inside.slice(0, 5), ...d.coauthors.outside.slice(0, 3)]
  return (
    <Section eyebrow="Present" title="What you work on now">
      <ThisYear t={d.this_year} />
      <TopicPicture topics={d.topics} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
        <div className="min-w-0">
          {d.topics.length ? (
            <>
              <RankedBars
                title="Your topics"
                caption="From the topics of your own papers. Pick one to see your papers on it."
                dimension="Topic"
                points={d.topics.map((t) => ({
                  key: t.id,
                  label: t.label,
                  count: t.papers,
                  to: detailHref({ kind: "metric", metric: "topic", value: t.label }),
                }))}
                limit={8}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {d.topics
                  .filter((t) => t.recent > 0)
                  .slice(0, 5)
                  .map((t) => (
                    <DetailLink
                      key={t.id}
                      kind="metric"
                      metric="topic"
                      params={{ value: t.label }}
                      className="min-w-0 max-w-full rounded-full"
                    >
                      <Chip tone="area" icon={Sparkles} className="max-w-full">
                        <span className="truncate">
                          {t.label}, {t.recent} lately
                        </span>
                      </Chip>
                    </DetailLink>
                  ))}
              </div>
              <Link to={topicHref(d.topics[0].label)} className="mt-2 inline-block text-sm text-accent hover:underline">
                Who else works on {d.topics[0].label}
              </Link>
            </>
          ) : (
            <Meta>
              We will learn your topics from your papers' keywords once your record is matched.{" "}
              <Link to="/papers" className="text-accent hover:underline">
                Check my record
              </Link>
            </Meta>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-base font-semibold text-fg">Who you write with</h3>
            <Link to="/collaborate" className="text-sm text-accent hover:underline">
              Who to work with
            </Link>
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            {formatCount(d.coauthors.inside_count)} inside the college, {formatCount(d.coauthors.outside_count)} outside.
            The ones you write with most:
          </p>
          <ul className="mt-2 divide-y divide-line">
            {co.map((c) => (
              <li key={c.key} className="flex items-center gap-3 py-2.5">
                <Avatar person={{ name: c.name, initials: c.initials ?? initialsOf(c.name), photo_url: c.photo_url ?? null }} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">
                    {c.user_id ? (
                      <DetailLink kind="person" id={c.user_id}>
                        {c.name}
                      </DetailLink>
                    ) : (
                      c.name
                    )}
                  </p>
                  <p className="truncate text-sm text-fg-muted">{c.department ?? c.institutions[0] ?? "Outside the college"}</p>
                </div>
                <span className="shrink-0 text-sm text-fg-muted tabular">
                  {c.papers_together} {c.papers_together === 1 ? "paper" : "papers"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {d.venues.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-fg">Where you publish</h3>
          <ul className="divide-y divide-line border-y border-line">
            {d.venues.slice(0, 3).map((v) => (
              <li key={v.id}>
                <JournalRow
                  name={v.name}
                  quartile={v.quartile}
                  colleagues={v.colleagues}
                  subjects={[`${v.papers} of yours`]}
                  detail
                />
              </li>
            ))}
          </ul>
          {mix.length > 1 && <MixBar title="Kinds of work" dimension="Kind" points={mix} />}
        </div>
      )}
    </Section>
  )
}

/* ------------------------------------------------------------------------ */
/* Future                                                                   */
/* ------------------------------------------------------------------------ */

const IDEA_LABEL: Record<Idea["kind"], string> = {
  topic: "A topic rising near you",
  venue: "A journal that fits",
  person: "Someone to write with",
}

/** One idea as a row of the hairline list under "Ideas for what's next". */
export function IdeaCard({ idea }: { idea: Idea }) {
  const follow = useApiMutation<{ topic: string }>("/api/follows/topics", { invalidates: [["discover"]] })
  return (
    <article data-area="research" className="flex items-center gap-3 py-3">
      <Lightbulb aria-hidden className="size-4 shrink-0 text-(--area)" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <h3 className="flex min-w-0 items-center gap-2 text-base font-medium text-fg">
          {idea.kind === "topic" && idea.to ? (
            <Link to={idea.to} className="min-w-0 truncate underline-offset-4 hover:underline">
              {idea.title}
            </Link>
          ) : (
            <span className="min-w-0 truncate">{idea.title}</span>
          )}
          {idea.quartile && (
            <Chip tone={idea.quartile === "Q1" ? "gold" : "neutral"} className="shrink-0">
              {idea.quartile}
            </Chip>
          )}
        </h3>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
          <Meta className="min-w-0 truncate">
            {IDEA_LABEL[idea.kind]} · <span>{idea.reason}</span>
          </Meta>
          <Chip tone={idea.source === "counted" ? "area" : "neutral"} className="shrink-0">
            {idea.source === "counted" ? "Counted" : "A suggestion"}
          </Chip>
        </div>
      </div>
      {idea.kind === "topic" ? (
        <Button
          kind="default"
          size="sm"
          className="shrink-0"
          disabled={follow.isPending || follow.isSuccess}
          onClick={() =>
            follow.mutate(
              { topic: idea.title },
              {
                onSuccess: () => toast.ok(`Following ${idea.title}`),
                onError: (e) => toast.fail(e),
              }
            )
          }
        >
          {follow.isSuccess ? "Following" : "Follow topic"}
        </Button>
      ) : idea.to ? (
        <Button kind="default" size="sm" asChild className="shrink-0">
          <Link to={idea.to}>{idea.kind === "person" ? "See their profile" : "See the journal"}</Link>
        </Button>
      ) : null}
    </article>
  )
}

function Future({ d }: { d: MyResearch }) {
  return (
    <Section eyebrow="Future" title="Ideas for what's next">
      {d.ideas.length > 0 ? (
        <ul className="divide-y divide-line border-y border-line">
          {d.ideas.map((i) => (
            <li key={`${i.kind}-${i.id}`}>
              <IdeaCard idea={i} />
            </li>
          ))}
        </ul>
      ) : (
        <Meta className="block">
          Ideas appear once we know your topics, from your papers or from the topics you follow in{" "}
          <Link to="/discover" className="text-accent hover:underline">
            Discover
          </Link>
          .
        </Meta>
      )}
      <Link to="/discover" className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
        More ideas in Discover
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </Section>
  )
}

/** docs/ux/13: "am I on track this year?", answered without typing anything. */
export function paceLine(t: MyResearch["this_year"]): string {
  if (t.papers === 0) return `No papers yet in ${t.year}. Last year you had ${t.same_date_last_year} by now.`
  const k = t.papers - t.same_date_last_year
  const head = `${t.papers} ${t.papers === 1 ? "paper" : "papers"} so far in ${t.year}.`
  if (k > 0) return `${head} You're ${k} ahead of last year's pace.`
  if (k < 0) return `${head} You're ${-k} behind last year's pace.`
  return `${head} Same pace as last year.`
}

function ThisYear({ t }: { t: MyResearch["this_year"] }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(t.target ?? ""))
  const save = useApiMutation<{ year: number; goals: { metric: string; target: number }[] }>("/api/me/goals", {
    method: "PUT",
    invalidates: [["research", "me"], ["goals"]],
  })
  // Only your own target: the API sends no college quota here.
  const target = t.target
  const ring =
    target != null
      ? {
          metric: "PAPERS",
          label: "Personal target",
          target,
          done: t.papers,
          available: true,
          fraction: target ? t.papers / target : 0,
          met: t.papers >= target,
          built_in: false,
        }
      : null
  return (
    <div id="this-year" className="scroll-mt-20">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-base font-semibold text-fg">This year</h3>
          <p className="text-lg font-semibold text-fg">
            {t.papers > 0 ? (
              <DetailLink kind="metric" metric="year" params={{ value: t.year }} number>
                {paceLine(t)}
              </DetailLink>
            ) : (
              paceLine(t)
            )}
          </p>
          <p className="text-sm text-fg-muted">
            Last year you published{" "}
            {t.last_year_total > 0 ? (
              <DetailLink kind="metric" metric="year" params={{ value: t.year - 1 }} number className="text-fg">
                {t.last_year_total}
              </DetailLink>
            ) : (
              t.last_year_total
            )}{" "}
            in all.
            {t.under_review > 0 && (
              <>
                {" "}
                <Link to="/papers?tab=progress" className="inline-flex items-center gap-1 text-accent hover:underline">
                  <Hourglass aria-hidden className="size-4" strokeWidth={1.75} />
                  {t.under_review} with the college
                </Link>
              </>
            )}
            {t.drafts > 0 && (
              <>
                {" · "}
                <Link to="/papers/claims" className="text-accent hover:underline">
                  {t.drafts} {t.drafts === 1 ? "draft waits" : "drafts wait"}
                </Link>
              </>
            )}
          </p>
          <Link to="/calendar" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
            <AlarmClock aria-hidden className="size-4" strokeWidth={1.75} />
            Next deadlines
          </Link>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {ring && <GoalRing goal={ring} size={88} />}
          {editing ? (
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const n = Math.max(0, Math.min(1000, Number.parseInt(value, 10) || 0))
                  save.mutate(
                    { year: t.year, goals: [{ metric: "PAPERS", target: n }] },
                    {
                      onSuccess: () => setEditing(false),
                      onError: (err) => toast.fail(err),
                    }
                  )
                }}
              >
                <label className="flex flex-col gap-1 text-sm text-fg-muted">
                  Papers in {t.year}
                  <Input
                    type="number"
                    min={0}
                    max={1000}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="w-24"
                  />
                </label>
                <Button kind="primary" type="submit" disabled={save.isPending}>
                  Save target
                </Button>
              </form>
            ) : (
              <Button kind="quiet" onClick={() => setEditing(true)}>
                {t.target ? "Edit my target" : "Set a target, only you see it"}
              </Button>
            )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The college                                                              */
/* ------------------------------------------------------------------------ */

function CollegeTab() {
  const college = useCollegeName()
  const q = useApi<CollegePicture>(["research", "college"], "/api/college/research")
  if (q.isError)
    return (
      <ErrorState
        title="Could not load the college picture"
        message="Your own record is unaffected."
        onRetry={() => void q.refetch()}
      />
    )
  if (q.isLoading || !q.data)
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <SkeletonRows rows={6} rowHeight={48} />
      </div>
    )
  const d = q.data
  const delta = d.totals.this_year - d.totals.last_year
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="display text-balance text-display text-fg">
          {college} published <span className="figure text-(--area)">{formatCount(d.totals.papers)}</span>{" "}
          papers across {d.totals.departments} departments
        </p>
        <p className="text-sm text-fg-muted">
          Every paper on record with an author from the college, past or present.{" "}
          {formatCount(d.totals.people)} authors here, {formatCount(d.totals.citations)} citations,{" "}
          {formatCount(d.totals.this_year)} papers so far this year ({formatCount(d.totals.last_year)} last year)
        </p>
        {d.papers_by_year.length > 1 && (
          <Sparkline
            values={d.papers_by_year.map((p) => p.count)}
            width={240}
            height={40}
            label="College papers per year"
            className="mt-4"
          />
        )}
        {delta !== 0 && <span className="sr-only">{delta} vs last year</span>}
      </div>

      <Section eyebrow="Topics" title="What the college works on">
        <TopicMap topics={d.topics} />
        <p className="text-xs text-fg-muted">
          <span className="mr-1 inline-block size-3 rounded-sm align-middle shadow-[inset_0_0_0_2px_var(--color-brand)]" />
          Outlined: topics you have published on.
        </p>
      </Section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Section eyebrow="Departments" title="Who works on what">
          <HeatGrid d={d} />
        </Section>
        <Section eyebrow="Rising" title="Growing this year">
          {d.rising.length ? (
            <ul className="panel divide-y divide-line">
              {d.rising.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <TrendingUp aria-hidden className="size-4 shrink-0 text-positive" strokeWidth={1.75} />
                  <Link to={topicHref(r.label)} className="min-w-0 flex-1 truncate text-sm font-medium text-fg hover:underline">
                    {r.label}
                  </Link>
                  <span className="shrink-0 text-xs text-fg-muted tabular">
                    {r.now} in 12 months · was {r.before}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Meta>No topic has grown enough in the last year to call it rising.</Meta>
          )}
        </Section>
      </div>

      <Section eyebrow="People" title="Near you">
        {d.near_me.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {d.near_me.map((p) => (
              <li key={p.id}>
                <PersonRow
                  person={{ id: p.id, name: p.name, initials: p.initials ?? initialsOf(p.name), photo_url: p.photo_url ?? null, department: p.department, designation: p.designation }}
                  to={`/u/${p.id}`}
                  context={p.reason}
                  messageTo={`/messages/${p.id}`}
                />
              </li>
            ))}
          </ul>
        ) : (
          <Meta>People working on your topics appear here once your record has topics.</Meta>
        )}
      </Section>
    </div>
  )
}

function TopicMap({ topics }: { topics: CollegePicture["topics"] }) {
  const max = Math.max(1, ...topics.map((t) => t.papers))
  return (
    <>
      <div className="hidden flex-wrap gap-1.5 sm:flex" role="list" aria-label="Topics by papers">
        {topics.map((t) => {
          const share = t.papers / max
          return (
            <Link
              role="listitem"
              key={t.id}
              to={topicHref(t.label)}
              title={`${t.label} · ${t.papers} papers`}
              style={{ flexGrow: t.papers, flexBasis: `${Math.max(8, share * 26)}rem` }}
              className={cn(
                "flex min-h-20 flex-col justify-between rounded-lg p-3 text-left transition-colors hover:brightness-95",
                share > 0.6 ? "bg-(--area) text-white dark:text-sunken" : share > 0.3 ? "bg-(--area)/70 text-white dark:text-sunken" : "bg-(--area-wash) text-fg",
                t.mine && "shadow-[inset_0_0_0_2px_var(--color-brand)] ring-2 ring-brand ring-offset-1 ring-offset-bg"
              )}
            >
              <span className="line-clamp-2 text-sm font-medium">{t.label}</span>
              <span className="text-xs tabular opacity-80">
                {t.papers} papers{t.growth > 0 ? ` · +${t.growth}` : ""}
              </span>
            </Link>
          )
        })}
      </div>
      <div className="sm:hidden">
        <RankedBars
          title="Topics"
          dimension="Topic"
          limit={12}
          points={topics.map((t) => ({ key: t.id, label: t.mine ? `${t.label} (yours)` : t.label, count: t.papers, to: topicHref(t.label) }))}
        />
      </div>
    </>
  )
}

function HeatGrid({ d }: { d: CollegePicture }) {
  const cols = d.topics.slice(0, 10)
  const cell = new Map(d.dept_topic.map((c) => [`${c.dept}|${c.topic}`, c.papers]))
  const max = Math.max(1, ...d.dept_topic.map((c) => c.papers))
  if (!d.departments.length || !cols.length) return <Meta>Not enough papers are matched to departments yet.</Meta>
  return (
    <div className="panel overflow-x-auto p-3">
      <table className="w-full border-separate border-spacing-1 text-xs">
        <thead>
          <tr>
            <th className="sr-only">Department</th>
            {cols.map((t) => (
              <th key={t.id} scope="col" className="h-24 min-w-9 align-bottom font-medium text-fg-muted">
                <span className="inline-block max-w-24 origin-bottom-left -rotate-45 translate-x-4 truncate whitespace-nowrap text-left" title={t.label}>
                  {t.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.departments.map((dep) => (
            <tr key={dep.name}>
              <th scope="row" className="max-w-40 truncate pr-2 text-left font-medium text-fg" title={dep.name}>
                {dep.name}
              </th>
              {cols.map((t) => {
                const n = cell.get(`${dep.name}|${t.id}`) ?? 0
                return (
                  <td
                    key={t.id}
                    title={`${dep.name} · ${t.label} · ${n} papers`}
                    aria-label={`${dep.name}, ${t.label}: ${n} papers`}
                    className="h-8 min-w-9 rounded-sm text-center tabular"
                    style={{
                      background: n ? `color-mix(in oklab, var(--area) ${Math.round(15 + (n / max) * 85)}%, transparent)` : undefined,
                      color: n / max > 0.5 ? "white" : undefined,
                    }}
                  >
                    {n || ""}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const TOPIC_PICTURES: [RegExp, string][] = [
  [/smart grid|power flow|microgrid|distribution system/i, "topic-smart-grid"],
  [/photovoltaic|solar/i, "topic-solar-energy"],
  [/wind/i, "topic-wind-energy"],
  [/converter|power quality|harmonic|inverter|power electronic/i, "topic-power-electronics"],
  [/battery|electric vehicle/i, "topic-electric-vehicles"],
  [/control/i, "topic-control-systems"],
  [/deep learning|neural/i, "topic-deep-learning"],
  [/machine learning/i, "topic-machine-learning"],
  [/language|nlp/i, "topic-nlp"],
  [/vision|image/i, "topic-computer-vision"],
  [/iot|internet of things|sensor/i, "topic-iot"],
  [/nano|luminescen|material/i, "topic-nanomaterials"],
  [/signal/i, "topic-signal-processing"],
  [/optimi[sz]/i, "topic-optimisation"],
]

/** The picture for a person's top area, or null when none of their top topics maps to one. */
export function topicPicture(labels: string[]): { name: string; label: string } | null {
  for (const label of labels) for (const [re, name] of TOPIC_PICTURES) if (re.test(label)) return { name, label }
  return null
}

function TopicPicture({ topics }: { topics: MyResearch["topics"] }) {
  const pic = topicPicture(topics.slice(0, 3).map((t) => t.label))
  if (!pic) return null
  return (
    <figure className="flex items-center gap-4">
      <Picture name={pic.name} className="size-20 shrink-0 sm:size-24" />
      <figcaption className="text-sm text-fg-muted">
        Your main area: <span className="font-medium text-fg">{pic.label}</span>
      </figcaption>
    </figure>
  )
}

