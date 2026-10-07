import { useState } from "react"
import { Link } from "react-router-dom"
import { BookOpen, CalendarPlus, Compass, FileText, Gauge, MessageCircle, Send, Target, UserRound } from "lucide-react"

import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Input } from "@/ui/field"
import { InlineError } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { useDetail } from "@/ui/detail-sheet"
import {
  evidenceDetail,
  evidenceHref,
  progressLine,
  type Action,
  type AskAnswer,
  type CompassSummary,
  type DeadlineRef,
  type Evidence,
  type GoalRef,
  type JournalRef,
  type PersonRef,
  type TopicRef,
} from "@/pages/compass-model"

/* ------------------------------------------------------------------------ */
/* Evidence                                                                  */
/* ------------------------------------------------------------------------ */

const EVIDENCE_ICON = { paper: FileText, journal: BookOpen, person: UserRound, metric: Gauge } as const

export function EvidenceChips({ items, className }: { items: Evidence[]; className?: string }) {
  const { open } = useDetail()
  if (!items.length) return null
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)} aria-label="Evidence">
      {items.map((e) => {
        const detail = evidenceDetail(e)
        const to = evidenceHref(e)
        const chip = (
          <Chip icon={EVIDENCE_ICON[e.kind]} className="max-w-[18rem]">
            <span className="truncate">{e.label}</span>
          </Chip>
        )
        return (
          <li key={`${e.kind}-${e.id}-${e.label}`} className="min-w-0">
            {detail ? (
              <button
                type="button"
                onClick={() => open(detail)}
                className="cursor-pointer rounded-full hover:brightness-95"
              >
                {chip}
              </button>
            ) : to ? (
              <Link to={to} className="rounded-full hover:brightness-95">
                {chip}
              </Link>
            ) : (
              chip
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The quiet note under anything written from the record alone. */
export function CountedNote({ counted }: { counted?: boolean }) {
  if (!counted) return null
  return <Meta className="block">Written from your record. AI is off right now.</Meta>
}

/* ------------------------------------------------------------------------ */
/* One action in the plan                                                    */
/* ------------------------------------------------------------------------ */

/** The step's own button. Doing what it says (setting the goal, following the
 *  topic, adding the date) ticks the step too: nobody should have to do a
 *  thing and then also report having done it. */
export function ActionButtons({ action, onDone }: { action: Action; onDone?: () => void }) {
  if (action.kind === "journal") {
    const r = action.ref as JournalRef
    return (
      <Button size="sm" asChild>
        <Link to={`/search?scope=journals&q=${encodeURIComponent(r.name)}`}>
          <BookOpen />
          See the journal
        </Link>
      </Button>
    )
  }
  if (action.kind === "person") {
    const r = action.ref as PersonRef
    const intro = `Hello ${r.name}, I have been reading your work and think our papers sit close together. Would you like to talk about writing something together?`
    return (
      <>
        <Button size="sm" asChild>
          <Link to={`/messages?to=${encodeURIComponent(r.user_id)}`}>
            <MessageCircle />
            Message
          </Link>
        </Button>
        <Button size="sm" kind="quiet" asChild>
          <Link to={`/messages?to=${encodeURIComponent(r.user_id)}&draft=${encodeURIComponent(intro)}`}>Draft an intro</Link>
        </Button>
      </>
    )
  }
  if (action.kind === "topic") return <FollowTopic name={(action.ref as TopicRef).name} onDone={onDone} />
  if (action.kind === "goal") return <SetGoal goal={action.ref as GoalRef} onDone={onDone} />
  return <AddDeadline d={action.ref as DeadlineRef} onDone={onDone} />
}

function FollowTopic({ name, onDone }: { name: string; onDone?: () => void }) {
  const follow = useApiMutation<{ topic: string }>("/api/follows/topics", { invalidates: [["discover"]] })
  return (
    <Button
      size="sm"
      disabled={follow.isPending || follow.isSuccess}
      onClick={() =>
        follow.mutate({ topic: name }, { onSuccess: () => { toast.ok(`Following ${name}`); onDone?.() }, onError: (e) => toast.fail(e) })
      }
    >
      {follow.isSuccess ? "Following" : "Follow topic"}
    </Button>
  )
}

function SetGoal({ goal, onDone }: { goal: GoalRef; onDone?: () => void }) {
  const save = useApiMutation<{ year: number; goals: { metric: string; target: number }[] }>("/api/me/goals", {
    method: "PUT",
    invalidates: [["research", "me"], ["goals"]],
  })
  return (
    <Button
      size="sm"
      disabled={save.isPending || save.isSuccess}
      onClick={() =>
        save.mutate(
          { year: goal.year, goals: [{ metric: goal.metric, target: goal.target }] },
          { onSuccess: () => { toast.ok(`Goal set for ${goal.year}`); onDone?.() }, onError: (e) => toast.fail(e) }
        )
      }
    >
      <Target />
      {save.isSuccess ? "Set" : "Set it"}
    </Button>
  )
}

function AddDeadline({ d, onDone }: { d: DeadlineRef; onDone?: () => void }) {
  const add = useApiMutation<Record<string, unknown>>("/api/calendar", { invalidates: [["calendar"]] })
  return (
    <>
      <Button
        size="sm"
        disabled={add.isPending || add.isSuccess || !d.date}
        onClick={() =>
          add.mutate(
            {
              title: d.title,
              kind: "DEADLINE",
              starts_on: d.date,
              all_day: true,
              visibility: "PRIVATE",
              description: d.url || undefined,
            },
            { onSuccess: () => { toast.ok(`Added to your calendar: ${d.title}`); onDone?.() }, onError: (e) => toast.fail(e) }
          )
        }
      >
        <CalendarPlus />
        {add.isSuccess ? "In your calendar" : "Add to calendar"}
      </Button>
      {d.url && (
        <a href={d.url} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
          Open the call
        </a>
      )}
    </>
  )
}

/* ------------------------------------------------------------------------ */
/* Ask                                                                       */
/* ------------------------------------------------------------------------ */

type Turn = { q: string; a?: AskAnswer; error?: string }

export function AskPanel({ prompts, compact }: { prompts: string[]; compact?: boolean }) {
  const [text, setText] = useState("")
  const [turns, setTurns] = useState<Turn[]>([])
  const ask = useApiMutation<{ question: string }, AskAnswer>("/api/compass/ask")

  function send(question: string) {
    const q = question.trim()
    if (!q || ask.isPending) return
    setText("")
    setTurns((t) => [...t, { q }])
    ask.mutate(
      { question: q },
      {
        onSuccess: (a) => setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a } : x))),
        onError: (e) =>
          setTurns((t) =>
            t.map((x, i) =>
              i === t.length - 1
                ? {
                    ...x,
                    error:
                      e instanceof ApiError && e.status === 429
                        ? e.message || "You have asked all you can today. Try again tomorrow."
                        : `${e.message} Try asking again.`,
                  }
                : x
            )
          ),
      }
    )
  }

  return (
    <div className="space-y-4">
      {turns.length > 0 && (
        <ol className={cn("space-y-4", compact && "max-h-80 overflow-y-auto")} aria-live="polite">
          {turns.map((t, i) => (
            <li key={i} className="space-y-2">
              <p className="ml-auto w-fit max-w-[85%] rounded-panel bg-accent-wash px-3 py-2 text-sm text-fg">{t.q}</p>
              {t.a ? (
                <div className="max-w-prose space-y-2">
                  <p className="whitespace-pre-line text-sm text-fg">{t.a.answer}</p>
                  <EvidenceChips items={t.a.evidence} />
                  <CountedNote counted={t.a.counted} />
                </div>
              ) : t.error ? (
                <InlineError message={t.error} />
              ) : (
                <Meta className="block">Thinking about it…</Meta>
              )}
            </li>
          ))}
        </ol>
      )}
      {prompts.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Try asking">
          {prompts.map((p) => (
            <Button key={p} size="sm" kind="quiet" className="ring-control-edge" disabled={ask.isPending} onClick={() => send(p)}>
              {p}
            </Button>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          send(text)
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask about your path, a journal or a colleague"
          aria-label="Your question"
          maxLength={500}
          className="min-w-0 flex-1"
        />
        <Button type="submit" kind="primary" disabled={!text.trim() || ask.isPending}>
          <Send />
          Ask
        </Button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The card other pages show                                                 */
/* ------------------------------------------------------------------------ */

export function useCompassSummary() {
  return useApi<CompassSummary>(["compass", "summary"], "/api/compass/summary", { retry: false })
}

/**
 * Where you are on your compass, for My research and Home. Draws nothing
 * while loading or when the request fails: an invitation is never worth an
 * error box.
 */
export function CompassCard({ variant }: { variant: "research" | "home" }) {
  const q = useCompassSummary()
  const s = q.data
  if (!s) return null
  const started = !!s.path_name || !!s.headline
  const home = variant === "home"
  return (
    <section
      aria-label={home ? "Your path" : "Your compass"}
      data-area="research"
      className="rounded-panel bg-(--area-wash) p-5 shadow-[inset_0_0_0_1px_var(--area-line)]"
    >
      <p className="flex items-center gap-1.5 text-sm font-medium text-(--area)">
        <Compass aria-hidden className="size-4" strokeWidth={1.75} />
        {home ? "Your path" : "Your compass"}
      </p>
      {home && s.next_action ? (
        <p className="mt-2 text-base text-fg">
          Next: <span className="font-medium">{s.next_action.title}</span>
        </p>
      ) : (
        <p className={cn("mt-2 text-fg", home ? "text-base" : "font-display text-xl leading-snug")}>
          {(!home && s.headline) || (started ? s.path_name : "See who you are as a researcher and where you could go")}
        </p>
      )}
      {(s.path_name || s.progress) && (
        <p className="mt-1 text-sm text-fg-muted">
          {[s.path_name && `Your path: ${s.path_name}`, s.progress && s.progress.total > 0 && progressLine(s.progress)]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      <Button size="sm" className="mt-4" asChild>
        <Link to="/compass">{started ? "Open your compass" : "Start your compass"}</Link>
      </Button>
    </section>
  )
}
