import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Heart, MessageCircle } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import type { FeedPost } from "@/pages/feed"
import { patchPost } from "@/pages/feed-cache"
import { Button } from "@/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog"
import { Avatar, PersonLink, type PersonBrief } from "@/ui/person"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * Reactions beyond a like: the three a college has a use for.
 *
 * 👏 Congrats, 🔬 Interested, 🤝 Want to collaborate — each counted on its
 * own, each one per person, and a person may give more than one (liking a
 * post and wanting to work on it are different things to say). 🤝 is the one
 * that does something: it opens a message to the author with the post
 * already referred to, because saying "I'd like to collaborate" and then
 * having to go and find how to say it is where a collaboration dies.
 *
 * Who reacted is one click away, for anybody who can read the post.
 */

export type ReactionKind = "LIKE" | "CONGRATS" | "INTERESTED" | "COLLABORATE"

export const REACTIONS: { kind: ReactionKind; emoji: string | null; label: string; pressed: string }[] = [
  { kind: "LIKE", emoji: null, label: "Like", pressed: "Liked" },
  { kind: "CONGRATS", emoji: "👏", label: "Congrats", pressed: "Congratulated" },
  { kind: "INTERESTED", emoji: "🔬", label: "Interested", pressed: "Interested" },
  { kind: "COLLABORATE", emoji: "🤝", label: "Want to collaborate", pressed: "Want to collaborate" },
]

const EMPTY: Record<ReactionKind, number> = { LIKE: 0, CONGRATS: 0, INTERESTED: 0, COLLABORATE: 0 }

/** The counts, from the server's `reactions`, or the old `like_count` for a post drawn before it answered. */
export function countsOf(post: Pick<FeedPost, "reactions" | "like_count">): Record<ReactionKind, number> {
  return { ...EMPTY, ...(post.reactions ?? { LIKE: post.like_count }) }
}

export function mineOf(post: Pick<FeedPost, "my_reactions" | "liked">): ReactionKind[] {
  return post.my_reactions ?? (post.liked ? ["LIKE"] : [])
}

type State = Pick<FeedPost, "reactions" | "my_reactions" | "like_count" | "liked">

function toggled(p: FeedPost, kind: ReactionKind, on: boolean): FeedPost {
  const counts = countsOf(p)
  const mine = new Set(mineOf(p))
  if (on === mine.has(kind)) return p
  counts[kind] = Math.max(0, counts[kind] + (on ? 1 : -1))
  if (on) mine.add(kind)
  else mine.delete(kind)
  return { ...p, reactions: counts, my_reactions: [...mine], like_count: counts.LIKE, liked: mine.has("LIKE") }
}

