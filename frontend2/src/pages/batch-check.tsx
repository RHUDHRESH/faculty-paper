import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { Landmark, ListChecks, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip, type ChipTone } from "@/ui/chip"
import { ClaimNo } from "@/ui/claim-number"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { Details } from "@/ui/section"
import { SkeletonRows } from "@/ui/state"

/**
 * "Check this batch" (docs/ux/20-ai.md, Director / Finance).
 *
 * What is unusual is decided on the server from money facts alone
 * (`core/services/batch_check.py`); this panel draws the list and, when a model
 * is set up, an AI summary that words and ranks it. The model can move a
 * finding up or down but cannot add one, and nothing here authorises, blocks
 * or pays. With AI off the list is the same and one line says so.
 *
 * Nothing is asked until the person presses the button: the check reads the
 * whole queue and the summary spends part of the day's allowance.
 */

export type Stage = "authorise" | "pay"
type Severity = "high" | "medium" | "low"

export type Finding = {
  id: string
  kind: string
  severity: Severity
  title: string
  reason: string
  facts: Record<string, unknown>
  claim_id: string | null
  ticket_number: string | null
  paper_title: string
  name: string | null
  department: string | null
  photo_url?: string | null
  link: string | null
}

type AiState = {
  state: "ready" | "off" | "limit" | "error" | "unusable"
  model: string
  host: string
  hosted: boolean
  message: string | null
}

type Summary = {
  headline: string
  order: string[]
  reasons: Record<string, string>
  model: string
  host: string
  hosted: boolean
  cached: boolean
}

type Rules = {
  far_rupees: number
  far_percent: number
  title_ratio_percent: number
  large_factor: number
  large_percentile: number
  large_floor: number
  thin_left_percent: number
  recent_days: number
  daily_limit: number
}

type Payload = {
  stage: Stage
  batch: { count: number; amount: number; truncated: boolean }
  findings: Finding[]
  fingerprint: string
  ai: AiState
  summary: Summary | null
  rules: Rules
}

const SEVERITY: Record<Severity, { word: string; tone: ChipTone }> = {
  high: { word: "Look first", tone: "critical" },
  medium: { word: "Worth a look", tone: "caution" },
  low: { word: "For information", tone: "neutral" },
}

