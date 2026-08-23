"use client"

import { useSearchParams } from "react-router-dom"

import { ClaimDetailFields } from "@/components/claim-detail-fields"
import { JournalLink } from "@/components/journal-link"
import {
  CopyTicketLink,
  Money,
  StatusTimeline,
  formatDateTime,
} from "@/components/ticket-ui"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { actionSentence } from "@/lib/claim-actions"
import { type Claim } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"

/**
 * One ticket's whole life, opened from wherever its number appears.
 *
 * Ticket numbers were already rendered as links on the faculty record — and
 * pointed at `?ticket=<id>`, which nothing on the page read. Clicking one did
 * nothing at all, silently, which is worse than not being a link: the reader
 * concludes the record is empty rather than that the door is unhung.
 *
 * What it shows is the part that was hardest to get at anywhere: the history.
 * Who filed it, who checked it, who approved it, who paid it, each with the
 * date and any note they left. That sequence existed on the payload and was
 * rendered only inside the research cell's own review panel, so a principal
 * or a claimant asking "where has this been" had no way to find out.
 */

type ClaimWithActions = Claim & {
  actions?: {
    id: string
    action: string
    actor_name: string | null
    note: string | null
    created_at: string
  }[]
}

/**
 * The href that opens a ticket from the page you are on.
 *
 * A bare `?ticket=<id>` replaces the whole query string, so on a page that
 * keeps its own state there -- the journal record is addressed by `?title=`
 * -- clicking a ticket threw the page's own identity away and left a screen
 * that could not say what it was showing. Every other parameter is carried.
 */
export function useTicketHref(): (id: string) => string {
  const [params] = useSearchParams()
  return (id: string) => {
    const next = new URLSearchParams(params)
    next.set("ticket", id)
    return `?${next.toString()}`
  }
}

export function TicketDialog({ portal }: { portal: string }) {
  const [params, setParams] = useSearchParams()
  const id = params.get("ticket")

  const { data, isLoading, isError } = useApiQuery<ClaimWithActions>(
    ["claim", id || ""],
    `/api/claims/${id}`,
    { enabled: !!id }
  )

  function close() {
    const next = new URLSearchParams(params)
    next.delete("ticket")
    setParams(next, { replace: true })
  }

  if (!id) return null

  return (
    <Dialog open onOpenChange={(v) => (v ? null : close())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {isLoading ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : isError || !data ? (
          <>
            <DialogHeader>
              <DialogTitle>That ticket could not be opened</DialogTitle>
              <DialogDescription>
                It may have been removed, or it may sit outside what this account is allowed
                to see.
              </DialogDescription>
            </DialogHeader>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6 text-left leading-snug">
                {data.paper_title || "Untitled"}
              </DialogTitle>
              <DialogDescription className="text-left">
                <span className="font-mono">{data.ticket_number || "—"}</span>
                {data.owner_name ? ` · ${data.owner_name}` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              <StatusTimeline status={data.status} />

              <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-[var(--radius)] border border-border bg-muted/40 px-4 py-3">
                <span className="min-w-0 text-sm">
                  <span className="block text-xs text-muted-foreground">Journal</span>
                  <JournalLink title={data.journal_title} portal={portal} />
                </span>
                <span className="text-right">
                  <span className="block text-xs text-muted-foreground">Remuneration</span>
                  <Money value={data.remuneration} size="lg" />
                </span>
              </div>

              {/* The history. The reason this dialog exists. */}
              <div>
                <p className="text-eyebrow">History</p>
                {(data.actions || []).length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Nothing recorded yet — this ticket has not moved since it was filed.
                  </p>
                ) : (
                  <ol className="mt-3 space-y-0">
                    {(data.actions || []).map((a, i, all) => (
                      <li key={a.id} className="flex gap-3">
                        {/* A rail, so the sequence reads as a sequence rather
                            than as a list of unrelated sentences. */}
                        <div className="flex flex-col items-center">
                          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                          {i < all.length - 1 ? (
                            <span className="w-px flex-1 bg-border" />
                          ) : null}
                        </div>
                        <div className="min-w-0 pb-4">
                          <p className="text-sm">
                            <span className="font-medium">{a.actor_name || "Someone"}</span>{" "}
                            <span className="text-muted-foreground">
                              {actionSentence(a.action)}
                            </span>
                          </p>
                          {a.note ? (
                            <p className="mt-1 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs italic">
                              “{a.note}”
                            </p>
                          ) : null}
                          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                            {formatDateTime(a.created_at)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <ClaimDetailFields claim={data} showOwner />

              <div className="flex justify-end border-t border-border pt-3">
                <CopyTicketLink claimId={data.id} />
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
