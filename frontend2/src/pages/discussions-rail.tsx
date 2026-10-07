import { Link } from "react-router-dom"

import { PeopleToFollow } from "@/pages/college-stream"
import { FollowedFilters } from "@/pages/follow-topics"
import type { About } from "@/pages/feed"
import { useApi } from "@/lib/query"
import { Meta, SectionTitle } from "@/ui/text"
import { Ago } from "@/ui/when"

/**
 * The right-hand rail of Discussions: people to follow, what you follow, and
 * the questions still waiting for an answer. On a phone it sits under the
 * feed, in the same order. A part with nothing to say draws nothing.
 */

type ThreadRow = {
  id: string
  title: string
  visibility: "PUBLIC" | "DEPARTMENT" | "OFFICE" | "DIRECT"
  last_post_at: string
  post_count: number
  resolved: boolean
}

export function useOpenQuestions() {
  const q = useApi<{ results: ThreadRow[] }>(["threads", "feed-tab"], "/api/threads?limit=50")
  const open = (q.data?.results ?? []).filter((t) => t.visibility !== "DIRECT" && !t.resolved)
  return { ...q, open }
}

export function OpenQuestions({ onSeeAll }: { onSeeAll: () => void }) {
  const q = useOpenQuestions()
  if (q.open.length === 0) return null
  return (
    <section aria-labelledby="rail-questions" className="space-y-2">
      <SectionTitle id="rail-questions">Open questions</SectionTitle>
      <ul className="divide-y divide-line">
        {q.open.slice(0, 4).map((t) => (
          <li key={t.id}>
            <Link to={`/discussions/${t.id}`} className="row block py-2">
              <span className="block text-sm font-medium leading-snug">{t.title}</span>
              <Meta className="block text-xs">
                {t.post_count === 0 ? "No answers yet" : `${t.post_count} ${t.post_count === 1 ? "reply" : "replies"}`}
                {" · "}
                <Ago iso={t.last_post_at} />
              </Meta>
            </Link>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onSeeAll}
        className="rounded-sm text-sm text-accent underline-offset-4 hover:underline"
      >
        See all questions
      </button>
    </section>
  )
}

export function Rail({ about, onSeeQuestions }: { about: About; onSeeQuestions: () => void }) {
  return (
    <div className="space-y-8">
      <OpenQuestions onSeeAll={onSeeQuestions} />
      <PeopleToFollow />
      <section aria-labelledby="rail-follows" className="space-y-2">
        <SectionTitle id="rail-follows">Topics and journals you follow</SectionTitle>
        <FollowedFilters about={about} />
      </section>
    </div>
  )
}
