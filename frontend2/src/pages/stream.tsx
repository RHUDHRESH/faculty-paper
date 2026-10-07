import { useState } from "react"
import { Link } from "react-router-dom"
import { Check, MessageCircle, PartyPopper, Sprout, TrendingUp } from "lucide-react"

import { useApi } from "@/lib/query"
import { unshout } from "@/lib/names"
import { Button } from "@/ui/button"
import { DetailLink } from "@/ui/detail-sheet"
import { Avatar, PersonLink, type PersonBrief } from "@/ui/person"
import { Picture, topicPicture } from "@/ui/picture"
import { Meta } from "@/ui/text"
import { Ago } from "@/ui/when"
import { commentOn, congratulate, InlineNote, type CollegePaper } from "@/pages/college-stream"

/**
 * The cards the record writes by itself, so the feed is never an empty page on
 * a college that is publishing: a colleague's new paper (with Congratulate),
 * and who is rising this year. They sit among real posts, newest first, and
 * carry a quiet "From the record" so nobody mistakes them for something a
 * person wrote.
 */

type Rising = {
  rows: { rank: number | null; person: PersonBrief; value: number }[]
}

export function useRising(enabled = true) {
  return useApi<Rising>(["feed-rising"], "/api/leaderboard?category=rising", {
    staleTime: 10 * 60_000,
    retry: false,
    enabled,
  })
}

/** A line saying where a card came from; the badge on a post says what it is. */
export function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-sm bg-sunken px-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
      {children}
    </span>
  )
}

export function PaperEventCard({ item }: { item: CollegePaper }) {
  const [open, setOpen] = useState<"congratulate" | "comment" | null>(null)
  const [posted, setPosted] = useState<string | null>(null)
  const p = item.paper
  const meta = [p.journal_title, p.publication_year, p.quartile].filter(Boolean).join(" · ")
  return (
    <article aria-label={`New paper by ${item.owner.name}`} className="space-y-3 border-b border-line py-5">
      <header className="flex items-start gap-3">
        <Avatar person={item.owner} size="md" />
        <div className="min-w-0 flex-1">
          <PersonLink id={item.owner.id} name={item.owner.name} className="text-base" />
          <Meta className="block text-xs">
            {item.owner.department ? `${item.owner.department} · ` : ""}
            <Ago iso={item.filed_at} />
          </Meta>
        </div>
        <Badge>New paper</Badge>
      </header>
      <div className="flex gap-3 rounded-md bg-sunken px-3 py-2.5">
        <Picture
          name={topicPicture(p.title, p.journal_title) ?? "onboard-first-paper"}
          className="size-14 shrink-0 rounded-md bg-surface/60 p-1 max-sm:hidden"
        />
        <div className="min-w-0 flex-1">
          <DetailLink kind="paper" id={p.id} className="block text-sm font-medium leading-snug">
            {unshout(p.title)}
          </DetailLink>
          {meta && <Meta className="mt-0.5 block text-xs">{meta}</Meta>}
          {p.coauthors.length > 0 && (
            <Meta className="mt-0.5 block text-xs">
              With{" "}
              {p.coauthors.map((c, i) => (
                <span key={c.id}>
                  {i > 0 ? (i === p.coauthors.length - 1 ? " and " : ", ") : ""}
                  <PersonLink id={c.id} name={c.name} className="font-normal text-fg-muted" />
                </span>
              ))}
            </Meta>
          )}
        </div>
      </div>
      {posted ? (
        <p className="flex items-center gap-1.5 text-sm text-positive" role="status">
          <Check className="size-4" aria-hidden />
          Posted, and {item.owner.name} has been told.{" "}
          <Link to={`/discussions/p/${posted}`} className="text-accent underline-offset-4 hover:underline">
            See your post
          </Link>
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button kind="default" size="sm" aria-expanded={open === "congratulate"} onClick={() => setOpen(open === "congratulate" ? null : "congratulate")}>
            <PartyPopper />
            Congratulate
          </Button>
          <Button kind="quiet" size="sm" aria-expanded={open === "comment"} onClick={() => setOpen(open === "comment" ? null : "comment")}>
            <MessageCircle />
            Comment
          </Button>
        </div>
      )}
      {open && !posted && (
        <InlineNote
          key={open}
          item={item}
          draft={open === "congratulate" ? congratulate(item) : commentOn(item)}
          onCancel={() => setOpen(null)}
          onPosted={(id) => {
            setPosted(id)
            setOpen(null)
          }}
        />
      )}
    </article>
  )
}

/** "Most improved": three colleagues whose score rose most this period. Nothing when nobody has. */
export function RisingCard() {
  const rising = useRising()
  const top = (rising.data?.rows ?? []).filter((r) => r.rank != null).slice(0, 3)
  if (top.length === 0) return null
  return (
    <section aria-label="Most improved" className="border-b border-line py-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <TrendingUp className="size-4 text-fg-muted" aria-hidden /> Most improved lately
        </h3>
        <Badge>From the record</Badge>
      </div>
      <ol className="grid gap-1 sm:grid-cols-3">
        {top.map((r) => (
          <li key={r.person.id}>
            <DetailLink
              kind="person"
              id={r.person.id}
              className="flex w-full items-center gap-2.5 rounded-control bg-sunken px-3 py-2 text-sm hover:no-underline hover:bg-hover"
            >
              <Avatar person={r.person} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.person.name}</span>
                <span className="block truncate text-xs text-fg-muted">{r.person.department}</span>
              </span>
              <Sprout className="size-4 shrink-0 text-positive" aria-hidden />
            </DetailLink>
          </li>
        ))}
      </ol>
      <Link to="/leaderboard?category=rising" className="mt-2 inline-block text-sm text-accent underline-offset-4 hover:underline">
        See the leaderboard
      </Link>
    </section>
  )
}
