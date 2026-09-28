import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Check, FileText, MessageCircle, PartyPopper, UserPlus } from "lucide-react"
import { useState } from "react"

import { api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Avatar, PersonLink, type PersonBrief } from "@/ui/person"
import { SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

/**
 * The Discussions page before anybody has posted, and beside the posts after:
 * what the college has been publishing (`/api/feed/college`) and colleagues
 * worth following. Congratulate and Comment do not post anything themselves;
 * they hand the composer a drafted post naming the colleague, and the reader
 * presses Post.
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

export function CollegePapers({ onDraft }: { onDraft: (d: Draft) => void }) {
  const college = useCollege()
  if (college.isPending) return <SkeletonRows rows={3} rowHeight={72} />
  const papers = college.data?.papers ?? []
  if (college.isError || papers.length === 0) return null
  return (
    <section aria-labelledby="college-new" className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="college-new" className="text-base font-semibold">
          New from the college
        </h2>
        <Meta className="text-xs">Papers colleagues filed lately</Meta>
      </div>
      <ul className="divide-y divide-line">
        {papers.map((p) => (
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
              <div className="mt-2 flex gap-2.5 rounded-lg bg-sunken/60 px-3 py-2.5">
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
                        {p.paper.title}
                      </a>
                    ) : (
                      p.paper.title
                    )}
                  </p>
                  <Meta className="mt-0.5 block truncate text-xs">
                    {[p.paper.journal_title, p.paper.publication_year, p.paper.quartile].filter(Boolean).join(" · ")}
                  </Meta>
                </div>
              </div>
              <div className="-ml-2 mt-1.5 flex gap-1">
                <Button kind="quiet" size="sm" onClick={() => onDraft(congratulate(p))}>
                  <PartyPopper />
                  Congratulate
                </Button>
                <Button kind="quiet" size="sm" onClick={() => onDraft(commentOn(p))}>
                  <MessageCircle />
                  Comment
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function PeopleToFollow() {
  const college = useCollege()
  const people = college.data?.people ?? []
  if (people.length === 0) return null
  return (
    <section aria-labelledby="college-people" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="college-people" className="text-base font-semibold">
          People to follow
        </h2>
        <Link to="/u" className="text-sm text-fg-muted hover:text-fg hover:underline">
          Find people
        </Link>
      </div>
      <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {people.map((p) => (
          <li key={p.id} className="w-36 shrink-0">
            <FollowCard person={p} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function FollowCard({ person }: { person: PersonBrief & { papers: number } }) {
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
    <div className="flex h-full flex-col items-center gap-1 rounded-xl border border-line bg-surface px-2 pb-3 pt-4 text-center">
      <Link to={`/u/${person.id}`} className="flex flex-col items-center gap-2">
        <Avatar person={person} size="lg" />
        <span className="line-clamp-2 text-sm font-medium leading-tight hover:underline">{person.name}</span>
      </Link>
      <Meta className="block w-full truncate text-xs">
        {person.papers} paper{person.papers === 1 ? "" : "s"}
        {person.department ? ` · ${person.department}` : ""}
      </Meta>
      <Button
        kind={following ? "quiet" : "default"}
        size="sm"
        className="mt-auto"
        disabled={following}
        onClick={() => follow.mutate()}
      >
        {following ? <Check /> : <UserPlus />}
        {following ? "Following" : "Follow"}
      </Button>
    </div>
  )
}
