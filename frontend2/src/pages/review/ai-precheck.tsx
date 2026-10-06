import { useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, RotateCcw, Sparkles, ThumbsDown, ThumbsUp, XCircle } from "lucide-react"

import type { Role } from "@/app/auth"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Textarea } from "@/ui/field"
import { Callout, Skeleton, SkeletonText } from "@/ui/state"
import { toast } from "@/ui/toast"

/**
 * Claim pre-check: a second reader for the research cell (docs/ux/20-ai.md).
 *
 * It reads the claim's PDFs and the record and returns six items, each pass,
 * check or fail, with the quoted evidence and the page. The server decides
 * the status: a record check that failed stays failed whatever the model
 * said, and the model can only add a reading and lower a pass to a warning
 * (core/services/ai_precheck.py). Nothing here ticks the checklist, clears or
 * sends anything back; the reviewer reads it and decides.
 *
 * When AI is off for the college, or the account may not use it, the section
 * says so in one line and the page works exactly as it did.
 */

export type AiStatusWord = "pass" | "warn" | "fail"

export type AiEvidence = {
  quote: string
  page: number | null
  file: string | null
  /** "check": found by the college's own search of the text. "ai": quoted by the model, and found in the file. */
  by: "check" | "ai"
  note?: string
  ref_number?: string | null
}

export type AiItem = {
  key: string
  label: string
  status: AiStatusWord
  detail: string
  evidence: AiEvidence[]
  /** A record check failed: nothing the model says changes it. */
  locked: boolean
  ai: { status: string; note: string; raised: boolean; quote_unverified?: boolean } | null
}

export type AiResult = {
  /** Null when the answer was not kept (the model's reply could not be read). */
  id: string | null
  created_at: string
  items: AiItem[]
  summary: string | null
  ai_ok: boolean
  ai_error: string | null
  model: string
  host: string
  hosted: boolean
  tokens?: { in: number; out: number; estimated: boolean }
}

export type AiPrecheckStatus = {
  available: boolean
  code: string | null
  model: string
  host: string
  hosted: boolean
  usage: { used: number; limit: number }
  current: AiResult | null
  /** The claim changed since the last stored check. */
  changed: boolean
}

export type AiDraft = {
  reason: string
  /** "ai": written by the model. "template": the model could not be read, so these are the plain findings. */
  source: "ai" | "template"
  keys: string[]
  model: string
  host: string
  hosted: boolean
}

/** The seats the server lets use it. The page still hides itself on a refusal. */
export const AI_PRECHECK_ROLES: Role[] = ["RESEARCH_CELL", "RESEARCH_COORDINATOR", "SUPER_ADMIN"]

export const aiKey = (claimId: string, version?: string | null) => ["ai-precheck", claimId, version ?? ""] as const

export function useAiPrecheck(claimId: string, enabled: boolean, version?: string | null, auto = false) {
  const qc = useQueryClient()
  const key = aiKey(claimId, version)
  const status = useApi<AiPrecheckStatus>(key, `/api/claims/${claimId}/ai-precheck`, {
    enabled,
    retry: false,
    staleTime: 60_000,
  })

  const run = useMutation<AiResult, ApiError, boolean>({
    mutationFn: (force) => api<AiResult>(`/api/claims/${claimId}/ai-precheck`, { method: "POST", json: { force } }),
    onSuccess: (result) => {
      // A reply that is not a checklist is ignored rather than drawn.
      if (!Array.isArray(result?.items)) return
      qc.setQueryData<AiPrecheckStatus>(key, (old) =>
        old
          ? {
              ...old,
              current: result,
              changed: false,
              usage: { ...old.usage, used: Math.min(old.usage.limit, old.usage.used + 1) },
            }
          : old
      )
    },
  })

  // Opening a claim runs the check once when AI is on and nothing is stored
  // for the claim as it stands. Never twice for one claim, and never when
  // the person's day is spent.
  const tried = useRef(false)
  useEffect(() => {
    const s = status.data
    if (!auto || tried.current || !s || !s.available || s.current || s.usage.used >= s.usage.limit) return
    tried.current = true
    run.mutate(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, status.data])

  return { status, run }
}

export function useAiFeedback(claimId: string) {
  return useMutation<unknown, ApiError, { target_id: string; rating: 1 | -1; feature?: string }>({
    mutationFn: (body) => api(`/api/claims/${claimId}/ai-precheck/feedback`, { method: "POST", json: body }),
  })
}

/* -------------------------------------------------------------------------- */
/* Small parts                                                                */
/* -------------------------------------------------------------------------- */

export function AiMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium text-fg-muted", className)}>
      <Sparkles className="size-3.5 text-accent" aria-hidden /> AI draft
    </span>
  )
}

