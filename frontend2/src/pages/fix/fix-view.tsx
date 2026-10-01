import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Send, Wrench } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { ConditionTickList, CONDITION_IDS, type Ticks } from "@/ui/eligibility"
import { Textarea } from "@/ui/field"
import { SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { PreSubmitCheck } from "@/pages/filing/precheck"
import { FixPanel, type FixClaim } from "./fix-panel"
import { fixItemsFor, hashOf, type ClaimantMark, type FixItem } from "./items"
import { MarkedPage } from "./marked-page"
import { saveClaim } from "./upload"

/**
 * A sent-back claim, as a checklist of what to fix.
 *
 * The college's reason is split into the things it asks for (or, once marks
 * exist, one item per claimant-facing mark, with the page and region shown).
 * Each item can be fixed where it stands: replace a file, correct a field, add
 * a reference. "Send again" is enabled when every item is addressed, and it
 * asks for the three filing conditions to be ticked again, every time, before
 * anything is sent. The reviewer sees "the college" and nothing else: no desk,
 * no person, in the items or around them.
 */

type Props = {
  claim: FixClaim & {
    ticket_number: string | null
    /** The college's reason, exactly as written. */
    status_note: string | null
  }
  marks?: ClaimantMark[]
  /** Called after a fix or a send, so the page reloads the claim. */
  onChanged?: () => void
}

/** Which items the claimant has dealt with, kept per send-back so a reload does not lose it. */
function useAddressed(claimId: string, note: string | null) {
  const key = `fix:${claimId}:${hashOf(note ?? "")}`
  const read = useCallback((): string[] => {
    try {
      const raw = localStorage.getItem(key)
      const v: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
    } catch {
      return []
    }
  }, [key])
  const [done, setDone] = useState<string[]>(read)
  useEffect(() => setDone(read()), [read])
  const write = (next: string[]) => {
    setDone(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* private mode: it lasts until the page is left */
    }
  }
  return {
    done,
    mark: (id: string) => write(done.includes(id) ? done : [...done, id]),
    unmark: (id: string) => write(done.filter((d) => d !== id)),
    clear: () => {
      try {
        localStorage.removeItem(key)
      } catch {
        /* nothing to clear */
      }
      setDone([])
    },
  }
}

export function FixView({ claim, marks, onChanged }: Props) {
  const qc = useQueryClient()
  const items = useMemo(() => fixItemsFor(claim.status_note, marks), [claim.status_note, marks])
  const addressed = useAddressed(claim.id, claim.status_note)
  const [open, setOpen] = useState<string | null>(null)
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [changes, setChanges] = useState(0)
  const [sending, setSending] = useState(false)

  const doneCount = items.filter((i) => addressed.done.includes(i.id)).length
  const allDone = items.length === 0 || doneCount === items.length
  const left = items.length - doneCount

  const fileNames = new Map(claim.attachments.map((a) => [a.url, a.filename || null]))

  function afterFix(item: FixItem, summary: string) {
    addressed.mark(item.id)
    setSaved((s) => ({ ...s, [item.id]: summary }))
    setOpen(null)
    setChanges((n) => n + 1)
    toast.ok(`Saved. ${summary}`)
    onChanged?.()
    void qc.invalidateQueries({ queryKey: ["claim", claim.id] })
  }

  return (
    <section id="fix" className="scroll-mt-20 space-y-5" aria-labelledby="fix-title" data-testid="fix-view">
      <div className="space-y-1">
        <SectionTitle>
          <span id="fix-title">Sent back: what to fix</span>
        </SectionTitle>
        <p className="text-base text-fg-muted">
          The college sent this claim back{claim.ticket_number ? ` (claim no. ${claim.ticket_number})` : ""}. Put each
          item right below, then send it again.
        </p>
      </div>

      {items.length > 0 ? (
        <>
          <div className="flex items-center gap-3" role="status" aria-live="polite">
            <p className="text-sm font-medium tabular">
              {doneCount} of {items.length} done
            </p>
            <div aria-hidden className="h-1.5 w-40 max-w-full overflow-hidden rounded-full bg-active">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-2)]"
                style={{ width: `${(doneCount / items.length) * 100}%` }}
              />
            </div>
          </div>

          <ol className="divide-y divide-line border-y border-line" aria-label="What to fix">
            {items.map((item, i) => {
              const isDone = addressed.done.includes(item.id)
              const isOpen = open === item.id
              return (
                <li key={item.id} className="py-4" data-done={isDone ? "true" : undefined}>
                  <div className="flex gap-3">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium tabular",
                        isDone ? "bg-positive text-white" : "bg-caution-wash text-fg"
                      )}
                    >
                      {isDone ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                    </span>
                    <div className="min-w-0 flex-1 space-y-3">
                      <p className={cn("text-base leading-relaxed", isDone && "text-fg-muted")}>
                        {item.body}
                        <span className="sr-only">{isDone ? " (done)" : " (still to do)"}</span>
                      </p>

                      {item.page != null && (
                        <MarkedPage
                          fileUrl={item.fileUrl}
                          fileName={item.fileName ?? (item.fileUrl ? fileNames.get(item.fileUrl) : null)}
                          page={item.page}
                          rect={item.rect}
                          quotedText={item.quotedText}
                        />
                      )}

                      {saved[item.id] && <p className="text-sm text-positive">{saved[item.id]}.</p>}

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          kind={isDone ? "default" : "primary"}
                          size="sm"
                          className="max-sm:h-10"
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : item.id)}
                        >
                          <Wrench />
                          {isDone ? "Fix again" : "Fix this"}
                        </Button>
                        {isDone ? (
                          <Button kind="quiet" size="sm" className="max-sm:h-10" type="button" onClick={() => addressed.unmark(item.id)}>
                            Not done after all
                          </Button>
                        ) : (
                          <Button kind="quiet" size="sm" className="max-sm:h-10" type="button" onClick={() => addressed.mark(item.id)}>
                            Mark as done
                          </Button>
                        )}
                      </div>

                      {isOpen && (
                        <FixPanel
                          claim={claim}
                          item={item}
                          onSaved={(summary) => afterFix(item, summary)}
                          onCancel={() => setOpen(null)}
                        />
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        </>
      ) : (
        <p className="text-base">
          The college did not list separate items. Read the note below, change what it asks, then send it again.
        </p>
      )}

      {claim.status_note && (
        <details className="text-sm">
          <summary className="cursor-pointer select-none font-medium text-accent">
            Read the college&apos;s note as it was written
          </summary>
          <p className="mt-2 whitespace-pre-line border-l-2 border-line pl-3 leading-relaxed text-fg-muted">
            {claim.status_note}
          </p>
        </details>
      )}

      <PreSubmitCheck claimId={claim.id} refreshKey={changes} />

      <div className="flex flex-wrap items-center gap-3">
        <Button kind="primary" size="lg" type="button" disabled={!allDone} onClick={() => setSending(true)}>
          <Send />
          Send again
        </Button>
        <p className="text-sm text-fg-muted" role="status">
          {allDone
            ? "You will confirm the three filing conditions once more before it goes."
            : left === 1
              ? "1 item is still to do. Fix it or mark it as done to send again."
              : `${left} items are still to do. Fix them or mark them as done to send again.`}
        </p>
        <Button kind="quiet" size="sm" asChild className="sm:ml-auto">
          <Link to={`/papers/${claim.id}/edit`}>Edit everything in the filing form</Link>
        </Button>
      </div>

      <SendAgain
        open={sending}
        onOpenChange={setSending}
        claim={claim}
        onSent={() => {
          addressed.clear()
          setSending(false)
          toast.ok(
            claim.ticket_number
              ? `Sent again. Claim no. ${claim.ticket_number} is with the college`
              : "Sent again. It is with the college"
          )
          onChanged?.()
          for (const key of [["claim", claim.id], ["claims"], ["claims-counts"], ["my-claims"]]) {
            void qc.invalidateQueries({ queryKey: key })
          }
        }}
      />
    </section>
  )
}

/** The last step: the three conditions ticked again, then the claim goes. */
function SendAgain({
  open,
  onOpenChange,
  claim,
  onSent,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  claim: FixClaim
  onSent: () => void
}) {
  const [ticks, setTicks] = useState<Ticks>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [note, setNote] = useState("")
  // Asked for only when the server could not confirm the paper on its own.
  const needsNote = !!error && /auto-confirm/i.test(error)

  const { data: rules } = useQuery({
    queryKey: ["meta", "filing-rules"],
    queryFn: () => api<{ conditions_version: string; min_sec_references: number }>("/api/meta/filing-rules"),
    staleTime: 10 * 60_000,
  })

  useEffect(() => {
    if (open) {
      setTicks({})
      setError(null)
      setTried(false)
      setNote("")
    }
  }, [open])

  const missing = CONDITION_IDS.filter((id) => !ticks[id]).length

  async function send() {
    if (missing > 0) {
      setTried(true)
      return
    }
    if (needsNote && note.trim().length < 10) {
      setTried(true)
      return
    }
    setBusy(true)
    try {
      await saveClaim(claim.id, {
        submit: true,
        ...(needsNote ? { contest_forward: true, contest_note: note.trim() } : {}),
        confirmations: CONDITION_IDS.map((id) => ({
          id,
          text_version: rules?.conditions_version ?? "2026-09",
          ticked_at: ticks[id],
        })),
      })
      onSent()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "It could not be sent. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Send this claim again?</DialogTitle>
          <DialogDescription>
            It goes back to the college to be checked. Tick each condition yourself; they are asked every time a claim is sent.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <ConditionTickList
            minReferences={rules?.min_sec_references ?? 2}
            ticks={ticks}
            onChange={(t) => {
              setTicks(t)
            }}
          />
          {needsNote && (
            <div className="space-y-1.5">
              <label htmlFor="resend-note" className="block text-sm font-medium">
                A note for the checkers
              </label>
              <Textarea
                id="resend-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="For example: checked against the published PDF, two authors, I am the first."
              />
              <p className="text-xs text-fg-muted">
                {tried && note.trim().length < 10
                  ? "Write a line or two, at least ten characters, then send again."
                  : "The paper could not be confirmed automatically, so the checkers read this instead."}
              </p>
            </div>
          )}
          {tried && missing > 0 && (
            <p role="alert" className="text-sm text-critical">
              {missing === 1 ? "One condition is not ticked yet." : `${missing} conditions are not ticked yet.`} Tick each one
              once you have checked it is true for this article.
            </p>
          )}
          {error && (
            <div role="alert" className="space-y-1 rounded-md bg-critical-wash px-3 py-2 text-sm">
              <p>{error}</p>
              {/* A field the form needs that this view has no box for. */}
              <p>
                <Link to={`/papers/${claim.id}/edit`} className="font-medium text-accent underline underline-offset-2">
                  Open the filing form to put it right
                </Link>
              </p>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" type="button" onClick={() => onOpenChange(false)} disabled={busy}>
            Not yet
          </Button>
          <Button kind="primary" type="button" onClick={() => void send()} disabled={busy}>
            {busy ? "Sending…" : "Send again"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
