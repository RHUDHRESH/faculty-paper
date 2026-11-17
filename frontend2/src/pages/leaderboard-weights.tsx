import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Info, Minus, SlidersHorizontal } from "lucide-react"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Field, NumberInput, Textarea } from "@/ui/field"
import { Avatar, type PersonBrief } from "@/ui/person"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/ui/sheet"
import { ErrorState, InlineError, SkeletonRows } from "@/ui/state"
import { toast } from "@/ui/toast"
import { SectionTitle } from "@/ui/text"
import type { HonoursBoard } from "@/pages/leaderboard"

/**
 * The leaderboard's weights (docs/ux: the research coordinator decides how
 * much SNIP, years of publishing and the rest count towards the overall
 * score). Two parts:
 *
 *  - `WeightsButton`: a separate button, for the research coordinator and the
 *    super admin only, opening a full-height panel to change, preview, save,
 *    reset and read the history.
 *  - `HowScored`: for everybody, a read-only account of the current weights
 *    and, for the reader's own row, the points from each factor.
 *
 * The server holds every rule (whole numbers, adding up to 100, a note). This
 * side only keeps Save from being pressed before it could work.
 */

export type Factor = { key: string; name: string; meaning: string; default: number }
export type WeightsEntry = {
  version: number
  weights: Record<string, number>
  reason: string | null
  saved_by: { id: string; name: string } | null
  saved_at: string | null
  applies_from: string | null
}
export type WeightsState = {
  current: WeightsEntry
  catalogue: Factor[]
  defaults: Record<string, number>
  history: WeightsEntry[]
  normalisation: string
  source: string
  can_edit: boolean
}
export type PreviewRow = {
  rank: number
  joint: boolean
  person: PersonBrief
  score: number
  was?: number | null
  becomes?: number | null
  change: number | null
}
export type Preview = { current: PreviewRow[]; proposed: PreviewRow[]; saved: false; scope: string | null }

export const SUM_MESSAGE = "Weights must add up to 100"
const EDITORS = ["RESEARCH_COORDINATOR", "SUPER_ADMIN"]
const WEIGHTS_KEY = ["leaderboard", "weights"] as const

export function canSetWeights(role: string | undefined): boolean {
  return !!role && EDITORS.includes(role)
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0)
export const totalOf = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0)

function stamp(iso: string | null): string {
  if (!iso) return ""
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
}

/** "1 Nov 2026", the day the college's Scopus profiles were last synced. */
export function syncedOn(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : ""
}

/* ------------------------------------------------------------------------ */
/* The coordinator's panel                                                    */
/* ------------------------------------------------------------------------ */

export function WeightsButton({ period, department }: { period: string; department: string }) {
  const { me } = useAuth()
  const [open, setOpen] = useState(false)
  if (!canSetWeights(me?.role)) return null
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button kind="default" size="sm">
          <SlidersHorizontal aria-hidden /> Weights
        </Button>
      </SheetTrigger>
      <SheetContent className="sm:w-[48rem] sm:max-w-[96vw]">
        <WeightsPanel period={period} department={department} />
      </SheetContent>
    </Sheet>
  )
}

