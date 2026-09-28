import { useState } from "react"
import { Link } from "react-router-dom"
import { BookOpen, Compass, FileText, Gem, LoaderCircle, MoreHorizontal, Sparkles } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Sparkline } from "@/ui/chart"
import { Chip } from "@/ui/chip"
import { PersonCard } from "@/ui/entity"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu"
import { initialsOf } from "@/ui/person"
import { toast } from "@/ui/toast"

/**
 * Discover's For-you feed (docs/ux/06): a magazine page for one reader.
 * `/api/discover/for-you` orders it on the server — a feature direction, a
 * venue, three people or papers, repeat — and every card carries its "why".
 * Counted from the record, so it looks whole with no model at all; the one
 * model card is added here only when the institution has one switched on.
 */

export type FeedItem = {
  kind: "direction" | "venue" | "person" | "paper"
  id: string
  title: string
  why: string
  source: "counted" | "model"
  payload: Record<string, unknown>
}

export type ForYou = {
  items: FeedItem[]
  counts: { directions: number; venues: number; people: number; papers: number }
  tuned_to: string[]
  my_topics: string[]
  grounded_on: { papers: number; followed: number }
}

/* ---- "Not interested", kept on this device ---------------------------- */

const HIDDEN_KEY = "discover:hidden"

function readHidden(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[]
  } catch {
    return []
  }
}

export function useHidden() {
  const [hidden, setHidden] = useState<string[]>(readHidden)
  const hide = (id: string) => {
    const next = [...new Set([...hidden, id])]
    setHidden(next)
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next))
    } catch {
      /* private mode: hidden for this visit only */
    }
  }
  return { hidden: new Set(hidden), hide }
}

const topicHref = (q: string) => `/search?scope=topics&q=${encodeURIComponent(q)}`

function SourceChip({ source }: { source: FeedItem["source"] }) {
  return source === "counted" ? (
    <Chip tone="area">Counted</Chip>
  ) : (
    <Chip className="bg-[#6d4bc2]/10 text-[#6d4bc2] dark:text-[#b9a4f2]">
      Suggested by the model · checked against our records
    </Chip>
  )
}

function Dismiss({ onHide, label }: { onHide: () => void; label: string }) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`More about ${label}`}
        className="grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg"
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={onHide}>Not interested</MenuItem>
      </MenuContent>
    </Menu>
  )
}

function CardHead({ item, icon: Icon, label, onHide }: {
  item: FeedItem
  icon: typeof Compass
  label: string
  onHide: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon aria-hidden className="size-4 shrink-0 text-(--area)" strokeWidth={1.75} />
      <span className="text-xs font-semibold uppercase tracking-[0.06em] text-(--area)">{label}</span>
      <span className="flex-1" />
      <SourceChip source={item.source} />
      <Dismiss onHide={onHide} label={item.title} />
    </div>
  )
}

const card = "panel flex min-w-0 flex-col gap-3 p-5"

export function FollowButton({ topic }: { topic: string }) {
  const follow = useApiMutation<{ topic: string }>("/api/follows/topics", { invalidates: [["discover"]] })
  return (
    <Button
      size="md"
      disabled={follow.isPending || follow.isSuccess}
      onClick={() =>
        follow.mutate({ topic }, { onSuccess: () => toast.ok(`Following ${topic}`), onError: (e) => toast.fail(e) })
      }
    >
      {follow.isSuccess ? "Following" : "Follow"}
    </Button>
  )
}

