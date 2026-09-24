import { useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Award, Check, Handshake, Pin, Plus, X } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import type { FeedPost } from "@/pages/feed"
import { PaperCard } from "@/pages/feed"
import { Button } from "@/ui/button"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, Input } from "@/ui/field"
import { Avatar, PersonLink, type PersonBrief } from "@/ui/person"
import { InlineError } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

/**
 * What a profile says beyond the record: the papers somebody chose to show
 * first, what they are good at (and who vouches for it), who they are
 * collaborating with -- and, on your own profile only, how complete it is and
 * the next concrete step for each part that is not.
 *
 * A complete profile is ranked first in people search and in suggestions,
 * because it is the one a colleague can decide from. The meter says so, once,
 * without nagging: it disappears when the profile is complete.
 */

export type Skill = {
  id: string
  name: string
  count: number
  coauthor_count: number
  endorsed_by_me: boolean
  endorsers: (PersonBrief & { coauthor: boolean })[]
  may_endorse: boolean
}

export type Collaboration = {
  id: string
  topic: string
  journal: string | null
  since: string
  with: PersonBrief[]
  may_end: boolean
}

export type Completeness = {
  score: number
  items: { key: string; label: string; done: boolean; next_step: string; action: string }[]
}

type PaperCardData = NonNullable<FeedPost["paper"]>

/* ------------------------------------------------------------------------ */
/* Completeness                                                              */
/* ------------------------------------------------------------------------ */