function WeightsPanel({ period, department }: { period: string; department: string }) {
  const qc = useQueryClient()
  const state = useApi<WeightsState>(WEIGHTS_KEY, "/api/leaderboard/weights")
  const [draft, setDraft] = useState<Record<string, number> | null>(null)
  const [note, setNote] = useState("")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [problem, setProblem] = useState("")

  const data = state.data
  const weights = draft ?? data?.current.weights ?? {}
  const total = totalOf(weights)
  const adds = total === 100
  const edited = draft !== null

  const afterWrite = (next: WeightsState, message: string) => {
    qc.setQueryData(WEIGHTS_KEY, next)
    void qc.invalidateQueries({ queryKey: ["leaderboard"] })
    setDraft(null)
    setNote("")
    setPreview(null)
    setProblem("")
    toast.ok(message)
  }
  const fail = (e: unknown) => setProblem(e instanceof Error ? e.message : "Something went wrong. Please try again.")

  const save = useApiMutation<{ weights: Record<string, number>; reason: string }, WeightsState>("/api/leaderboard/weights", { method: "PUT" })
  const reset = useApiMutation<Record<string, never>, WeightsState>("/api/leaderboard/weights/reset")
  const previewIt = useApiMutation<{ weights: Record<string, number>; period: string; department: string }, Preview>("/api/leaderboard/weights/preview")

  const set = (key: string, value: number) => {
    setDraft({ ...weights, [key]: clamp(value) })
    setPreview(null)
    setProblem("")
  }

  if (state.isError) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Leaderboard weights</SheetTitle>
          <SheetDescription>How much each factor counts towards the overall score.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <ErrorState title="Could not load the weights." onRetry={() => void state.refetch()} />
        </SheetBody>
      </>
    )
  }

  const canSave = adds && note.trim().length > 0 && edited && !save.isPending

  return (
    <>
      <SheetHeader>
        <SheetTitle>Leaderboard weights</SheetTitle>
        <SheetDescription>
          How much each factor counts towards the overall score. The weights are percents and must add up to 100.
          They apply from the moment you save.
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="space-y-8">
        {!data ? (
          <SkeletonRows rows={6} />
        ) : (
          <>
            <section aria-label="Weights" className="space-y-1">
              <ul className="divide-y divide-line">
                {data.catalogue.map((f) => (
                  <FactorRow key={f.key} factor={f} value={weights[f.key] ?? 0} onChange={(v) => set(f.key, v)} />
                ))}
              </ul>
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-3">
                <p className="text-base font-semibold text-fg" aria-live="polite">
                  Total <span className="tabular-nums">{total}</span> of 100
                </p>
                {adds ? null : (
                  <p role="alert" className="text-sm font-medium text-critical">
                    {SUM_MESSAGE}
                  </p>
                )}
              </div>
              <p className="flex gap-2 pt-2 text-sm text-fg-muted">
                <Info aria-hidden className="mt-0.5 size-4" />
                <span>{data.normalisation}</span>
              </p>
            </section>

            <section aria-label="Save" className="space-y-3">
              <Field label="Why are you changing the weights?" hint="Required. Everyone on the history below can read it.">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} required />
              </Field>
              {problem ? <InlineError message={problem} /> : null}
            </section>

            {preview ? <PreviewView preview={preview} /> : null}

            <History entries={data.history} catalogue={data.catalogue} />
          </>
        )}
      </SheetBody>
      <SheetFooter className="flex-wrap justify-between">
        <Button
          kind="quiet"
          disabled={!data || reset.isPending}
          onClick={() => {
            if (!window.confirm("Put the weights back to the college's starting weights?")) return
            reset.mutate({}, { onSuccess: (next) => afterWrite(next, "Weights reset to the starting weights"), onError: fail })
          }}
        >
          Reset to default
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            kind="default"
            disabled={!data || !adds || previewIt.isPending}
            loading={previewIt.isPending}
            onClick={() =>
              previewIt.mutate(
                { weights, period, department },
                { onSuccess: (p) => { setPreview(p); setProblem("") }, onError: fail }
              )
            }
          >
            Preview
          </Button>
          <Button
            kind="primary"
            disabled={!canSave}
            loading={save.isPending}
            onClick={() =>
              save.mutate({ weights, reason: note.trim() }, { onSuccess: (next) => afterWrite(next, "Weights saved"), onError: fail })
            }
          >
            Save
          </Button>
        </div>
      </SheetFooter>
    </>
  )
}

