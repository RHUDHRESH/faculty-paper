import { useState } from "react"
import { Link } from "react-router-dom"
import { Mail, RefreshCw, Sparkles, UserCheck, UserPlus } from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { api, ApiError } from "@/lib/api"
import { useApi } from "@/lib/query"
import { PaperCard, PostCard, type FeedPost } from "@/pages/feed"
import { Button } from "@/ui/button"
import { Avatar, PersonLink, type PersonBrief } from "@/ui/person"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * "For you": posts from people in your field, new papers from colleagues, new
 * faculty who work on what you do, and people you could write with.
 *
 * Chosen on the server by plain overlap -- subject areas, journals, skills,
 * what you follow and who you have written with -- and every item says why
 * it is here, in words. A fresh seed per visit varies the mix; "Show me
 * something else" asks for another. Nothing is promoted and nothing is paid
 * for, and the page says so.
 */

type Item =
  | { kind: "post"; why: string; post: FeedPost }
  | { kind: "paper"; why: string; paper: NonNullable<FeedPost["paper"]>; owner: PersonBrief }
  | {
      kind: "person"
      why: string
      new: boolean
      person: PersonBrief & { interests: string[]; papers: number }
    }

type ForYou = { seed: string; items: Item[]; explained: string }

function freshSeed(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function ForYouList() {
  // A new mix each time the tab is opened; the same one while it stays open.
  const [seed, setSeed] = useState(freshSeed)
  const query = useApi<ForYou>(["for-you", seed], `/api/feed/for-you?seed=${seed}`, {
    staleTime: 5 * 60_000,
  })

  if (query.isPending) return <SkeletonRows rows={4} rowHeight={120} />
  if (query.isError) {
    return (
      <ErrorState
        title="Could not put your page together"
        message="The server did not answer. The Everyone tab still has every post."
        onRetry={() => void query.refetch()}
      />
    )
  }

  const items = query.data.items
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Meta className="text-xs">{query.data.explained}</Meta>
        <Button kind="quiet" size="sm" onClick={() => setSeed(freshSeed())}>
          <RefreshCw />
          Show me something else
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing picked for you yet"
          message="This fills in from your research interests, your papers and what you follow. Add a few interests to your profile and look again."
          action={
            <Button kind="primary" size="sm" asChild>
              <Link to="/u/me">Open your profile</Link>
            </Button>
          }
        />
      ) : (
        items.map((item, i) => <ForYouItem key={`${item.kind}-${i}`} item={item} />)
      )}
    </div>
  )
}

function Why({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-fg-muted">
      <Sparkles className="size-3 shrink-0 text-accent" aria-hidden />
      {children}
    </p>
  )
}

function ForYouItem({ item }: { item: Item }) {
  if (item.kind === "post") {
    return (
      <div className="space-y-1.5">
        <Why>{item.why}</Why>
        <PostCard post={item.post} />
      </div>
    )
  }
  if (item.kind === "paper") {
    return (
      <section className="panel space-y-2 px-3 py-3 sm:px-4" aria-label="A new paper">
        <Why>{item.why}</Why>
        <div className="flex items-center gap-2">
          <Avatar person={item.owner} size="sm" />
          <p className="min-w-0 text-sm">
            <PersonLink id={item.owner.id} name={item.owner.name} /> filed a new paper
          </p>
        </div>
        <PaperCard paper={item.paper} />
      </section>
    )
  }
  return <PersonSuggestion item={item} />
}

function PersonSuggestion({ item }: { item: Extract<Item, { kind: "person" }> }) {
  const qc = useQueryClient()
  const [following, setFollowing] = useState(false)
  const follow = useMutation<unknown, ApiError, boolean>({
    mutationFn: (on) => api(`/api/follows/people/${item.person.id}`, { method: on ? "POST" : "DELETE" }),
    onMutate: (on) => setFollowing(on),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["feed", "following"] }),
    onError: (err, on) => {
      setFollowing(!on)
      toast.fail(err)
    },
  })
  const p = item.person
  return (
    <section className="panel space-y-2 px-3 py-3 sm:px-4" aria-label={item.new ? "New to the college" : "Somebody you could work with"}>
      <Why>{item.why}</Why>
      <div className="flex flex-wrap items-start gap-3">
        <Link to={`/u/${p.id}`} tabIndex={-1} aria-hidden className="shrink-0">
          <Avatar person={p} size="md" />
        </Link>
        <div className="min-w-0 flex-1">
          <PersonLink id={p.id} name={p.name} className="block truncate text-base" />
          <Meta className="block truncate text-xs">
            {[p.designation, p.department].filter(Boolean).join(" · ")}
          </Meta>
          <Meta className="mt-0.5 block truncate text-xs">
            {p.papers} paper{p.papers === 1 ? "" : "s"}
            {p.interests.length ? ` · ${p.interests.join(", ")}` : ""}
          </Meta>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button
            kind={following ? "default" : "primary"}
            size="sm"
            aria-pressed={following}
            onClick={() => follow.mutate(!following)}
          >
            {following ? <UserCheck /> : <UserPlus />}
            {following ? "Following" : "Follow"}
          </Button>
          <Button kind="default" size="sm" asChild>
            <Link to={`/messages?to=${p.id}`}>
              <Mail />
              Message
            </Link>
          </Button>
        </div>
      </div>
    </section>
  )
}