function where(r: { model: string; host: string; hosted: boolean }): string {
  if (!r.model) return "Written by AI"
  return r.hosted && r.host ? `${r.model} on ${r.host}` : `${r.model} on the college's own server`
}

const WORD: Record<AiStatusWord, string> = { pass: "Pass", warn: "Check this", fail: "Fail" }

function StatusMark({ status }: { status: AiStatusWord }) {
  const Icon = status === "pass" ? CheckCircle2 : status === "warn" ? AlertTriangle : XCircle
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-sm font-medium",
        status === "pass" && "text-positive",
        status === "warn" && "text-caution",
        status === "fail" && "text-critical"
      )}
    >
      <Icon className="size-4" aria-hidden />
      {WORD[status]}
    </span>
  )
}

/** Thumbs up or down on one answer. One tap, and it can be changed. */
export function Thumbs({ onRate, label }: { onRate: (rating: 1 | -1) => Promise<unknown>; label: string }) {
  const [rated, setRated] = useState<1 | -1 | null>(null)
  async function rate(r: 1 | -1) {
    const before = rated
    setRated(r)
    try {
      await onRate(r)
    } catch (err) {
      setRated(before)
      toast.fail(err)
    }
  }
  return (
    <span role="group" aria-label={`Was this ${label} useful?`} className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-pressed={rated === 1}
        aria-label="Useful"
        onClick={() => void rate(1)}
        className={cn(
          "inline-grid size-8 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg max-sm:size-10",
          rated === 1 && "bg-positive-wash text-positive"
        )}
      >
        <ThumbsUp className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-pressed={rated === -1}
        aria-label="Not useful"
        onClick={() => void rate(-1)}
        className={cn(
          "inline-grid size-8 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg max-sm:size-10",
          rated === -1 && "bg-critical-wash text-critical"
        )}
      >
        <ThumbsDown className="size-4" aria-hidden />
      </button>
    </span>
  )
}