export function DirectionCard({ item, feature, onHide }: { item: FeedItem; feature?: boolean; onHide: () => void }) {
  const p = item.payload as { papers?: number; before?: number; growth_pct?: number | null; topic?: string; spark?: number[] }
  const topic = p.topic ?? item.title
  return (
    <article
      data-area="research"
      className={cn(
        card,
        feature && "bg-(--area-wash) shadow-[inset_0_0_0_1px_var(--area-line)] sm:flex-row sm:items-center sm:gap-6"
      )}
    >
      {feature && (
        <div className="order-last shrink-0 sm:order-none">
          <img src="/illustrations/ideas.svg" alt="" className="mx-auto w-40" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <CardHead item={item} icon={Compass} label="Direction" onHide={onHide} />
        <h3 className={cn("font-semibold text-fg", feature ? "text-2xl" : "text-lg")}>{item.title}</h3>
        {p.papers != null && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <span>
              {p.papers} {p.papers === 1 ? "paper" : "papers"} here in the last 12 months
              {p.growth_pct != null && p.growth_pct > 0 ? ` (↑ ${p.growth_pct}%)` : ""}
            </span>
            {p.spark && <Sparkline values={p.spark} width={64} height={18} label={`${topic}, papers per year`} />}
          </p>
        )}
        <p className="text-sm text-fg">
          <span className="font-medium">Why you: </span>
          {item.why}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            to={topicHref(topic)}
            className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            See the papers
          </Link>
          <FollowButton topic={topic} />
        </div>
      </div>
    </article>
  )
}

export function VenueCard({ item, onHide }: { item: FeedItem; onHide: () => void }) {
  const p = item.payload as { quartile?: string | null; colleagues?: number; areas?: string[] }
  return (
    <article data-area="research" className={card}>
      <CardHead item={item} icon={BookOpen} label="Venue" onHide={onHide} />
      <h3 className="line-clamp-2 text-lg font-semibold text-fg">{item.title}</h3>
      <div className="flex flex-wrap gap-2">
        {p.quartile && (
          <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"} icon={p.quartile === "Q1" ? Gem : undefined}>
            {p.quartile}
          </Chip>
        )}
        {(p.areas ?? []).slice(0, 2).map((a) => (
          <Chip key={a} tone="area">
            {a}
          </Chip>
        ))}
      </div>
      <p className="text-sm text-fg-muted">{item.why}</p>
      <Link
        to={`/search?scope=journals&q=${encodeURIComponent(item.title)}`}
        className="mt-auto text-sm font-medium text-accent hover:underline"
      >
        Open journal
      </Link>
    </article>
  )
}

export function PersonItem({ item, onHide }: { item: FeedItem; onHide: () => void }) {
  const p = item.payload as { user_id: string; department?: string | null; designation?: string | null; affiliation?: string }
  return (
    <div className="relative min-w-0">
      <PersonCard
        className="h-full"
        person={{ id: p.user_id, name: item.title, initials: initialsOf(item.title), photo_url: null, department: p.department, designation: p.designation }}
        to={`/u/${p.user_id}`}
        affiliation={p.affiliation ?? "Saveetha"}
        context={<span className="block">{item.why}</span>}
        messageTo={`/messages/${p.user_id}`}
      />
      <div className="absolute top-3 right-3">
        <Dismiss onHide={onHide} label={item.title} />
      </div>
    </div>
  )
}

export function PaperItem({ item, onHide }: { item: FeedItem; onHide: () => void }) {
  const p = item.payload as { venue?: string | null; year?: number; quartile?: string | null; doi?: string | null }
  return (
    <article data-area="research" className={card}>
      <CardHead item={item} icon={FileText} label="Fresh paper" onHide={onHide} />
      <h3 className="line-clamp-3 font-medium text-fg">
        {p.doi ? (
          <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer" className="hover:underline">
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </h3>
      <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        {[p.venue, p.year].filter(Boolean).join(" · ")}
        {p.quartile && <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"}>{p.quartile}</Chip>}
      </p>
      <p className="text-sm text-fg-muted">{item.why}</p>
    </article>
  )
}

export function FeedCard({ item, feature, onHide }: { item: FeedItem; feature?: boolean; onHide: () => void }) {
  switch (item.kind) {
    case "direction":
      return <DirectionCard item={item} feature={feature} onHide={onHide} />
    case "venue":
      return <VenueCard item={item} onHide={onHide} />
    case "person":
      return <PersonItem item={item} onHide={onHide} />
    default:
      return <PaperItem item={item} onHide={onHide} />
  }
}

/* ---- the one model card -------------------------------------------------- */

type Direction = { topic: string; why: string; first_step: string }

/**
 * Shown only when a model is switched on, and asked only on request: a
 * model call per page view would spend the daily allowance on scrolling.
 */
export function ModelCard() {
  const [asked, setAsked] = useState(false)
  const q = useApi<{ directions: Direction[] }>(["discover", "directions"], "/api/discover/directions", {
    enabled: asked,
    retry: false,
    staleTime: 30 * 60_000,
  })
  const first = q.data?.directions[0]
  return (
    <article className="panel flex min-w-0 flex-col gap-3 p-5 shadow-[inset_0_0_0_1px_#6d4bc233]">
      <div className="flex items-center gap-2">
        <Sparkles aria-hidden className="size-4 text-[#6d4bc2] dark:text-[#b9a4f2]" strokeWidth={1.75} />
        <span className="text-xs font-semibold uppercase tracking-[0.06em] text-[#6d4bc2] dark:text-[#b9a4f2]">
          An idea
        </span>
        <span className="flex-1" />
        <SourceChip source="model" />
      </div>
      {!asked ? (
        <>
          <p className="text-sm text-fg-muted">A written suggestion, from your papers and the topics you follow.</p>
          <Button size="md" className="self-start" onClick={() => setAsked(true)}>
            Suggest something
          </Button>
        </>
      ) : q.isFetching ? (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          Thinking it through…
        </p>
      ) : first ? (
        <>
          <h3 className="text-lg font-semibold text-fg">{first.topic}</h3>
          <p className="text-sm text-fg-muted">{first.why}</p>
          <p className="text-sm text-fg">
            <span className="font-medium">First step: </span>
            {first.first_step}
          </p>
        </>
      ) : (
        <p className="text-sm text-fg-muted">
          {q.isError ? "The model did not answer this time." : "Nothing to suggest yet."}
        </p>
      )}
    </article>
  )
}
