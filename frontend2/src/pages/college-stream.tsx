import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Check, FileText, MessageCircle, PartyPopper, UserPlus } from "lucide-react"
import { useState } from "react"

import { api, ApiError } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Composer, type Candidate } from "@/ui/composer"
import { Avatar, PersonLink, type PersonBrief } from "@/ui/person"
import { InlineError, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"
import { unshout } from "@/lib/names"

/**
 * What the college has been publishing (`/api/feed/college`) and colleagues
 * worth following, on the Discussions page.
 *
 * Congratulate and Comment open a note right under the paper they are about,
 * with the words already started and the colleague already named. Pressing
 * Post puts it on the feed and tells the colleague. They used to hand a draft
 * to the composer at the top of the page, which on a long page the reader never
 * saw open: they pressed a button and nothing visibly happened.
 */

export type CollegePaper = {
  paper: {
    id: string
    title: string
    journal_title: string | null
    publication_year: number | null
    quartile: string | null
    doi: string | null
    coauthors: { id: string; name: string }[]
  }
  owner: PersonBrief
  filed_at: string
}

type College = { papers: CollegePaper[]; people: (PersonBrief & { papers: number })[] }

export type Draft = { text: string; people: { id: string; name: string }[] }

/** Papers shown before "Show more"; the rest are one press away. */
const FIRST_PAPERS = 5

function mention(name: string) {
  return `@user:"${name}"`
}

export function congratulate(p: CollegePaper): Draft {
  const where = [p.paper.journal_title, p.paper.publication_year].filter(Boolean).join(", ")
  return {
    text: `Congratulations ${mention(p.owner.name)} on “${p.paper.title}”${where ? ` in ${where}` : ""}! `,
    people: [{ id: p.owner.id, name: p.owner.name }],
  }
}

export function commentOn(p: CollegePaper): Draft {
  return {
    text: `${mention(p.owner.name)}, about “${p.paper.title}”: `,
    people: [{ id: p.owner.id, name: p.owner.name }],
  }
}

export function useCollege() {
  return useApi<College>(["feed-college"], "/api/feed/college", { staleTime: 5 * 60_000, retry: false })
}

type Open = { id: string; kind: "congratulate" | "comment" }

export function CollegePapers() {
  const college = useCollege()
  const [open, setOpen] = useState<Open | null>(null)
  const [posted, setPosted] = useState<Record<string, string>>({})
  const [all, setAll] = useState(false)
  if (college.isPending) return <SkeletonRows rows={3} rowHeight={72} />
  // A failed load is not "nothing new": say what failed, and let the reader retry.
  if (college.isError) return <InlineError message="Could not load the college's new papers." onRetry={() => void college.refetch()} />
  const papers = college.data?.papers ?? []
  if (papers.length === 0) return null
  const shown = all ? papers : papers.slice(0, FIRST_PAPERS)
  return (
    <section aria-labelledby="college-new" className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <SectionTitle id="college-new">New from the college</SectionTitle>
        <Meta className="text-xs">Papers colleagues have published lately</Meta>
      </div>
      <ul className="divide-y divide-line">
        {shown.map((p) => {
          const mine = open?.id === p.paper.id ? open.kind : null
          return (
            <li key={p.paper.id} className="flex gap-3 py-4">
              <Avatar person={p.owner} size="md" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <PersonLink id={p.owner.id} name={p.owner.name} className="font-medium" />
                  <Meta className="text-sm">
                    {" "}
                    published a paper
                    {p.owner.department ? ` · ${p.owner.department}` : ""} · <Ago iso={p.filed_at} />
                  </Meta>
                </p>
                <div className="mt-2 flex gap-2.5 rounded-control bg-sunken/60 px-3 py-2.5">
                  <FileText className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-sm font-medium leading-snug">
                      {p.paper.doi ? (
                        <a
                          href={`https://doi.org/${p.paper.doi}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {unshout(p.paper.title)}
                        </a>
                      ) : (
                        unshout(p.paper.title)
                      )}
                    </p>
                    <Meta className="mt-0.5 block truncate text-xs">
                      {[p.paper.journal_title, p.paper.publication_year, p.paper.quartile].filter(Boolean).join(" · ")}
                    </Meta>
                  </div>
                </div>
                {p.paper.coauthors.length > 0 && (
                  <p className="mt-1.5 text-xs text-fg-muted">
                    With{" "}
                    {p.paper.coauthors.map((c, i) => (
                      <span key={c.id}>
                        {i > 0 && (i === p.paper.coauthors.length - 1 ? " and " : ", ")}
                        <PersonLink id={c.id} name={c.name} />
                      </span>
                    ))}
                  </p>
                )}
                {posted[p.paper.id] ? (
                  <p className="mt-2 flex items-center gap-1.5 text-sm text-positive" role="status">
                    <Check className="size-4" aria-hidden />
                    Posted to the feed, and {p.owner.name} has been told.{" "}
                    <Link to={`/discussions/p/${posted[p.paper.id]}`} className="text-accent underline-offset-4 hover:underline">
                      See your post
                    </Link>
                  </p>
                ) : (
                  <div className="-ml-2 mt-1.5 flex flex-wrap gap-1">
                    <Button
                      kind="quiet"
                      size="sm"
                      aria-expanded={mine === "congratulate"}
                      
                      onClick={() => setOpen(mine === "congratulate" ? null : { id: p.paper.id, kind: "congratulate" })}
                    >
                      <PartyPopper />
                      Congratulate
                    </Button>
                    <Button
                      kind="quiet"
                      size="sm"
                      aria-expanded={mine === "comment"}
                      
                      onClick={() => setOpen(mine === "comment" ? null : { id: p.paper.id, kind: "comment" })}
                    >
                      <MessageCircle />
                      Comment
                    </Button>
                  </div>
                )}
                {mine && !posted[p.paper.id] && (
                  <InlineNote
                    // A new box when the reader switches between the two, so its words restart.
                    key={mine}
                    item={p}
                    draft={mine === "congratulate" ? congratulate(p) : commentOn(p)}
                    onCancel={() => setOpen(null)}
                    onPosted={(postId) => {
                      setPosted((m) => ({ ...m, [p.paper.id]: postId }))
                      setOpen(null)
                    }}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {papers.length > FIRST_PAPERS && (
        <div className="pt-1">
          <Button kind="quiet" size="sm" aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer papers" : `Show ${papers.length - FIRST_PAPERS} more papers`}
          </Button>
        </div>
      )}
    </section>
  )
}

/** The people picked from the @ menu whose names are still in the words. */
function namedIds(text: string, picked: Candidate[]): string[] {
  const lower = text.toLowerCase()
  return [...new Set(picked.filter((c) => c.kind === "USER" && lower.includes(c.label.toLowerCase())).map((c) => c.id))]
}

/**
 * The note under a paper. It is a real post on the feed that names the
 * colleague, so it says so above the box; a private word is a Message, offered
 * beside it. A failed post keeps what was typed.
 */
function InlineNote({
  item,
  draft,
  onCancel,
  onPosted,
}: {
  item: CollegePaper
  draft: Draft
  onCancel: () => void
  onPosted: (postId: string) => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState(draft.text)
  const [picked, setPicked] = useState<Candidate[]>(() =>
    draft.people.map((p) => ({ kind: "USER", id: p.id, label: p.name, hint: null }))
  )
  const post = useMutation<{ id: string }, ApiError, void>({
    mutationFn: () => {
      const body = text.trim()
      const form = new FormData()
      form.set("body", body)
      form.set("visibility", "EVERYONE")
      for (const id of namedIds(body, picked)) form.append("mention_ids", id)
      // A multipart body is the one shape `api()`'s options type omits; it
      // still goes through `api()` so the CSRF header is attached.
      return api<{ id: string }>("/api/feed/posts", { method: "POST", body: form } as unknown as Parameters<typeof api>[1])
    },
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ["feed"] })
      toast.ok(`Posted. ${item.owner.name} has been told.`)
      onPosted(created.id)
    },
    onError: (err) => toast.fail(err),
  })
  const first = item.owner.name
  return (
    <div className="mt-2 space-y-2 rounded-control bg-sunken/60 p-3" role="group" aria-label={`A note about ${item.paper.title}`}>
      <Meta className="block text-xs">
        Everybody can read this on the feed, and {first} is told. To say it in private,{" "}
        <Link to={`/messages?to=${item.owner.id}`} className="text-accent underline-offset-4 hover:underline">
          send a message
        </Link>
        .
      </Meta>
      <Composer
        value={text}
        onChange={setText}
        onPick={(c) => setPicked((list) => [...list, c])}
        onSend={() => text.trim() && post.mutate()}
        canSend={!!text.trim() && !post.isPending}
        busy={post.isPending}
        label={`Your note to ${first}`}
        hideLabel
        rows={2}
        maxRows={8}
        menu="below"
        offer={["USER", "DEPARTMENT", "JOURNAL"]}
        placeholder={`Write to ${first}`}
        prompt="Keep typing a colleague's name."
        autoFocus
        toolbar={
          <Button kind="quiet" size="sm" type="button" onClick={onCancel} disabled={post.isPending}>
            Cancel
          </Button>
        }
      />
    </div>
  )
}

export function PeopleToFollow() {
  const college = useCollege()
  const people = college.data?.people ?? []
  if (people.length === 0) return null
  return (
    <section aria-labelledby="college-people" className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle id="college-people">People to follow</SectionTitle>
        <Link to="/u" className="text-sm text-fg-muted hover:text-fg hover:underline">
          Find people
        </Link>
      </div>
      <ul className="divide-y divide-line">
        {people.map((p) => (
          <li key={p.id}>
            <FollowRow person={p} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function FollowRow({ person }: { person: PersonBrief & { papers: number } }) {
  const qc = useQueryClient()
  const [following, setFollowing] = useState(false)
  const follow = useMutation({
    mutationFn: () => api(`/api/follows/people/${person.id}`, { method: "POST" }),
    onMutate: () => setFollowing(true),
    onError: (err: Error) => {
      setFollowing(false)
      toast.fail(err)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["feed", "following"] }),
  })
  return (
    <div className="flex items-center gap-3 py-3">
      <Link to={`/u/${person.id}`} tabIndex={-1} aria-hidden className="shrink-0">
        <Avatar person={person} size="md" />
      </Link>
      <div className="min-w-0 flex-1">
        <PersonLink id={person.id} name={person.name} className="block truncate text-sm" />
        <Meta className="block break-words text-xs">
          {[person.department, `${person.papers} paper${person.papers === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
        </Meta>
      </div>
      <Button
        kind={following ? "quiet" : "default"}
        size="sm"
        className="shrink-0"
        disabled={following}
        aria-label={following ? `Following ${person.name}` : `Follow ${person.name}`}
        onClick={() => follow.mutate()}
      >
        {following ? <Check /> : <UserPlus />}
        {following ? "Following" : "Follow"}
      </Button>
    </div>
  )
}
