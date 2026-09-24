import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { BookOpen, Check, Hash, Plus, X } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import type { About } from "@/pages/feed"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input } from "@/ui/field"
import { InlineError } from "@/ui/state"
import { toast } from "@/ui/toast"

/**
 * Following subject areas and journals, beside people and departments.
 *
 * A post is about a subject area when its paper is filed under it or its
 * words name it, and about a journal when its paper appeared there or it
 * @-names it (`about_topic`, `about_journal` on the server). What you follow
 * joins your Following tab; each one is also a filter chip here, so "what is
 * everybody saying about Catalysis" is one tap.
 *
 * The subject areas are the college's own vocabulary (the 302 Scimago
 * categories, as Interests uses), so a topic followed here matches the papers.
 */

export type Follows = {
  people: { id: string; name: string }[]
  departments: string[]
  topics: string[]
  journals: string[]
}

export function useFollows() {
  return useApi<Follows>(["follows"], "/api/follows", { staleTime: 60_000 })
}

function useFollowToggle() {
  const qc = useQueryClient()
  return useMutation<unknown, ApiError, { topic?: string | null; journal?: string | null; on: boolean }>({
    mutationFn: ({ topic, journal, on }) => {
      const kind = topic ? "topics" : "journals"
      const value = (topic || journal) as string
      if (on) return api(`/api/follows/${kind}`, { method: "POST", json: topic ? { topic } : { journal } })
      const key = topic ? "topic" : "journal"
      return api(`/api/follows/${kind}?${key}=${encodeURIComponent(value)}`, { method: "DELETE" })
    },
    onSuccess: (_r, { topic, journal, on }) => {
      void qc.invalidateQueries({ queryKey: ["follows"] })
      void qc.invalidateQueries({ queryKey: ["feed", "following"] })
      toast.ok(on ? `Following ${topic || journal}` : `No longer following ${topic || journal}`)
    },
    onError: (err) => toast.fail(err),
  })
}

/** Follow or unfollow one subject area or journal. */
export function FollowTopicButton({ topic, journal }: About) {
  const follows = useFollows()
  const toggle = useFollowToggle()
  const name = topic || journal
  if (!name) return null
  const list = topic ? follows.data?.topics : follows.data?.journals
  const following = !!list?.some((t) => t.toLowerCase() === name.toLowerCase())
  return (
    <Button
      kind={following ? "default" : "primary"}
      size="sm"
      aria-pressed={following}
      disabled={follows.isPending || toggle.isPending}
      onClick={() => toggle.mutate({ topic, journal, on: !following })}
    >
      {following ? <Check /> : <Plus />}
      {following ? "Following" : "Follow"}
    </Button>
  )
}

/**
 * The strip under the feed's tabs: the topic or journal the feed is narrowed
 * to, or the ones you follow as one-tap filters, and a way to follow more.
 */
export function FollowedFilters({ about }: { about: About }) {
  const [, setParams] = useSearchParams()
  const follows = useFollows()
  const [adding, setAdding] = useState(false)

  function narrow(next: About) {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      p.delete("topic")
      p.delete("journal")
      if (next.topic) p.set("topic", next.topic)
      if (next.journal) p.set("journal", next.journal)
      return p
    })
  }

  const active = about.topic || about.journal
  if (active) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex max-w-full items-center gap-1 rounded-sm bg-accent-wash py-1 pl-2 pr-1 text-sm">
          {about.topic ? <Hash className="size-3.5 shrink-0" aria-hidden /> : <BookOpen className="size-3.5 shrink-0" aria-hidden />}
          <span className="truncate">About {active}</span>
          <button
            type="button"
            onClick={() => narrow({})}
            aria-label={`Stop showing only posts about ${active}`}
            className="rounded-sm p-0.5 text-fg-muted hover:bg-hover hover:text-fg"
          >
            <X className="size-3.5" />
          </button>
        </span>
        <FollowTopicButton topic={about.topic} journal={about.journal} />
      </div>
    )
  }

  const topics = follows.data?.topics ?? []
  const journals = follows.data?.journals ?? []
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Subject areas and journals you follow">
      {topics.map((t) => (
        <Chip key={`t-${t}`} onClick={() => narrow({ topic: t })} icon={<Hash className="size-3" aria-hidden />}>
          {t}
        </Chip>
      ))}
      {journals.map((j) => (
        <Chip key={`j-${j}`} onClick={() => narrow({ journal: j })} icon={<BookOpen className="size-3" aria-hidden />}>
          {j}
        </Chip>
      ))}
      <Button kind="quiet" size="sm" onClick={() => setAdding(true)}>
        <Plus />
        {topics.length || journals.length ? "Follow more" : "Follow a subject area or journal"}
      </Button>
      {adding && <FollowDialog onClose={() => setAdding(false)} />}
    </div>
  )
}

function Chip({ children, onClick, icon }: { children: React.ReactNode; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 max-w-[16rem] items-center gap-1 rounded-sm bg-sunken px-2 text-xs text-fg-muted",
        "transition-colors duration-[var(--dur-1)] ease-out hover:bg-hover hover:text-fg"
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  )
}

function FollowDialog({ onClose }: { onClose: () => void }) {
  const domains = useApi<{ domains: string[] }>(["research-domains"], "/api/meta/research-domains?limit=302")
  const follows = useFollows()
  const toggle = useFollowToggle()
  const [topic, setTopic] = useState<string>("")
  const [journal, setJournal] = useState("")
  const followed = new Set((follows.data?.topics ?? []).map((t) => t.toLowerCase()))
  const options = (domains.data?.domains ?? [])
    .filter((d) => !followed.has(d.toLowerCase()))
    .map((d) => ({ value: d, label: d }))

  async function save() {
    if (topic) await toggle.mutateAsync({ topic, on: true })
    if (journal.trim()) await toggle.mutateAsync({ journal: journal.trim(), on: true })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Follow a subject area or journal</DialogTitle>
          <DialogDescription>
            Posts about it join your Following tab. You can stop following it from the same chip.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Subject area">
            <Combobox
              value={topic || null}
              onChange={setTopic}
              options={options}
              placeholder="Choose a subject area"
              searchPlaceholder="Type part of a subject area…"
            />
          </Field>
          <Field label="Journal" hint="As it is spelt on the journal's own site.">
            <Input value={journal} onChange={(e) => setJournal(e.target.value)} placeholder="Ceramics International" />
          </Field>
          {toggle.error && <InlineError message={toggle.error.message} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void save()} disabled={toggle.isPending || (!topic && !journal.trim())}>
            {toggle.isPending ? "Following…" : "Follow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