function FactorRow({ factor, value, onChange }: { factor: Factor; value: number; onChange: (v: number) => void }) {
  const id = `w-${factor.key}`
  return (
    <li className="grid gap-x-4 gap-y-2 py-4 grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-base font-medium text-fg">
          {factor.name}
        </label>
        <p className="text-sm text-fg-muted">{factor.meaning}</p>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={`${factor.name}, percent of the score`}
          aria-valuetext={`${value} percent`}
          className="h-6 min-w-0 flex-1 accent-accent"
        />
        <div className="w-20 shrink-0">
          <NumberInput
            id={id}
            min={0}
            max={100}
            step={1}
            value={value}
            unit="%"
            size="md"
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Preview: before and after                                                  */
/* ------------------------------------------------------------------------ */

export function Moved({ change }: { change: number | null | undefined }) {
  if (change == null)
    return <span className="inline-flex items-center gap-1 text-sm text-fg-muted">New in the top 20</span>
  if (change === 0)
    return (
      <span className="inline-flex items-center gap-1 text-sm text-fg-muted">
        <Minus aria-hidden className="size-4" /> Same place
      </span>
    )
  const up = change > 0
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm font-medium", up ? "text-positive" : "text-critical")}>
      {up ? <ArrowUp aria-hidden className="size-4" /> : <ArrowDown aria-hidden className="size-4" />}
      <span className="tabular-nums">{Math.abs(change)}</span>
      <span className="sr-only">{up ? ` places up` : ` places down`}</span>
    </span>
  )
}

function PreviewView({ preview }: { preview: Preview }) {
  return (
    <section aria-label="Preview" className="space-y-3">
      <SectionTitle>Preview of the top 20</SectionTitle>
      <p className="text-sm text-fg-muted">Nothing is saved until you press Save.</p>
      <div className="grid gap-6 grid-cols-[minmax(0,1fr)] md:grid-cols-2">
        <PreviewList title="With the saved weights" rows={preview.current} />
        <PreviewList title="With these weights" rows={preview.proposed} moved />
      </div>
    </section>
  )
}

function PreviewList({ title, rows, moved = false }: { title: string; rows: PreviewRow[]; moved?: boolean }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-base font-semibold text-fg">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">Nobody is ranked yet.</p>
      ) : (
        <ol className="divide-y divide-line" aria-label={title}>
          {rows.map((r) => (
            <li key={r.person.id} className="flex items-center gap-2 py-1.5">
              <span className="w-7 shrink-0 text-right text-sm tabular-nums text-fg-muted">{r.joint ? `=${r.rank}` : r.rank}</span>
              <Avatar person={r.person} size="xs" />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.person.name}</span>
              <span className="shrink-0 text-sm tabular-nums text-fg-muted">{r.score.toFixed(1)}</span>
              {moved ? <Moved change={r.change} /> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* History                                                                    */
/* ------------------------------------------------------------------------ */

function History({ entries, catalogue }: { entries: WeightsEntry[]; catalogue: Factor[] }) {
  const name = (k: string) => catalogue.find((f) => f.key === k)?.name ?? k
  return (
    <section aria-label="History" className="space-y-3">
      <SectionTitle>History</SectionTitle>
      {entries.length === 0 ? (
        <p className="text-sm text-fg-muted">The weights have not been changed since the college started with its own.</p>
      ) : (
        <ol className="space-y-4">
          {entries.map((e) => {
            const used = Object.entries(e.weights).filter(([, w]) => w > 0)
            return (
              <li key={e.version} className="space-y-1 border-l-2 border-line pl-3">
                <p className="text-sm text-fg">
                  <span className="font-medium">{e.saved_by?.name ?? "Someone"}</span>
                  <span className="text-fg-muted"> on {stamp(e.saved_at)}</span>
                </p>
                {e.reason ? <p className="text-sm text-fg">{e.reason}</p> : null}
                <p className="text-sm text-fg-muted">{used.map(([k, w]) => `${name(k)} ${w}`).join(", ")}</p>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Everybody: how the board is scored                                         */
/* ------------------------------------------------------------------------ */

export function HowScored({ board }: { board: HonoursBoard | undefined }) {
  const { me } = useAuth()
  const scoring = board?.method.scoring
  const mine = board && board.measure === "score" ? board.rows.find((r) => r.person.id === me?.id) : undefined
  const points = new Map((mine?.contributions ?? []).map((c) => [c.factor, c.points]))
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button kind="quiet" size="sm" disabled={!board}>
          How the leaderboard is scored
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>How the leaderboard is scored</SheetTitle>
          <SheetDescription>{board?.method.source ?? "Counted from Scopus-linked papers only"}. The overall score runs from 0 to 100.</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-4 text-sm">
          {scoring ? (
            <>
              <ul className="divide-y divide-line" aria-label="Weights in force">
                {scoring.weights.map((w) => (
                  <li key={w.key} className="space-y-0.5 py-3">
                    <p className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-base font-medium text-fg">{w.name}</span>
                      <span className="tabular-nums text-fg">{w.weight}%</span>
                    </p>
                    <p className="text-fg-muted">{w.meaning}</p>
                    {mine ? (
                      <p className="text-fg">
                        Your points: <span className="font-medium tabular-nums">{(points.get(w.key) ?? 0).toFixed(1)}</span> of {w.weight}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
              {mine ? (
                <p className="font-medium text-fg">
                  Your score: <span className="tabular-nums">{mine.value.toFixed(1)}</span>
                </p>
              ) : board?.measure !== "score" ? (
                <p className="text-fg-muted">Open the Overall board to see your points from each factor.</p>
              ) : (
                <p className="text-fg-muted">You are not on this board, so there are no points to show.</p>
              )}
              <p className="text-fg-muted">{scoring.normalisation}</p>
            </>
          ) : (
            <SkeletonRows rows={5} />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
