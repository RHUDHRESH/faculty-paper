import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { motion } from "motion/react"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Check, Plus, RefreshCw, X } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { enterTransition, useMotionVariants } from "@/ui/motion"
import { Button } from "@/ui/button"
import { Avatar, initialsOf } from "@/ui/person"
import { Checkbox, Input } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { ResearchToolsTabs } from "@/pages/research-tools-tabs"
import { ErrorState, InlineError, NotOpen, SkeletonRows } from "@/ui/state"
import { useAuth } from "@/app/auth"
import { CLAIMANTS } from "@/app/nav"
import { Meta, SectionTitle } from "@/ui/text"
import { ActionButtons, AskPanel, CountedNote, EvidenceChips } from "@/pages/compass-parts"
import {
  furthestStep,
  progressLine,
  STEPS,
  type Action,
  type CompassState,
  type Path,
  type Portrait,
} from "@/pages/compass-model"

const KEY = ["compass"]
const REVEAL = { hidden: { opacity: 0, y: 12 }, shown: { opacity: 1, y: 0, transition: { ...enterTransition, duration: 0.6 } } }

/**
 * Research compass: who you are as a researcher, what you could become, the
 * next few things to do about it, and somebody to ask. Four steps, one
 * primary action each, Back always there. It opens at the furthest step the
 * record says you have reached. Everything rests on `/api/compass`; with the
 * model off the server writes from the record, and the page says so quietly.
 */
export function Compass() {
  const { me, loading } = useAuth()
  // Gate before any request: a role that cannot use the compass never calls /api/compass.
  if (loading || !me) return null
  if (!CLAIMANTS.includes(me.role)) {
    return (
      <div className="page py-8">
        <NotOpen message="The research compass is for people who file their own papers." />
      </div>
    )
  }
  return <CompassOpen />
}