function Evidence({ items }: { items: AiEvidence[] }) {
  if (items.length === 0) return null
  return (
    <ul className="mt-2 space-y-2">
      {items.map((e, i) => (
        <li key={i}>
          <blockquote className="break-words border-l-2 border-line pl-3 text-sm text-fg">“{e.quote}”</blockquote>
          <p className="mt-0.5 pl-3 text-xs text-fg-muted">
            {[
              e.ref_number ? `Reference ${e.ref_number}` : null,
              e.page ? `Page ${e.page}` : null,
              e.file,
              e.by === "ai" ? "Quoted by the AI" : "Found by the check",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {e.note && <p className="pl-3 text-xs text-fg-muted">{e.note}</p>}
        </li>
      ))}
    </ul>
  )
}

function Item({ item }: { item: AiItem }) {
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h4 className="text-sm font-medium">{item.label}</h4>
        <StatusMark status={item.status} />
      </div>
      <p className="mt-1 break-words text-sm text-fg-muted">{item.detail}</p>
      <Evidence items={item.evidence} />
      {item.ai && item.ai.note && (
        <p className="mt-2 break-words text-xs text-fg-muted">
          <span className="font-medium text-fg">The AI says: </span>
          {item.ai.note}
          {item.ai.quote_unverified && " It gave a quote that is not in the file, so it is not shown."}
        </p>
      )}
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* The section on the Check tab                                               */
/* -------------------------------------------------------------------------- */

export function AiPrecheckSection({
  claimId,
  version,
  role,
  own,
  auto,
}: {
  claimId: string
  version?: string | null
  role: Role | undefined
  own: boolean
  /** Run the check on opening (the clearing desk). */
  auto: boolean
}) {
  const allowed = !!role && AI_PRECHECK_ROLES.includes(role) && !own
  const { status, run } = useAiPrecheck(claimId, allowed, version, auto)
  const feedback = useAiFeedback(claimId)

  if (!allowed) return null
  const s = status.data

  return (
    <section aria-labelledby="rv-ai" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="rv-ai" className="text-base font-semibold">
          Check with AI
        </h3>
        {s?.available && <AiMark />}
      </div>

      {status.isLoading && (
        <div role="status" aria-label="Looking for an AI check" className="space-y-2">
          <Skeleton className="h-5 w-1/2" />
          <SkeletonText lines={2} />
        </div>
      )}

      {status.isError && (
        <p className="text-sm text-fg-muted">The AI check could not be reached just now. The checks above are unaffected.</p>
      )}

      {s && !s.available && (
        <p className="text-sm text-fg-muted">
          {s.code === "not_configured" || s.code === "misconfigured"
            ? "AI is off for this college."
            : "AI is not answering right now."}{" "}
          Everything on this page works without it.
        </p>
      )}

      {s?.available && run.isPending && (
        <div role="status" className="space-y-2">
          <p className="text-sm text-fg-muted">Reading the paper and the references…</p>
          <SkeletonText lines={4} />
        </div>
      )}

      {s?.available && !run.isPending && !s.current && (
        <div className="space-y-2">
          <p className="text-sm text-fg-muted">
            {s.changed
              ? "The claim has changed since it was last checked."
              : "Reads the paper's PDF and the record, and lists what it found with the line it found it on."}{" "}
            It never decides anything for you.
          </p>
          {run.error && <Callout tone="caution">{run.error.message}</Callout>}
          <Button
            size="sm"
            kind="default"
            onClick={() => run.mutate(false)}
            disabled={s.usage.used >= s.usage.limit}
          >
            <Sparkles aria-hidden /> Check with AI
          </Button>
          {s.usage.used >= s.usage.limit && (
            <p className="text-xs text-fg-muted">You have used today's {s.usage.limit} AI checks.</p>
          )}
        </div>
      )}

      {s?.available && !run.isPending && s.current && (
        <Result
          result={s.current}
          usage={s.usage}
          error={run.error?.message ?? null}
          onAgain={() => run.mutate(true)}
          onRate={(rating) =>
            feedback.mutateAsync({ target_id: s.current!.id!, rating, feature: "claim_precheck" })
          }
        />
      )}
    </section>
  )
}

function Result({
  result,
  usage,
  error,
  onAgain,
  onRate,
}: {
  result: AiResult
  usage: { used: number; limit: number }
  error: string | null
  onAgain: () => void
  onRate: (r: 1 | -1) => Promise<unknown>
}) {
  const fails = result.items.filter((i) => i.status === "fail").length
  const warns = result.items.filter((i) => i.status === "warn").length
  const spent = usage.used >= usage.limit
  return (
    <div className="space-y-2">
      {!result.ai_ok && (
        <Callout tone="caution" title="The AI's reading is missing">
          <p>{result.ai_error ?? "The AI did not answer."} The checks from the record are below.</p>
        </Callout>
      )}
      {error && <Callout tone="caution">{error}</Callout>}
      <p className="text-sm">
        <span className={cn("font-medium", fails > 0 ? "text-critical" : warns > 0 ? "text-caution" : "text-positive")}>
          {fails > 0
            ? `${fails} failed${warns > 0 ? `, ${warns} to check` : ""}`
            : warns > 0
              ? `${warns} to check`
              : "Everything passed"}
        </span>
        {result.summary ? <span className="text-fg-muted"> · {result.summary}</span> : null}
      </p>
      <ul className="divide-y divide-line border-y border-line">
        {result.items.map((item) => (
          <Item key={item.key} item={item} />
        ))}
      </ul>
      {fails + warns > 0 && (
        <p className="text-xs text-fg-muted">
          To send this back, press <kbd className="rounded border border-edge px-1">s</kbd>. The reason box can draft
          the wording from these items.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-xs text-fg-muted">
          <AiMark className="mr-1" /> {where(result)}. It reads the files and the record, and you decide.
        </p>
        <div className="flex items-center gap-1">
          {result.id && <Thumbs onRate={onRate} label="check" />}
          <Button size="sm" kind="quiet" onClick={onAgain} disabled={spent} title={spent ? "Today's AI checks are used" : undefined}>
            <RotateCcw aria-hidden /> Check again
          </Button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The send-back reason, beside the reason box                                */
/* -------------------------------------------------------------------------- */

/**
 * "Draft send-back reason": offered beside the reason box once a check has
 * found something. The draft lands in its own editable box and goes into the
 * reason only when the reviewer presses "Use this".
 */
export function AiReasonDraft({
  claimId,
  version,
  role,
  onUse,
}: {
  claimId: string
  version?: string | null
  role: Role | undefined
  onUse: (text: string) => void
}) {
  const allowed = !!role && AI_PRECHECK_ROLES.includes(role)
  const { status } = useAiPrecheck(claimId, allowed, version)
  const feedback = useAiFeedback(claimId)
  const [text, setText] = useState<string | null>(null)
  const draft = useMutation<AiDraft, ApiError, void>({
    mutationFn: () => api<AiDraft>(`/api/claims/${claimId}/ai-precheck/send-back-draft`, { method: "POST", json: {} }),
    onSuccess: (d) => setText(d.reason),
  })

  const s = status.data
  const found = s?.current?.items.some((i) => i.status !== "pass") ?? false
  if (!allowed || !s?.available || !s.current || !found) return null
  const drafted = draft.data
  const spent = s.usage.used >= s.usage.limit

  if (text === null || !drafted) {
    return (
      <div className="space-y-1.5">
        <Button size="sm" kind="default" loading={draft.isPending} disabled={spent} onClick={() => draft.mutate()}>
          {!draft.isPending && <Sparkles aria-hidden />} Draft send-back reason
        </Button>
        {draft.error && <p className="text-sm text-critical">{draft.error.message}</p>}
        {spent && <p className="text-xs text-fg-muted">You have used today's {s.usage.limit} AI checks.</p>}
      </div>
    )
  }

  return (
    <div className="well space-y-2 p-3" role="group" aria-label="Drafted reason">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AiMark />
        <span className="text-xs text-fg-muted">
          {drafted.source === "template" ? "Written without AI from the findings" : where(drafted)}
        </span>
      </div>
      <label className="sr-only" htmlFor="ai-reason-draft">
        Drafted reason, editable
      </label>
      <Textarea id="ai-reason-draft" value={text} onChange={(e) => setText(e.target.value)} rows={6} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            kind="primary"
            disabled={text.trim().length < 10}
            onClick={() => {
              onUse(text.trim())
              setText(null)
              draft.reset()
            }}
          >
            Use this
          </Button>
          <Button size="sm" kind="quiet" loading={draft.isPending} disabled={spent} onClick={() => draft.mutate()}>
            Try again
          </Button>
          <Button
            size="sm"
            kind="quiet"
            onClick={() => {
              setText(null)
              draft.reset()
            }}
          >
            Discard
          </Button>
        </div>
        {drafted.source === "ai" && s.current.id && (
          <Thumbs
            label="draft"
            onRate={(rating) => feedback.mutateAsync({ target_id: s.current!.id!, rating, feature: "send_back_draft" })}
          />
        )}
      </div>
      <p className="text-xs text-fg-muted">Nothing is sent until you press Send back. Edit it first.</p>
    </div>
  )
}
