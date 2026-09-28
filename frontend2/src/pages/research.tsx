import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import {
  AlarmClock,
  ArrowRight,
  Building2,
  FileText,
  Gem,
  Hourglass,
  Lightbulb,
  PenLine,
  Quote,
  Sparkles,
  TrendingUp,
  UserRound,
} from "lucide-react"

import { useAuth } from "@/app/auth"
import { useCollegeName } from "@/app/institution"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { MixBar, RankedBars, Sparkline, Trend } from "@/ui/chart"
import { Chip } from "@/ui/chip"
import { JournalCard, PersonCard } from "@/ui/entity"
import { GoalRing } from "@/ui/goal-rings"
import { HeroBand } from "@/ui/hero"
import { Picture } from "@/ui/picture"
import { Avatar, initialsOf } from "@/ui/person"
import { RecordStrip } from "@/ui/record-strip"
import { StatRow, StatTile } from "@/ui/stat"
import { ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { Timeline, type TimelineEvent, type TimelineKind } from "@/ui/timeline"
import { toast } from "@/ui/toast"

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
    quota: number | null
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
  }[]
  my_topics: string[]
}

const topicHref = (q: string) => `/search?scope=topics&q=${encodeURIComponent(q)}`

/* ------------------------------------------------------------------------ */
/* Page                                                                     */
/* ------------------------------------------------------------------------ */