export function ReactionBar({
  post,
  isMine,
  disabled,
  onComment,
}: {
  post: FeedPost
  /** Your own post: you cannot ask yourself to collaborate. */
  isMine: boolean
  disabled?: boolean
  onComment: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [who, setWho] = useState(false)
  const counts = countsOf(post)
  const mine = new Set(mineOf(post))

  const react = useMutation<State, ApiError, { kind: ReactionKind; on: boolean }>({
    mutationFn: ({ kind, on }) =>
      api<State>(`/api/feed/posts/${post.id}/reactions/${kind.toLowerCase()}`, { method: on ? "POST" : "DELETE" }),
    onMutate: ({ kind, on }) => patchPost(qc, post.id, (p) => toggled(p, kind, on)),
    onSuccess: (state) => patchPost(qc, post.id, (p) => ({ ...p, ...state })),
    onError: (err, { kind, on }) => {
      patchPost(qc, post.id, (p) => toggled(p, kind, !on))
      toast.fail(err)
    },
  })

  function press(kind: ReactionKind) {
    const on = !mine.has(kind)
    react.mutate({ kind, on })
    if (kind === "COLLABORATE" && on && post.author) {
      // The point of saying it: a message to the author, about this post.
      navigate(`/messages?to=${post.author.id}&ref=${post.id}`)
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const shown = REACTIONS.filter((r) => !(isMine && r.kind === "COLLABORATE"))

  return (
    <div className="space-y-1.5 border-t border-line pt-2">
      {total > 0 && (
        <button
          type="button"
          onClick={() => setWho(true)}
          className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted hover:text-fg hover:underline"
          aria-label={`See who reacted: ${REACTIONS.filter((r) => counts[r.kind])
            .map((r) => `${counts[r.kind]} ${r.label.toLowerCase()}`)
            .join(", ")}`}
        >
          {REACTIONS.filter((r) => counts[r.kind] > 0).map((r) => (
            <span key={r.kind} className="inline-flex items-center gap-0.5 tabular">
              {r.emoji ?? <Heart className="size-3 fill-current text-accent" aria-hidden />} {counts[r.kind]}
            </span>
          ))}
          <span>· who reacted</span>
        </button>
      )}
      <div className="flex flex-wrap items-center gap-0.5">
        {shown.map((r) => {
          const on = mine.has(r.kind)
          return (
            <Button
              key={r.kind}
              kind="quiet"
              size="sm"
              aria-pressed={on}
              aria-label={r.label}
              title={r.label}
              disabled={disabled}
              onClick={() => press(r.kind)}
              className={cn("px-2", on && "bg-accent-wash text-accent hover:text-accent")}
            >
              {r.emoji ? (
                <span aria-hidden className="text-base leading-none">
                  {r.emoji}
                </span>
              ) : (
                <Heart className={cn(on && "fill-current")} />
              )}
              <span className={cn(r.kind === "LIKE" ? "hidden sm:inline" : "hidden lg:inline")}>
                {on ? r.pressed : r.label}
              </span>
            </Button>
          )
        })}
        <Button kind="quiet" size="sm" disabled={disabled} onClick={onComment} className="px-2">
          <MessageCircle />
          <span className="hidden sm:inline">Comment</span>
          {post.comment_count > 0 && <span className="tabular">{post.comment_count}</span>}
        </Button>
      </div>
      {who && <WhoReacted postId={post.id} onClose={() => setWho(false)} />}
    </div>
  )
}

type Reactor = { kind: ReactionKind; person: PersonBrief; at: string }

function WhoReacted({ postId, onClose }: { postId: string; onClose: () => void }) {
  const [filter, setFilter] = useState<ReactionKind | null>(null)
  const query = useApi<{ results: Reactor[]; counts: Record<ReactionKind, number> }>(
    ["reactions", postId],
    `/api/feed/posts/${postId}/reactions`
  )
  const rows = (query.data?.results ?? []).filter((r) => !filter || r.kind === filter)
  const byKind = Object.fromEntries(REACTIONS.map((r) => [r.kind, r])) as Record<ReactionKind, (typeof REACTIONS)[number]>

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Who reacted</DialogTitle>
          <DialogDescription>Everybody who can read this post can see this list.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div role="tablist" aria-label="Which reaction" className="flex flex-wrap gap-1">
            <FilterChip on={filter === null} onClick={() => setFilter(null)}>
              All
            </FilterChip>
            {REACTIONS.filter((r) => (query.data?.counts[r.kind] ?? 0) > 0).map((r) => (
              <FilterChip key={r.kind} on={filter === r.kind} onClick={() => setFilter(r.kind)}>
                {r.emoji ?? "♥"} {r.label} <span className="tabular">{query.data?.counts[r.kind]}</span>
              </FilterChip>
            ))}
          </div>
          {query.isPending ? (
            <SkeletonRows rows={3} rowHeight={40} />
          ) : query.isError ? (
            <ErrorState
              title="Could not load who reacted"
              message="The server did not answer. The reactions are still there."
              onRetry={() => void query.refetch()}
            />
          ) : (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={`${r.person.id}-${r.kind}`} className="flex items-center gap-3">
                  <Avatar person={r.person} size="sm" />
                  <span className="min-w-0 flex-1">
                    <PersonLink id={r.person.id} name={r.person.name} className="block truncate text-sm" />
                    <Meta className="block truncate text-xs">{r.person.department}</Meta>
                  </span>
                  <span className="shrink-0 text-sm" title={byKind[r.kind]?.label}>
                    {byKind[r.kind]?.emoji ?? <Heart className="size-4 fill-current text-accent" aria-label="Like" />}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={cn(
        "h-7 rounded-sm px-2 text-xs font-medium transition-colors duration-[var(--dur-1)] ease-out",
        on ? "bg-accent-wash text-fg" : "bg-sunken text-fg-muted hover:text-fg"
      )}
    >
      {children}
    </button>
  )
}
