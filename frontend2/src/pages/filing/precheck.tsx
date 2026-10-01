import { useEffect, useRef } from "react"
import { useMutation } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"

/**
 * What the reviewer will look for, judged now, before the claim is sent.
 *
 * The server reads the claim's PDFs and lists what a reviewer's first look
 * will catch: the college's affiliation line in the paper's text, the SEC
 * references numbered, and the author position against the record. It is a
 * warning list and nothing else. It never ticks one of the three filing
 * conditions, never blocks sending, and every finding says what to do. A
 * "could not tell" is shown as that, never as a problem: a scanned PDF is not
 * a wrong PDF.
 */
export type PrecheckFinding = {
  key: string
  status: "ok" | "warn" | "unknown"
  title: string
  detail: string
}

export type PrecheckResult = {
  warnings: number
  findings: PrecheckFinding[]
  note: string
}

const ICON = {
  ok: { Icon: CheckCircle2, tone: "text-positive", word: "Looks right" },
  warn: { Icon: AlertTriangle, tone: "text-caution", word: "Look at this" },
  unknown: { Icon: CircleHelp, tone: "text-fg-muted", word: "Could not tell" },
} as const

export function summarise(r: PrecheckResult): string {
  const warn = r.warnings
  const unknown = r.findings.filter((f) => f.status === "unknown").length
  const ok = r.findings.filter((f) => f.status === "ok").length
  if (warn === 0 && unknown === 0) return "Nothing here should bring the claim back."
  const parts: string[] = []
  if (warn) parts.push(warn === 1 ? "1 thing to look at" : `${warn} things to look at`)
  if (unknown) parts.push(unknown === 1 ? "1 the check could not judge" : `${unknown} the check could not judge`)
  if (ok) parts.push(`${ok} look right`)
  return `${parts.join(", ")}.`
}

export function PreSubmitCheck({
  claimId,
  refreshKey,
  className,
}: {
  /** The saved claim to read. Null until the draft exists. */
  claimId: string | null | undefined
  /** Anything that changes when the claim was saved again, so the check re-reads it. */
  refreshKey?: string | number | null
  className?: string
}) {
  const run = useMutation<PrecheckResult, ApiError, string>({
    mutationFn: (id) => api<PrecheckResult>(`/api/claims/${id}/precheck`, { method: "POST" }),
  })
  const { mutate } = run
  const last = useRef<string | null>(null)

  useEffect(() => {
    if (!claimId) return
    const key = `${claimId}:${refreshKey ?? ""}`
    if (last.current === key) return
    last.current = key
    mutate(claimId)
  }, [claimId, refreshKey, mutate])

  const result = run.data
  return (
    <section className={cn("space-y-3", className)} aria-labelledby="precheck-title" data-testid="precheck">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="precheck-title" className="text-base font-semibold">
          What the reviewer will look for
        </h3>
        {claimId && (
          <Button
            kind="quiet"
            size="sm"
            type="button"
            onClick={() => mutate(claimId)}
            disabled={run.isPending}
          >
            <RefreshCw className={cn(run.isPending && "animate-spin")} aria-hidden />
            Check again
          </Button>
        )}
      </div>

      {!claimId ? (
        <p className="text-sm text-fg-muted">
          Your files are read once the draft is saved. Attach the paper and its references first.
        </p>
      ) : run.isPending && !result ? (
        <p className="text-sm text-fg-muted" role="status">
          Reading your files…
        </p>
      ) : run.isError && !result ? (
        <p className="text-sm text-fg-muted">
          The check could not run just now. Nothing is wrong with your claim, and you can still send it.
        </p>
      ) : result ? (
        <>
          <p className="text-sm text-fg-muted" role="status">
            {summarise(result)}
          </p>
          <ul className="divide-y divide-line border-y border-line">
            {result.findings.map((f) => {
              const { Icon, tone, word } = ICON[f.status]
              return (
                <li key={f.key} className="flex gap-3 py-3" data-status={f.status}>
                  <Icon className={cn("mt-0.5 size-5 shrink-0", tone)} aria-hidden />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      <span className="sr-only">{word}: </span>
                      {f.title}
                    </p>
                    {f.status !== "ok" && (
                      <p className="mt-0.5 text-sm leading-relaxed text-fg-muted">{f.detail}</p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-fg-muted">{result.note}</p>
        </>
      ) : null}
    </section>
  )
}