export function CompletenessMeter({
  completeness,
  onAction,
}: {
  completeness: Completeness
  /** "edit" opens the profile editor, "pins" the pin picker, "skills" the skill box. */
  onAction: (action: string) => void
}) {
  if (completeness.score >= 100) return null
  const todo = completeness.items.filter((i) => !i.done)
  return (
    <section aria-label="How complete your profile is" className="panel space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle className="text-base">Your profile is {completeness.score}% complete</SectionTitle>
        <Meta className="text-xs">Complete profiles come first in people search and suggestions.</Meta>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={completeness.score}
        aria-label="Profile completeness"
        className="h-2 overflow-hidden rounded-full bg-sunken"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-3)] ease-out" style={{ width: `${completeness.score}%` }} />
      </div>
      <ul className="space-y-1.5">
        {todo.map((i) => (
          <li key={i.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{i.label}.</span> <span className="text-fg-muted">{i.next_step}</span>
            </span>
            {i.action.startsWith("/") ? (
              <Button kind="quiet" size="sm" asChild>
                <Link to={i.action}>{i.key === "scopus" ? "Ask the office" : "Go"}</Link>
              </Button>
            ) : (
              <Button kind="quiet" size="sm" onClick={() => onAction(i.action)}>
                {i.key === "pinned" ? "Pin papers" : i.key === "skills" ? "Add a skill" : "Edit"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Pinned papers                                                             */
/* ------------------------------------------------------------------------ */

export function PinnedPapers({
  pinned,
  isMe,
  onChoose,
}: {
  pinned: PaperCardData[]
  isMe: boolean
  onChoose: () => void
}) {
  if (pinned.length === 0 && !isMe) return null
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>
          <Pin className="mr-1 inline size-4 align-[-2px] text-accent" aria-hidden />
          Pinned papers
        </SectionTitle>
        {isMe && (
          <Button kind="quiet" size="sm" onClick={onChoose}>
            {pinned.length ? "Change" : "Pin your best papers"}
          </Button>
        )}
      </div>
      {pinned.length === 0 ? (
        <Meta className="block">Pin up to three papers and they show here first, for everybody who opens your profile.</Meta>
      ) : (
        <div className="grid gap-2">
          {pinned.map((p) => (
            <PaperCard key={p.id} paper={p} />
          ))}
        </div>
      )}
    </section>
  )
}

export function PinDialog({
  papers,
  pinned,
  routeId,
  onClose,
}: {
  papers: { id: string; title: string; journal_title: string | null; publication_year: number | null; quartile: string | null }[]
  pinned: PaperCardData[]
  routeId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [chosen, setChosen] = useState<string[]>(pinned.map((p) => p.id))
  const save = useMutation<{ pinned: PaperCardData[] }, ApiError, void>({
    mutationFn: () => api("/api/people/me/pins", { method: "PUT", json: { paper_ids: chosen } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["person", routeId] })
      void qc.invalidateQueries({ queryKey: ["person"] })
      toast.ok(chosen.length ? "Pinned" : "Nothing pinned")
      onClose()
    },
  })
  function toggle(id: string, on: boolean) {
    setChosen((list) => (on ? (list.length >= 3 ? list : [...list, id]) : list.filter((x) => x !== id)))
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Pin your best papers</DialogTitle>
          <DialogDescription>
            Up to three, shown first on your profile in the order you tick them. {chosen.length} of 3 chosen.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          {papers.length === 0 ? (
            <Meta className="block">You have no filed papers to pin yet.</Meta>
          ) : (
            papers.map((p) => {
              const on = chosen.includes(p.id)
              return (
                <Checkbox
                  key={p.id}
                  checked={on}
                  disabled={!on && chosen.length >= 3}
                  onCheckedChange={(v) => toggle(p.id, v === true)}
                  label={p.title}
                  hint={[p.journal_title, p.publication_year, p.quartile].filter(Boolean).join(" · ")}
                />
              )
            })
          )}
          {save.error && <InlineError message={save.error.message} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Skills and endorsements                                                   */
/* ------------------------------------------------------------------------ */

export function Skills({
  skills,
  isMe,
  name,
  routeId,
  adding,
  onAdding,
}: {
  skills: Skill[]
  isMe: boolean
  name: string
  routeId: string
  adding: boolean
  onAdding: (on: boolean) => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState("")
  const refresh = () => void qc.invalidateQueries({ queryKey: ["person", routeId] })

  const add = useMutation<Skill, ApiError, string>({
    mutationFn: (skill) => api<Skill>("/api/people/me/skills", { method: "POST", json: { name: skill } }),
    onSuccess: () => {
      setDraft("")
      refresh()
    },
  })
  const remove = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api(`/api/people/me/skills/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (err) => toast.fail(err),
  })
  const endorse = useMutation<{ endorsed: boolean; count: number }, ApiError, { id: string; on: boolean }>({
    mutationFn: ({ id, on }) => api(`/api/skills/${id}/endorse`, { method: on ? "POST" : "DELETE" }),
    onMutate: ({ id, on }) => {
      qc.setQueryData<{ skills: Skill[] }>(["person", routeId], (d) =>
        d
          ? {
              ...d,
              skills: d.skills.map((s) =>
                s.id === id ? { ...s, endorsed_by_me: on, count: Math.max(0, s.count + (on ? 1 : -1)) } : s
              ),
            }
          : d
      )
    },
    onSettled: refresh,
    onError: (err) => toast.fail(err),
  })
  const [removing, setRemoving] = useState<Skill | null>(null)

  if (skills.length === 0 && !isMe) return null
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>
          <Award className="mr-1 inline size-4 align-[-2px] text-accent" aria-hidden />
          Skills
        </SectionTitle>
        {isMe && !adding && (
          <Button kind="quiet" size="sm" onClick={() => onAdding(true)}>
            <Plus />
            Add a skill
          </Button>
        )}
      </div>
      {isMe && adding && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim()) add.mutate(draft.trim())
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="X-ray diffraction"
            aria-label="A skill"
            maxLength={80}
            autoFocus
            className="min-w-0 flex-1 sm:max-w-xs"
          />
          <Button kind="primary" size="md" type="submit" disabled={!draft.trim() || add.isPending}>
            Add
          </Button>
          <Button kind="quiet" size="md" type="button" onClick={() => onAdding(false)}>
            Done
          </Button>
          {add.error && <InlineError message={add.error.message} className="w-full" />}
        </form>
      )}
      {skills.length === 0 ? (
        <Meta className="block">
          List what you are good at — a technique, an instrument, a method. Colleagues who have worked with you can
          endorse it.
        </Meta>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {skills.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <span className="min-w-0 flex-1">
                <span id={`skill-${s.id}`} className="block text-base font-medium">
                  {s.name}
                </span>
                <Meta className="block text-xs">
                  {s.count === 0
                    ? "No endorsements yet"
                    : `${s.count} endorsement${s.count === 1 ? "" : "s"}${s.coauthor_count ? `, ${s.coauthor_count} from co-authors` : ""}`}
                </Meta>
              </span>
              {s.endorsers.length > 0 && (
                <span className="flex -space-x-1.5" aria-label={`Endorsed by ${s.endorsers.map((e) => e.name).join(", ")}`}>
                  {s.endorsers.map((e) => (
                    <Link key={e.id} to={`/u/${e.id}`} title={`${e.name}${e.coauthor ? " (co-author)" : ""}`}>
                      <Avatar person={e} size="xs" className={cn("ring-2 ring-bg", e.coauthor && "ring-accent-line")} />
                    </Link>
                  ))}
                </span>
              )}
              {s.may_endorse && (
                <Button
                  kind={s.endorsed_by_me ? "default" : "quiet"}
                  size="sm"
                  aria-pressed={s.endorsed_by_me}
                  // Which skill, for a screen reader moving between several
                  // "Endorse" buttons. (A first name is not used: "Dr." is the
                  // first word of half the college's names.)
                  aria-describedby={`skill-${s.id}`}
                  title={`${s.endorsed_by_me ? "You endorsed" : "Endorse"} ${name} for ${s.name}`}
                  onClick={() => endorse.mutate({ id: s.id, on: !s.endorsed_by_me })}
                >
                  {s.endorsed_by_me ? <Check /> : <Plus />}
                  {s.endorsed_by_me ? "Endorsed" : "Endorse"}
                </Button>
              )}
              {isMe && (
                <Button kind="quiet" size="icon" aria-label={`Remove ${s.name}`} onClick={() => setRemoving(s)}>
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        danger
        title={`Remove ${removing?.name ?? "this skill"}?`}
        description="Its endorsements go with it. You can list it again, but colleagues would have to endorse it again."
        confirmLabel="Remove it"
        onConfirm={() => {
          if (removing) remove.mutate(removing.id)
          setRemoving(null)
        }}
      />
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Collaborations                                                            */
/* ------------------------------------------------------------------------ */

export function Collaborations({
  collaborations,
  routeId,
  onPropose,
}: {
  collaborations: Collaboration[]
  routeId: string
  /** Offered on somebody else's profile. */
  onPropose?: () => void
}) {
  const qc = useQueryClient()
  const [ending, setEnding] = useState<Collaboration | null>(null)
  const end = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api(`/api/collaborations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["person"] })
      toast.ok("Ended. It is off both profiles.")
    },
    onError: (err) => toast.fail(err),
  })
  if (collaborations.length === 0 && !onPropose) return null
  return (
    <section className="space-y-3" data-route={routeId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>
          <Handshake className="mr-1 inline size-4 align-[-2px] text-accent" aria-hidden />
          Collaborating on
        </SectionTitle>
        {onPropose && (
          <Button kind="quiet" size="sm" onClick={onPropose}>
            Propose a collaboration
          </Button>
        )}
      </div>
      {collaborations.length === 0 ? (
        <Meta className="block">No collaborations yet. Propose one and it lands in your messages with them.</Meta>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {collaborations.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-base font-medium">{c.topic}</span>
                <Meta className="block text-xs">
                  With{" "}
                  {c.with.map((p, i) => (
                    <span key={p.id}>
                      {i > 0 ? ", " : ""}
                      <PersonLink id={p.id} name={p.name} className="font-normal text-fg-muted" />
                    </span>
                  ))}
                  {c.journal ? ` · aiming for ${c.journal}` : ""} · since <Ago iso={c.since} />
                </Meta>
              </span>
              {c.may_end && (
                <Button kind="quiet" size="sm" onClick={() => setEnding(c)}>
                  End
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(o) => !o && setEnding(null)}
        danger
        title="End this collaboration?"
        description="It comes off both profiles and the network. Your messages with them stay."
        confirmLabel="End it"
        onConfirm={() => {
          if (ending) end.mutate(ending.id)
          setEnding(null)
        }}
      />
    </section>
  )
}