const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`

export function BatchCheck({ stage, department }: { stage: Stage; department?: string }) {
  const [open, setOpen] = useState(false)
  const verb = stage === "authorise" ? "authorise" : "pay"
  const query = department ? `?department=${encodeURIComponent(department)}` : ""
  const base = `/api/batch-check/${stage}`

  const list = useApi<Payload>(["batch-check", stage, department ?? ""], `${base}${query}`, {
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  })

  const summarise = useMutation<Payload, ApiError, void>({
    mutationFn: () => api<Payload>(`${base}/summary${query}`, { method: "POST" }),
  })

  // Ask for the wording once per batch as it stands: a changed batch has a new
  // fingerprint and is asked again; the same one comes back from the server's
  // cache without spending anything.
  const askedFor = useRef<string | null>(null)
  const fingerprint = list.data?.fingerprint
  const aiReady = list.data?.ai.state === "ready" && (list.data?.findings.length ?? 0) > 0
  const { mutate: ask, reset } = summarise
  useEffect(() => {
    if (!open || !fingerprint || !aiReady || askedFor.current === fingerprint) return
    askedFor.current = fingerprint
    ask()
  }, [open, fingerprint, aiReady, ask])

  function close() {
    setOpen(false)
    askedFor.current = null
    reset()
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button kind="default" onClick={() => setOpen(true)}>
          <ListChecks />
          Check this batch
        </Button>
        <span className="text-sm text-fg-muted">Looks for odd amounts, repeats and budget risk before you {verb}.</span>
      </div>
    )
  }

  const data = list.data
  // The later answer (list plus summary) replaces the first only when it is for
  // the same batch; otherwise the list on screen is the one the person is judging.
  const done = summarise.data && summarise.data.fingerprint === data?.fingerprint ? summarise.data : null
  const summary = done?.summary ?? null
  const ai = done?.ai ?? data?.ai

  return (
    <section aria-label="Check this batch" className="panel space-y-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold">Check this batch</h2>
        <div className="flex gap-2">
          <Button kind="quiet" size="sm" onClick={() => list.refetch()} disabled={list.isFetching}>
            Check again
          </Button>
          <Button kind="quiet" size="sm" onClick={close}>
            Close
          </Button>
        </div>
      </div>

      {list.isLoading ? (
        <div role="status" className="space-y-3">
          <p className="text-sm text-fg-muted">Checking the batch…</p>
          <SkeletonRows rows={3} rowHeight={48} />
        </div>
      ) : list.isError || !data ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm">Could not check the batch. Nothing has been changed.</p>
          <Button kind="default" size="sm" onClick={() => list.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <Result
          data={data}
          ai={ai ?? data.ai}
          summary={summary}
          asking={summarise.isPending}
          stage={stage}
        />
      )}
    </section>
  )
}

function Result({
  data,
  ai,
  summary,
  asking,
  stage,
}: {
  data: Payload
  ai: AiState
  summary: Summary | null
  asking: boolean
  stage: Stage
}) {
  const byId = new Map(data.findings.map((f) => [f.id, f]))
  const ordered = summary ? summary.order.map((id) => byId.get(id)).filter((f): f is Finding => !!f) : data.findings
  const n = data.findings.length
  const sentence =
    n === 0
      ? `Nothing unusual in ${plural(data.batch.count, "claim", "claims")}, ${money(data.batch.amount)}.`
      : `${plural(n, "thing", "things")} worth a look in ${plural(data.batch.count, "claim", "claims")}, ${money(data.batch.amount)}.`

  return (
    <>
      {data.batch.truncated && (
        <p className="text-sm text-caution">The first {formatCount(data.batch.count)} claims were checked.</p>
      )}

      {summary ? (
        <AiSummary summary={summary} stage={stage} fingerprint={data.fingerprint} />
      ) : (
        <p className="text-lead text-fg">{sentence}</p>
      )}

      {n > 0 && asking && !summary && (
        <p role="status" className="inline-flex items-center gap-2 text-sm text-fg-muted">
          <Sparkles className="size-4" aria-hidden /> Writing a short summary…
        </p>
      )}
      {n > 0 && !summary && !asking && ai.state !== "ready" && ai.message && (
        <p className="text-sm text-fg-muted">{ai.message} The list below is complete without it.</p>
      )}

      {n > 0 && (
        <ul className="divide-y divide-line" aria-label="What stands out">
          {ordered.map((f) => (
            <FindingRow key={f.id} f={f} wording={summary?.reasons[f.id]} />
          ))}
        </ul>
      )}

      <Details label="how this is decided">
        <Rules rules={data.rules} />
      </Details>
    </>
  )
}

function AiSummary({ summary, stage, fingerprint }: { summary: Summary; stage: Stage; fingerprint: string }) {
  const [said, setSaid] = useState<"up" | "down" | null>(null)
  const feedback = useMutation<unknown, ApiError, boolean>({
    mutationFn: (helpful) =>
      api("/api/batch-check-feedback", { method: "POST", json: { stage, fingerprint, helpful } }),
    onSuccess: (_r, helpful) => setSaid(helpful ? "up" : "down"),
  })
  const where = summary.hosted && summary.host ? `${summary.model} via ${summary.host}` : `${summary.model} on the college's own server`
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Chip tone="navy" icon={Sparkles}>
          AI summary
        </Chip>
        <span className="text-xs text-fg-muted">Written by {where}</span>
      </div>
      <p className="text-lead text-fg">{summary.headline}</p>
      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        {said ? (
          <span role="status">Thanks. That helps us judge the summary.</span>
        ) : (
          <>
            <span>Was this useful?</span>
            <Button kind="quiet" size="sm" onClick={() => feedback.mutate(true)} disabled={feedback.isPending} aria-label="Useful">
              <ThumbsUp />
            </Button>
            <Button kind="quiet" size="sm" onClick={() => feedback.mutate(false)} disabled={feedback.isPending} aria-label="Not useful">
              <ThumbsDown />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function FindingRow({ f, wording }: { f: Finding; wording?: string }) {
  const sev = SEVERITY[f.severity]
  return (
    <li className="flex items-start gap-3 py-3" data-kind={f.kind}>
      {f.name ? (
        <Avatar size="md" person={{ name: f.name, initials: initialsOf(f.name), photo_url: f.photo_url ?? null }} />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-sunken text-fg-muted" aria-hidden>
          <Landmark className="size-5" />
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Chip tone={sev.tone}>{sev.word}</Chip>
          <span className="font-medium">{f.title}</span>
        </p>
        {f.name && (
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-fg-muted">
            <span className="truncate">{f.name}</span>
            {f.department && <span>· {f.department}</span>}
            <ClaimNo value={f.ticket_number} copy={false} className="text-xs" />
          </p>
        )}
        {wording && <p className="text-base">{wording}</p>}
        <p className={wording ? "text-sm text-fg-muted" : "text-base"}>{f.reason}</p>
        {f.link && (
          <Button kind="default" size="sm" asChild>
            <Link to={f.link}>{f.claim_id ? "Open claim" : "Open budget"}</Link>
          </Button>
        )}
      </div>
    </li>
  )
}

function Rules({ rules }: { rules: Rules }) {
  return (
    <div className="mt-1 max-w-prose space-y-2 text-sm text-fg-muted">
      <p>
        The list comes from the college's own records: amounts, dates, the calculator and the ledger. It never looks at
        the research office's notes. Nothing here authorises, blocks or pays; you decide.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Amount: at least {money(rules.far_rupees)} and {rules.far_percent}% away from what the calculator gives.
        </li>
        <li>
          Repeat: the same person with the same DOI, or a title at least {rules.title_ratio_percent}% alike, on another
          claim, the ledger or the old payment record.
        </li>
        <li>First payment: nothing yet paid to this person.</li>
        <li>
          Large: more than {rules.large_factor} times what {rules.large_percentile}% of earlier payments for the same
          quartile and department were, and at least {money(rules.large_floor)}.
        </li>
        <li>Budget: the year is already over, or less than {rules.thin_left_percent}% is left once this batch is counted.</li>
        <li>Changed: the amount moved in the last {rules.recent_days} days, or since it was authorised.</li>
      </ul>
      <p>The AI summary rewords and re-orders these. It cannot add to them. Each person can ask for {rules.daily_limit} a day.</p>
    </div>
  )
}
