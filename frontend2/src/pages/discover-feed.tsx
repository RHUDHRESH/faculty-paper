import { useState } from "react"
import { Link } from "react-router-dom"
import { BookOpen, Compass, FileText, Gem, LoaderCircle, MoreHorizontal, Sparkles } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Sparkline } from "@/ui/chart"
import { Chip } from "@/ui/chip"
import { DetailLink } from "@/ui/detail-sheet"
import { PersonCard } from "@/ui/entity"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu"
import { Avatar, initialsOf } from "@/ui/person"
import { Picture, topicPicture } from "@/ui/picture"
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

/* ---- "Not interested", kept on the server (POST /api/discover/dismiss) -- */

type DismissBody = { kind: string; id: string; undo?: boolean }

export function useHidden() {
  const [hidden, setHidden] = useState<string[]>([])
  const dismiss = useApiMutation<DismissBody>("/api/discover/dismiss", { invalidates: [["discover"]] })
  const hide = (item: Pick<FeedItem, "kind" | "id" | "title">) => {
    setHidden((h) => [...new Set([...h, item.id])])
    dismiss.mutate(
      { kind: item.kind, id: item.id },
      {
        onSuccess: () =>
          toast.undoable(`Hid ${item.title}`, () => {
            setHidden((h) => h.filter((x) => x !== item.id))
            dismiss.mutate({ kind: item.kind, id: item.id, undo: true }, { onError: (e) => toast.fail(e) })
          }),
        onError: (e) => {
          setHidden((h) => h.filter((x) => x !== item.id))
          toast.fail(e)
        },
      }
    )
  }
  return { hidden: new Set(hidden), hide }
}

const topicHref = (q: string) => `/search?scope=topics&q=${encodeURIComponent(q)}`

function SourceChip({ source }: { source: FeedItem["source"] }) {
  return source === "counted" ? (
    null
  ) : (
    <Chip className="h-auto min-h-6 max-w-full shrink whitespace-normal bg-accent-wash py-0.5 text-accent">
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
      <span className="text-sm font-medium text-(--area)">{label}</span>
      <span className="flex-1" />
      <SourceChip source={item.source} />
      <Dismiss onHide={onHide} label={item.title} />
    </div>
  )
}

const card = "panel flex min-w-0 flex-col gap-3 p-5"
const row = "flex min-w-0 flex-col gap-3"

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