function CompassOpen() {
  const q = useApi<CompassState>(KEY, "/api/compass")
  const [step, setStep] = useState<number | null>(null)
  const [reached, setReached] = useState(0)
  useEffect(() => {
    document.title = "Research compass"
  }, [])
  useEffect(() => {
    if (q.data && step === null) {
      const f = furthestStep(q.data)
      setStep(f)
      setReached(f)
    }
  }, [q.data, step])

  const go = (n: number) => {
    setStep(n)
    setReached((r) => Math.max(r, n))
    window.scrollTo?.({ top: 0 })
  }
  const d = q.data
  const current = step ?? 0
  const path = d?.paths?.find((p) => p.key === d.chosen_path) ?? null
  const peer = path?.peers[0]?.name
  const prompts = [
    ...(d?.plan?.some((a) => a.kind === "journal") ? ["Why this journal?"] : []),
    ...(d?.plan ? ["Make it less ambitious"] : []),
    ...(peer ? [`Draft an email to ${peer}`] : []),
    ...(!d?.plan ? ["What am I best known for?"] : []),
  ]

  return (
    <div className="page space-y-8" data-area="research">
      <ResearchToolsTabs />
      <PageHeader title="Research compass" sub="Who you are as a researcher, where you could go, and what to do next." />

      {q.isError ? (
        <ErrorState title="Could not open your compass" message={`${q.error.message} Nothing has been lost.`} onRetry={() => void q.refetch()} />
      ) : !d || step === null ? (
        <SkeletonRows rows={5} rowHeight={48} />
      ) : (
        <>
          <Stepper step={current} reached={reached} onPick={go} />
          {current === 0 && <WhoYouAre state={d} onNext={() => go(1)} />}
          {current === 1 && <WhatYouCouldBe state={d} onBack={() => go(0)} onNext={() => go(2)} />}
          {current === 2 && <NextSteps state={d} onBack={() => go(1)} onNext={() => go(3)} />}
          {current === 3 && (
            <section aria-labelledby="ask-h" className="space-y-4">
              <SectionTitle>
                <span id="ask-h">Ask about your path</span>
              </SectionTitle>
              <p className="max-w-prose text-fg-muted">Answers come from your record and the plan above, with what they rest on.</p>
              <AskPanel prompts={prompts} />
              <Back onClick={() => go(2)} />
            </section>
          )}
          {current < 3 && (
            <details className="group rounded-panel border border-line bg-surface px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-fg">Ask a question about this</summary>
              <div className="pt-4">
                <AskPanel prompts={prompts} compact />
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}

function Stepper({ step, reached, onPick }: { step: number; reached: number; onPick: (n: number) => void }) {
  return (
    <nav aria-label="Steps">
      <ol className="grid grid-cols-4 gap-2">
        {STEPS.map((label, i) => {
          const here = i === step
          const done = i < step
          const open = i <= reached
          return (
            <li key={label} className="min-w-0">
              <button
                type="button"
                disabled={!open}
                aria-current={here ? "step" : undefined}
                onClick={() => onPick(i)}
                className={cn(
                  "flex w-full min-w-0 flex-col gap-2 rounded-control pt-0 text-left disabled:cursor-default",
                  open && !here && "hover:text-fg"
                )}
              >
                <span className={cn("h-1 w-full rounded-full", here || done ? "bg-(--area)" : "bg-line")} aria-hidden />
                <span className="flex items-center gap-1.5 text-sm">
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full text-xs tabular",
                      here ? "bg-(--area) text-white" : done ? "bg-(--area-wash) text-(--area)" : "bg-sunken text-fg-subtle"
                    )}
                  >
                    {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={cn("truncate max-sm:sr-only", here ? "font-medium text-fg" : "text-fg-muted")}>{label}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      <p className="mt-2 text-sm font-medium text-fg sm:hidden">
        Step {step + 1} of 4: {STEPS[step]}
      </p>
    </nav>
  )
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <Button kind="quiet" onClick={onClick}>
      <ArrowLeft />
      Back
    </Button>
  )
}

/** Writes a part of the compass the first time its step is opened. */
function useWriteOnce(missing: boolean, write: () => void) {
  const asked = useRef(false)
  useEffect(() => {
    if (missing && !asked.current) {
      asked.current = true
      write()
    }
  }, [missing, write])
}

/* ------------------------------------------------------------------------ */
/* 1. Who you are                                                            */
/* ------------------------------------------------------------------------ */

function WhoYouAre({ state, onNext }: { state: CompassState; onNext: () => void }) {
  const qc = useQueryClient()
  const write = useApiMutation<{ refresh?: boolean }, Portrait>("/api/compass/portrait")
  const save = useApiMutation<{ topics: string[] }, { ok: boolean; topics: string[] }>("/api/compass/topics", {
    invalidates: [["compass", "summary"]],
  })
  const p = state.portrait
  const [chips, setChips] = useState<string[] | null>(null)
  const [typed, setTyped] = useState("")
  const variants = useMotionVariants(REVEAL)

  const run = (refresh: boolean) =>
    write.mutate(refresh ? { refresh } : {}, {
      onSuccess: (portrait) => {
        qc.setQueryData<CompassState>(KEY, (s) => (s ? { ...s, portrait } : s))
        setChips(portrait.topics.map((t) => t.name))
      },
    })
  useWriteOnce(!p, () => run(false))

  const topics = chips ?? p?.topics.map((t) => t.name) ?? []
  const suggestions = state.facts.topics.map((t) => t.name).filter((t) => !topics.includes(t)).slice(0, 8)
  const add = (t: string) => {
    const name = t.trim()
    if (name && !topics.some((x) => x.toLowerCase() === name.toLowerCase())) setChips([...topics, name])
  }

  if (!p) {
    return write.isError ? (
      <InlineError message={`Could not write your portrait. ${write.error.message}`} onRetry={() => run(false)} />
    ) : (
      <div className="space-y-3" role="status">
        <Meta className="block">Reading your papers…</Meta>
        <SkeletonRows rows={4} rowHeight={40} />
      </div>
    )
  }

  return (
    <section aria-labelledby="who-h" className="space-y-8">
      <h2 id="who-h" className="sr-only">
        Who you are
      </h2>
      <motion.p
        key={p.headline}
        initial="hidden"
        animate="shown"
        variants={variants}
        className="display max-w-[30ch] text-balance text-3xl leading-tight text-fg sm:text-4xl"
      >
        {p.headline}
      </motion.p>

      <div className="space-y-3">
        <SectionTitle>Your strengths</SectionTitle>
        <ol className="divide-y divide-line border-y border-line">
          {p.strengths.slice(0, 3).map((s, i) => (
            <li key={i} className="flex flex-col gap-2 py-4">
              <p className="text-base font-medium text-fg">{s.text}</p>
              <EvidenceChips items={s.evidence} />
            </li>
          ))}
        </ol>
      </div>

      {p.standing && (
        <div className="space-y-1">
          <SectionTitle>Where you stand</SectionTitle>
          <p className="max-w-prose text-fg">{p.standing}</p>
        </div>
      )}

      <div className="space-y-3">
        <SectionTitle>What you work on</SectionTitle>
        <p className="text-sm text-fg-muted">Take away what is not you, and add what is missing.</p>
        <ul className="flex flex-wrap gap-2" aria-label="Your topics">
          {topics.map((t) => (
            <li key={t} className="inline-flex max-w-full items-center gap-1 rounded-full bg-(--area-wash) py-1 pl-3 pr-1.5 text-sm text-(--area)">
              <span className="truncate">{t}</span>
              <button
                type="button"
                aria-label={`Remove ${t}`}
                onClick={() => setChips(topics.filter((x) => x !== t))}
                className="shrink-0 rounded-full p-0.5 hover:bg-(--area-line)"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
          {topics.length === 0 && <Meta>No topics yet. Add one below.</Meta>}
        </ul>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Meta>From your papers:</Meta>
            {suggestions.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => add(t)}
                aria-label={`Add ${t}`}
                className="inline-flex items-center gap-1 rounded-full py-1 pl-2 pr-3 text-sm text-fg-muted shadow-[inset_0_0_0_1px_var(--color-control-edge)] hover:bg-hover hover:text-fg"
              >
                <Plus className="size-3.5" aria-hidden />
                {t}
              </button>
            ))}
          </div>
        )}
        <form
          className="flex max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            add(typed)
            setTyped("")
          }}
        >
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Add a topic" aria-label="Add a topic" maxLength={80} className="min-w-0 flex-1" />
          <Button type="submit" disabled={!typed.trim()}>
            Add
          </Button>
        </form>
      </div>

      <CountedNote counted={p.counted} />
      {save.isError && <InlineError message={`Could not save your topics. ${save.error.message}`} />}
      {write.isError && <InlineError message={`Could not write it again. ${write.error.message}`} onRetry={() => run(true)} />}

      <div className="flex flex-wrap gap-3">
        <Button
          kind="primary"
          size="lg"
          disabled={save.isPending || topics.length === 0}
          onClick={() => save.mutate({ topics }, { onSuccess: onNext })}
        >
          {save.isPending ? "Saving…" : "That's me"}
        </Button>
        <Button size="lg" kind="quiet" disabled={write.isPending} onClick={() => run(true)}>
          <RefreshCw />
          {write.isPending ? "Writing…" : "Write it again"}
        </Button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* 2. What you could be                                                      */
/* ------------------------------------------------------------------------ */

function WhatYouCouldBe({ state, onBack, onNext }: { state: CompassState; onBack: () => void; onNext: () => void }) {
  const qc = useQueryClient()
  const write = useApiMutation<{ refresh?: boolean }, { paths: Path[]; counted: boolean }>("/api/compass/paths")
  const choose = useApiMutation<{ path: string }, { plan: Action[]; counted: boolean }>("/api/compass/choose", {
    invalidates: [["compass", "summary"]],
  })
  const [counted, setCounted] = useState(false)
  const [picking, setPicking] = useState<string | null>(null)
  const paths = state.paths

  const run = (refresh: boolean) =>
    write.mutate(refresh ? { refresh } : {}, {
      onSuccess: (r) => {
        setCounted(r.counted)
        qc.setQueryData<CompassState>(KEY, (s) => (s ? { ...s, paths: r.paths } : s))
      },
    })
  useWriteOnce(!paths || paths.length === 0, () => run(false))

  const pick = (key: string) => {
    setPicking(key)
    choose.mutate(
      { path: key },
      {
        onSuccess: (r) => {
          qc.setQueryData<CompassState>(KEY, (s) => (s ? { ...s, chosen_path: key, plan: r.plan } : s))
          onNext()
        },
      }
    )
  }

  return (
    <section aria-labelledby="could-h" className="space-y-6">
      <div className="space-y-1">
        <SectionTitle>
          <span id="could-h">What you could be</span>
        </SectionTitle>
        <p className="max-w-prose text-fg-muted">Three directions your record points to. Pick the one that feels most like you.</p>
      </div>

      {!paths || paths.length === 0 ? (
        write.isError ? (
          <InlineError message={`Could not find your paths. ${write.error.message}`} onRetry={() => run(false)} />
        ) : (
          <div role="status" className="space-y-3">
            <Meta className="block">Working out where your record could lead…</Meta>
            <SkeletonRows rows={3} rowHeight={72} />
          </div>
        )
      ) : (
        <ol className="grid gap-4 lg:grid-cols-3">
          {paths.map((p) => {
            const mine = p.key === state.chosen_path
            return (
              <li
                key={p.key}
                className={cn(
                  "flex flex-col gap-4 rounded-panel bg-surface p-5 shadow-[inset_0_0_0_1px_var(--color-line)]",
                  mine && "shadow-[inset_0_0_0_2px_var(--area)]"
                )}
              >
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold text-fg">{p.name}</h3>
                  {mine && <Meta className="block">Your chosen path</Meta>}
                </div>
                <p className="text-sm text-fg-muted">{p.why}</p>
                <EvidenceChips items={p.evidence} />
                {p.metrics.length > 0 && (
                  <ul className="space-y-3" aria-label="Where you are and where this path goes">
                    {p.metrics.map((m) => {
                      const share = m.target > 0 ? Math.min(1, m.now / m.target) : 0
                      return (
                        <li key={m.label} className="space-y-1">
                          <p className="flex items-baseline justify-between gap-2 text-sm">
                            <span className="text-fg">{m.label}</span>
                            <span className="tabular text-fg-muted">
                              {m.now} → {m.target}
                              {m.unit ? ` ${m.unit}` : ""}
                            </span>
                          </p>
                          <div
                            role="progressbar"
                            aria-label={m.label}
                            aria-valuemin={0}
                            aria-valuemax={m.target}
                            aria-valuenow={m.now}
                            className="h-1.5 overflow-hidden rounded-full bg-sunken"
                          >
                            <div className="h-full rounded-full bg-(--area)" style={{ width: `${Math.round(share * 100)}%` }} />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {p.peers.length > 0 && (
                  <div className="space-y-1.5">
                    <Meta className="block">People here on this path</Meta>
                    <ul className="flex flex-wrap gap-1.5">
                      {p.peers.map((x) => (
                        <li key={x.id}>
                          <Link
                            to={`/u/${x.id}`}
                            title={x.dept}
                            className="inline-flex items-center gap-1.5 rounded-full bg-(--area-people-wash,var(--color-sunken)) py-0.5 pl-0.5 pr-2.5 text-xs font-medium text-fg hover:underline"
                          >
                            <Avatar
                              size="sm"
                              person={{ name: x.name, initials: x.initials ?? initialsOf(x.name), photo_url: x.photo_url ?? null }}
                            />
                            {x.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <Button
                  className="mt-auto"
                  kind={mine ? "primary" : "default"}
                  disabled={choose.isPending}
                  onClick={() => pick(p.key)}
                >
                  {choose.isPending && picking === p.key ? "Making your plan…" : mine ? "Keep this path" : "Take this path"}
                </Button>
              </li>
            )
          })}
        </ol>
      )}

      <CountedNote counted={counted} />
      {choose.isError && (
        <InlineError message={`Could not make your plan. ${choose.error.message}`} onRetry={() => picking && pick(picking)} />
      )}
      <div className="flex flex-wrap gap-3">
        <Back onClick={onBack} />
        {paths && paths.length > 0 && (
          <Button kind="quiet" disabled={write.isPending} onClick={() => run(true)}>
            <RefreshCw />
            {write.isPending ? "Thinking again…" : "Show me other paths"}
          </Button>
        )}
        {write.isError && paths && paths.length > 0 && <InlineError message={write.error.message} onRetry={() => run(true)} />}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* 3. Your next steps                                                        */
/* ------------------------------------------------------------------------ */

function NextSteps({ state, onBack, onNext }: { state: CompassState; onBack: () => void; onNext: () => void }) {
  const plan = state.plan ?? []
  const path = state.paths?.find((p) => p.key === state.chosen_path)
  const done = plan.filter((a) => a.done).length
  return (
    <section aria-labelledby="next-h" className="space-y-6">
      <div className="space-y-1">
        <SectionTitle>
          <span id="next-h">Your next steps</span>
        </SectionTitle>
        <p className="max-w-prose text-fg-muted">
          {path ? `Towards ${path.name}. ` : ""}Tick each one off as you do it.
        </p>
      </div>
      {plan.length === 0 ? (
        <Meta className="block">No plan yet. Go back and pick a path.</Meta>
      ) : (
        <>
          <p className="text-sm font-medium text-fg" aria-live="polite" data-testid="plan-progress">
            {progressLine({ done, total: plan.length })}
          </p>
          <ul className="divide-y divide-line">
            {plan.map((a) => (
              <ActionRow key={a.id} action={a} />
            ))}
          </ul>
        </>
      )}
      <div className="flex flex-wrap gap-3">
        <Back onClick={onBack} />
        <Button kind="primary" onClick={onNext}>
          Ask about your plan
        </Button>
      </div>
    </section>
  )
}

function ActionRow({ action: a }: { action: Action }) {
  const qc = useQueryClient()
  const tick = useApiMutation<{ done: boolean }, { ok: boolean; done: boolean; progress: { done: number; total: number } }>(
    `/api/compass/actions/${encodeURIComponent(a.id)}`,
    { invalidates: [["compass", "summary"]] }
  )
  const set = (done: boolean) =>
    tick.mutate(
      { done },
      {
        onSuccess: (r) =>
          qc.setQueryData<CompassState>(KEY, (s) =>
            s && s.plan ? { ...s, plan: s.plan.map((x) => (x.id === a.id ? { ...x, done: r.done } : x)) } : s
          ),
      }
    )
  return (
    <li className="flex gap-3 py-4">
      <Checkbox
        checked={a.done}
        disabled={tick.isPending}
        onCheckedChange={(v) => set(v === true)}
        aria-label={`Done: ${a.title}`}
        className="mt-1"
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className={cn("font-medium text-fg", a.done && "text-fg-muted line-through decoration-fg-subtle")}>{a.title}</p>
        {a.why && <p className="text-sm text-fg-muted">{a.why}</p>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <ActionButtons action={a} onDone={() => !a.done && set(true)} />
        </div>
        {tick.isError && <InlineError message={`Could not save that. ${tick.error.message}`} onRetry={() => set(!a.done)} />}
      </div>
    </li>
  )
}