export function Research() {
  const [params, setParams] = useSearchParams()
  const tab = params.get("tab") === "college" ? "college" : "me"
  const { me } = useAuth()
  const mine = useApi<MyResearch>(["research", "me"], "/api/me/research")

  const tabs = (
    <div role="tablist" aria-label="Whose research" className="mt-5 inline-flex gap-1 rounded-full bg-surface/70 p-1 shadow-[inset_0_0_0_1px_var(--area-line)]">
      {(
        [
          ["me", "Me", UserRound],
          ["college", "The college", Building2],
        ] as const
      ).map(([key, label, Icon]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => setParams(key === "me" ? {} : { tab: key }, { replace: true })}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors duration-[var(--dur-1)]",
            tab === key ? "bg-(--area) text-white" : "text-fg-muted hover:text-fg"
          )}
        >
          <Icon aria-hidden className="size-4" strokeWidth={1.75} />
          {label}
        </button>
      ))}
    </div>
  )

  const sentence =
    tab === "college"
      ? "Where the college publishes, what is rising, and who works near you."
      : mine.isLoading
        ? "Reading your record…"
        : mine.data?.headline ??
          "We'll learn your topics from your papers' keywords once your record is matched."

  return (
    <div className="page space-y-8" data-area="research">
      <HeroBand spot="spot-my-research"
        area="research"
        eyebrow="Research"
        title="My research"
        sentence={tab === "college" ? sentence : undefined}
        actions={
          <>
            {me?.id && (
              <Link
                to={`/u/${me.id}`}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-surface px-3 text-sm font-medium text-fg shadow-[inset_0_0_0_1px_var(--color-edge)] hover:bg-hover"
              >
                <UserRound aria-hidden className="size-4" strokeWidth={1.75} />
                Your public profile
              </Link>
            )}
          </>
        }
      >
        {tabs}
        {tab !== "college" && (
          <p className="mt-5 max-w-3xl font-serif text-2xl leading-snug text-fg sm:text-[28px]" aria-live="polite">
            {sentence}
          </p>
        )}
      </HeroBand>

      {tab === "college" ? <CollegeTab /> : <MeTab q={mine} />}
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
  const spark = d?.papers_by_year.slice(-8).map((p) => p.count) ?? []
  const noRecord = d && m?.papers === 0

  return (
    <>
      <StatRow className="lg:grid-cols-5">
        <StatTile
          area="research"
          icon={FileText}
          figure={m?.papers}
          label="papers in your record"
          spark={<Sparkline values={spark} label="Papers per year" />}
          to="/papers"
        />
        <StatTile
          area="research"
          icon={Quote}
          figure={m ? (m.citations ?? "—") : null}
          label={m && m.citations == null ? "Citations arrive with your Scopus record" : "citations"}
        />
        <StatTile area="research" icon={TrendingUp} figure={m ? (m.h_index ?? "—") : null} label="h-index" />
        <StatTile area="research" icon={Gem} figure={m?.q1} label="Q1 papers" />
        <StatTile area="research" icon={PenLine} figure={m?.first_author} label="as first author" />
      </StatRow>

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
    <section data-area="research" className="flex flex-col items-center gap-3 rounded-3xl bg-(--area-wash) px-6 py-10 text-center">
      <img src="/illustrations/empty-papers.svg" alt="" className="w-48 max-w-full" />
      <h2 className="text-lg font-semibold text-fg">Your record will build itself</h2>
      <p className="max-w-md text-base text-fg-muted">
        Once we match you to your Scopus or OpenAlex profile, every paper you have published appears
        here, with its citations, your topics and co-authors.
      </p>
      <Link to="/papers" className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover">
        Check my record
      </Link>
    </section>
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
    <section id={id} aria-labelledby={`${id ?? eyebrow}-h`} className="space-y-5 scroll-mt-20">
      <div>
        <p className="text-xs font-semibold text-(--area)">{eyebrow}</p>
        <SectionTitle>
          <span id={`${id ?? eyebrow}-h`} className="text-xl">
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
  const events: TimelineEvent[] = d.timeline.map((e) => ({
    date: String(e.year),
    kind: TL_KIND[e.kind] ?? "paper",
    title: e.text,
    to: e.kind === "year" ? `/papers?year=${e.year}` : undefined,
  }))
  const cites = d.citations_by_year.filter((c) => c.year >= (d.metrics.first_year ?? 0))
  const top = d.top_papers[0]
  const endYear = new Date().getFullYear()
  return (
    <Section eyebrow="Past" title="Your record">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="panel min-w-0 p-5">
          <Timeline events={events} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <div className="panel min-w-0 p-5">
            {d.metrics.citations ? (
              <Trend
                title="Citations by year of publication"
                caption="What the papers you published each year have been cited since."
                dimension="Year"
                points={cites.map((c) => ({ key: String(c.year), count: c.count }))}
                height={200}
              />
            ) : (
              <Meta>Citations arrive with your Scopus record.</Meta>
            )}
            {top && (
              <p className="mt-3 text-sm text-fg-muted">
                <Quote aria-hidden className="mr-1 inline size-4 text-(--area)" strokeWidth={1.75} />
                Most cited: <span className="font-medium text-fg">{top.title}</span> — {top.citations}{" "}
                {top.citations === 1 ? "citation" : "citations"}
              </p>
            )}
          </div>
          {d.top_papers.length > 1 && (
            <div className="panel min-w-0 p-5">
              <h3 className="text-sm font-semibold text-fg">Your most-cited papers</h3>
              <ol className="mt-3 divide-y divide-line">
                {d.top_papers.map((p) => (
                  <li key={p.id} className="flex items-start gap-3 py-2.5">
                    <span className="figure w-10 shrink-0 text-right text-lg text-(--area)">{p.citations}</span>
                    <div className="min-w-0">
                      <p className="line-clamp-2 text-sm font-medium text-fg">{p.title}</p>
                      <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                        {[p.venue, p.year].filter(Boolean).join(" · ")}
                        {p.position && <span>· author {p.position} of {p.authors}</span>}
                        {p.quartile && (
                          <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"}>{p.quartile}</Chip>
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="panel min-w-0 p-5">
            <h3 className="mb-3 text-sm font-semibold text-fg">Papers by month, last ten years</h3>
            <RecordStrip data={d.strip} endYear={endYear} label="Your papers by month" />
          </div>
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
      <TopicPicture topics={d.topics} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="panel min-w-0 p-5">
          {d.topics.length ? (
            <>
              <RankedBars
                title="Your topics"
                caption="From the topics of your own papers. Pick one to see who else works on it."
                dimension="Topic"
                points={d.topics.map((t) => ({ key: t.id, label: t.label, count: t.papers, to: topicHref(t.label) }))}
                limit={8}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {d.topics
                  .filter((t) => t.recent > 0)
                  .slice(0, 5)
                  .map((t) => (
                    <Link key={t.id} to={topicHref(t.label)} className="min-w-0 max-w-full">
                      <Chip tone="area" icon={Sparkles} className="max-w-full">
                        <span className="truncate">{t.label} · {t.recent} lately</span>
                      </Chip>
                    </Link>
                  ))}
              </div>
            </>
          ) : (
            <Meta>
              We'll learn your topics from your papers' keywords once your record is matched.{" "}
              <Link to="/papers" className="text-accent hover:underline">
                Check my record
              </Link>
            </Meta>
          )}
        </div>
        <div className="panel min-w-0 p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-fg">Who you write with</h3>
            <Link to="/collaborate" className="text-sm text-accent hover:underline">
              Who to work with
            </Link>
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            {d.coauthors.inside_count} inside the college · {d.coauthors.outside_count} outside
          </p>
          <ul className="mt-3 divide-y divide-line">
            {co.map((c) => (
              <li key={c.key} className="flex items-center gap-3 py-2">
                <Avatar person={{ name: c.name, initials: c.initials ?? initialsOf(c.name), photo_url: c.photo_url ?? null }} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">
                    {c.user_id ? (
                      <Link to={`/u/${c.user_id}`} className="hover:underline">
                        {c.name}
                      </Link>
                    ) : (
                      c.name
                    )}
                  </p>
                  <p className="truncate text-xs text-fg-muted">
                    {c.department ?? c.institutions[0] ?? "Saveetha"}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-fg-muted tabular">
                  {c.papers_together} {c.papers_together === 1 ? "paper" : "papers"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {d.venues.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-fg">Where you publish</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {d.venues.slice(0, 3).map((v) => (
              <JournalCard
                key={v.id}
                name={v.name}
                quartile={v.quartile}
                colleagues={v.colleagues}
                subjects={[`${v.papers} of yours`]}
              />
            ))}
          </div>
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
  topic: "Topic rising near you",
  venue: "A venue that fits",
  person: "A partner who completes you",
}

export function IdeaCard({ idea }: { idea: Idea }) {
  const follow = useApiMutation<{ topic: string }>("/api/follows/topics", { invalidates: [["discover"]] })
  return (
    <article
      data-area="research"
      className="flex min-w-[17rem] snap-start flex-col gap-3 rounded-2xl bg-(--area-wash) p-5 shadow-[inset_0_0_0_1px_var(--area-line)] sm:min-w-0"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-(--area)">
          <Lightbulb aria-hidden className="size-4" strokeWidth={1.75} />
          {IDEA_LABEL[idea.kind]}
        </p>
        <Chip tone={idea.source === "counted" ? "area" : "neutral"}>
          {idea.source === "counted" ? "Counted" : "Suggested by the model"}
        </Chip>
      </div>
      <h3 className="text-lg font-semibold text-fg">
        {idea.title}
        {idea.quartile && (
          <Chip tone={idea.quartile === "Q1" ? "gold" : "neutral"} className="ml-2 align-middle">
            {idea.quartile}
          </Chip>
        )}
      </h3>
      <p className="text-sm text-fg-muted">{idea.reason}</p>
      <div className="mt-auto flex flex-wrap gap-2">
        {idea.to && (
          <Link
            to={idea.to}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface px-3 text-sm text-fg shadow-[inset_0_0_0_1px_var(--color-edge)] hover:bg-hover"
          >
            {idea.kind === "person" ? "Profile" : idea.kind === "venue" ? "Journal" : "See papers"}
          </Link>
        )}
        {idea.kind === "topic" && (
          <Button
            size="sm"
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
        )}
      </div>
    </article>
  )
}

function Future({ d }: { d: MyResearch }) {
  return (
    <Section eyebrow="Future" title="Ideas for what's next">
      {d.ideas.length > 0 ? (
        <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0">
          {d.ideas.map((i) => (
            <IdeaCard key={`${i.kind}-${i.id}`} idea={i} />
          ))}
        </div>
      ) : (
        <Meta className="block">
          Ideas appear once we know your topics — from your papers, or from the topics you follow in{" "}
          <Link to="/discover" className="text-accent hover:underline">
            Discover
          </Link>
          .
        </Meta>
      )}
      <ThisYear t={d.this_year} />
      <Link to="/discover" className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
        More ideas in Discover
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </Section>
  )
}

/** docs/ux/13: "am I on track this year?", answered without typing anything. */
export function paceLine(t: MyResearch["this_year"]): string {
  if (t.papers === 0) return `No papers yet in ${t.year} — last year you had ${t.same_date_last_year} by now.`
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
  const target = t.quota ?? t.target
  const ring =
    target != null
      ? {
          metric: "PAPERS",
          label: t.quota != null ? "Research quota" : "Personal target",
          target,
          done: t.papers,
          available: true,
          fraction: target ? t.papers / target : 0,
          met: t.papers >= target,
          built_in: t.quota != null,
        }
      : null
  return (
    <div id="this-year" className="panel scroll-mt-20 p-5">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 space-y-2">
          <h3 className="text-sm font-semibold text-(--area)">This year</h3>
          <p className="text-lg font-semibold text-fg">{paceLine(t)}</p>
          <p className="text-sm text-fg-muted">
            Last year you published {t.last_year_total} in all.
            {t.under_review > 0 && (
              <>
                {" "}
                <Link to="/papers" className="inline-flex items-center gap-1 text-accent hover:underline">
                  <Hourglass aria-hidden className="size-4" strokeWidth={1.75} />
                  {t.under_review} under review
                </Link>
              </>
            )}
            {t.drafts > 0 && (
              <>
                {" · "}
                <Link to="/papers" className="text-accent hover:underline">
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
          {t.quota == null &&
            (editing ? (
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
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Papers in {t.year}
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="h-9 w-20 rounded-md bg-surface px-2 text-sm text-fg shadow-[inset_0_0_0_1px_var(--color-edge)]"
                  />
                </label>
                <Button size="md" kind="primary" type="submit" disabled={save.isPending}>
                  Save
                </Button>
              </form>
            ) : (
              <button type="button" onClick={() => setEditing(true)} className="text-sm text-accent hover:underline">
                {t.target ? "Edit target" : "Set a personal target (only you see it)"}
              </button>
            ))}
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
      <div className="panel p-6">
        <p className="display text-display text-fg">
          {college} published <span className="text-(--area)">{d.totals.papers.toLocaleString("en-IN")}</span>{" "}
          papers across {d.totals.departments} departments
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          {d.totals.people} authors here · {d.totals.citations.toLocaleString("en-IN")} citations ·{" "}
          {d.totals.this_year} papers so far this year ({d.totals.last_year} last year)
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {d.near_me.map((p) => (
              <PersonCard
                key={p.id}
                person={{ id: p.id, name: p.name, initials: initialsOf(p.name), photo_url: null, department: p.department, designation: p.designation }}
                to={`/u/${p.id}`}
                context={p.reason}
                messageTo={`/messages/${p.id}`}
              />
            ))}
          </div>
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
                share > 0.6 ? "bg-(--area) text-white" : share > 0.3 ? "bg-(--area)/70 text-white" : "bg-(--area-wash) text-fg",
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