export function DirectionCard({ item, feature, onHide, plain }: { item: FeedItem; feature?: boolean; onHide: () => void; plain?: boolean }) {
  const p = item.payload as { papers?: number; before?: number; growth_pct?: number | null; topic?: string; spark?: number[] }
  const topic = p.topic ?? item.title
  return (
    <article
      data-area="research"
      className={cn(
        plain ? row : card,
        feature && "bg-(--area-wash) shadow-[inset_0_0_0_1px_var(--area-line)] sm:flex-row sm:items-center sm:gap-6"
      )}
    >
      {feature && (
        <div className="order-last shrink-0 sm:order-none">
          <Picture name={topicPicture(topic) ?? "discover-ideas"} className="mx-auto w-44" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <CardHead item={item} icon={Compass} label="Direction" onHide={onHide} />
        <h3 className={cn("font-semibold text-fg", "text-lg")}>{item.title}</h3>
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
          <Button asChild kind="default" className="h-8 rounded-md px-3 text-sm font-medium">
            <Link to={topicHref(topic)}>See the papers</Link>
          </Button>
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
      <h3 className="line-clamp-2 text-lg font-semibold text-fg"><DetailLink kind="journal" name={item.title} /></h3>
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

/** A venue as one row of a hairline list (the For you page): journal, quartile, why, and the way in. */
export function VenueRow({ item, onHide }: { item: FeedItem; onHide: () => void }) {
  const p = item.payload as { quartile?: string | null; colleagues?: number; areas?: string[] }
  return (
    <article data-area="research" className="flex min-w-0 items-start gap-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-fg"><DetailLink kind="journal" name={item.title} /></h3>
          {p.quartile && (
            <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"} icon={p.quartile === "Q1" ? Gem : undefined}>
              {p.quartile}
            </Chip>
          )}
        </div>
        <p className="text-sm text-fg-muted">{item.why}</p>
        {(p.areas ?? []).length > 0 && (
          <p className="flex flex-wrap gap-1.5">
            {(p.areas ?? []).slice(0, 2).map((a) => (
              <Chip key={a} tone="area">
                {a}
              </Chip>
            ))}
          </p>
        )}
      </div>
      <Link
        to={`/search?scope=journals&q=${encodeURIComponent(item.title)}`}
        className="mt-1 shrink-0 text-sm font-medium text-accent hover:underline"
      >
        Open journal
      </Link>
      <Dismiss onHide={onHide} label={item.title} />
    </article>
  )
}

export function PersonItem({ item, onHide }: { item: FeedItem; onHide: () => void }) {
  const p = item.payload as { user_id: string; photo_url?: string | null; department?: string | null; designation?: string | null; affiliation?: string }
  return (
    <div className="relative min-w-0">
      <PersonCard
        className="h-full"
        person={{ id: p.user_id, name: item.title, initials: (p as { initials?: string }).initials ?? initialsOf(item.title), photo_url: p.photo_url ?? null, department: p.department, designation: p.designation }}
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

export function PaperItem({ item, onHide, plain }: { item: FeedItem; onHide: () => void; plain?: boolean }) {
  const p = item.payload as {
    venue?: string | null
    year?: number
    quartile?: string | null
    doi?: string | null
    people?: { user_id: string; name: string; initials?: string; photo_url?: string | null }[]
  }
  const people = p.people ?? []
  return (
    <article data-area="research" className={plain ? row : card}>
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
      {people.length > 0 && (
        <div className="mt-auto flex items-center gap-2">
          <div className="flex -space-x-2">
            {people.map((a) => (
              <Link key={a.user_id} to={`/u/${a.user_id}`} title={a.name} className="rounded-full ring-2 ring-surface">
                <Avatar person={{ name: a.name, initials: a.initials || initialsOf(a.name), photo_url: a.photo_url ?? null }} size="sm" />
              </Link>
            ))}
          </div>
          <span className="truncate text-sm text-fg-muted">{people.map((a) => a.name).join(", ")}</span>
        </div>
      )}
    </article>
  )
}

/** A feed item as one row of a hairline list (the Directions and Fresh papers tabs). */
export function FeedRow({ item, onHide }: { item: FeedItem; onHide: () => void }) {
  switch (item.kind) {
    case "direction":
      return <DirectionCard item={item} onHide={onHide} plain />
    case "venue":
      return <VenueRow item={item} onHide={onHide} />
    case "person":
      return <PersonLine item={item} onHide={onHide} />
    default:
      return <PaperItem item={item} onHide={onHide} plain />
  }
}

/** A colleague as one line of a hairline list: face, name, why, and the way out. */
function PersonLine({ item, onHide }: { item: FeedItem; onHide: () => void }) {
  const p = item.payload as { user_id: string; initials?: string; photo_url?: string | null }
  return (
    <article data-area="people" className="flex min-w-0 items-center gap-3">
      <Avatar person={{ name: item.title, initials: p.initials || initialsOf(item.title), photo_url: p.photo_url ?? null }} size="sm" />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-medium text-fg">
          <Link to={`/u/${p.user_id}`} className="underline-offset-4 hover:underline">
            {item.title}
          </Link>
        </h3>
        <p className="truncate text-sm text-fg-muted">{item.why}</p>
      </div>
      <Dismiss onHide={onHide} label={item.title} />
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
    <article className="panel flex min-w-0 flex-col gap-3 p-5 ring-1 ring-line">
      <div className="flex items-center gap-2">
        <Sparkles aria-hidden className="size-4 text-accent" strokeWidth={1.75} />
        <span className="text-sm font-medium text-accent">
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
