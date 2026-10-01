import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Eye, Search, SearchX } from "lucide-react"

import { api } from "@/lib/api"
import { useApi, useApiMutation } from "@/lib/query"
import { queryClient } from "@/lib/query"
import { ClaimNo, daysText, useHashScroll } from "@/pages/cell/parts"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog"
import { Field, Input, Textarea } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Section, Rows, Details } from "@/ui/section"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { When } from "@/ui/when"
import { unshout } from "@/lib/names"

/**
 * Journals, as the research cell uses it (docs/jtbd/research-cell-daily.md,
 * job 5): which venues does the college doubt, why, and which claims does that
 * touch? The watch-list comes first, each entry with its reason, who put it
 * there and the claims waiting in it. Below it, the journals the college has
 * published in, with the watched ones marked, so a doubtful venue can be
 * spotted from the list too.
 *
 * Server: /api/admin/journal-watch (backend/core/api/research_cell.py).
 * Every other role keeps the plain list in `pages/journals.tsx`.
 */

export type WatchEntry = {
  id: string
  issn: string | null
  title: string | null
  reason: string
  added_by_name: string | null
  created_at: string | null
  waiting: number
  claims_total: number
  claims_paid: number
  journal_titles: string[]
  waiting_claims: { id: string; ticket_number: string | null; origin: string | null; paper_title: string; owner_name: string; waiting_days: number }[]
}

type JournalRow = { key: string; count: number; amount?: number }

const WATCH_KEY = ["journal-watch"]

export function useWatchList(enabled = true) {
  return useApi<WatchEntry[]>(WATCH_KEY, "/api/admin/journal-watch", { enabled })
}

const label = (w: WatchEntry) => w.title || w.journal_titles[0] || (w.issn ? `ISSN ${w.issn}` : "Journal not named")
const opensAs = (w: WatchEntry) => w.title || w.journal_titles[0] || null

/* ------------------------------------------------------------------------ */
/* Watch a journal                                                           */
/* ------------------------------------------------------------------------ */

/** The form to put a journal on the watch-list. `initial` fills it from a journal page. */
export function WatchDialog({
  open,
  onClose,
  initial,
}: {
  open: boolean
  onClose: () => void
  initial?: { title?: string | null; issn?: string | null }
}) {
  const [issn, setIssn] = useState("")
  const [title, setTitle] = useState("")
  const [reason, setReason] = useState("")
  useEffect(() => {
    if (open) {
      setIssn(initial?.issn ?? "")
      setTitle(initial?.title ?? "")
      setReason("")
    }
  }, [open, initial?.issn, initial?.title])

  const add = useApiMutation<{ issn?: string; title?: string; reason: string }, WatchEntry>("/api/admin/journal-watch", {
    invalidates: [WATCH_KEY, ["clearing-queue"], ["journals-top"], ["journal-watch-for"]],
  })
  const ready = reason.trim().length > 0 && (issn.trim() || title.trim()) && !add.isPending

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try {
      const w = await add.mutateAsync({ issn: issn.trim() || undefined, title: title.trim() || undefined, reason: reason.trim() })
      toast.ok(w.waiting > 0 ? `Watching this journal. ${w.waiting} ${w.waiting === 1 ? "claim" : "claims"} waiting in it now carry a warning.` : "Watching this journal.")
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Watch this journal</DialogTitle>
            <DialogDescription>
              Every claim in it carries a warning at the desk, and batch clearing skips it. Say why, so the next reader knows.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <Field label="ISSN">
                <Input value={issn} onChange={(e) => setIssn(e.target.value)} placeholder="1234-5678" />
              </Field>
              <Field label="Journal title" hint="Needed only if there is no ISSN.">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
            </div>
            <Field label="Why">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="For example: cloned site of a discontinued journal, same ISSN"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" kind="quiet" onClick={onClose} disabled={add.isPending}>
              Cancel
            </Button>
            <Button type="submit" kind="primary" disabled={!ready}>
              {add.isPending ? "Adding…" : "Watch this journal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Take a journal off the watch-list, saying what will change. */
function useTakeOff() {
  const [target, setTarget] = useState<WatchEntry | null>(null)
  const dialog = (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(o) => !o && setTarget(null)}
      title="Take this journal off the watch-list?"
      description={target ? label(target) : ""}
      confirmLabel="Take it off"
      onConfirm={async () => {
        if (!target) return
        try {
          await api(`/api/admin/journal-watch/${target.id}`, { method: "DELETE" })
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: WATCH_KEY }),
            queryClient.invalidateQueries({ queryKey: ["clearing-queue"] }),
            queryClient.invalidateQueries({ queryKey: ["journal-watch-for"] }),
          ])
          toast.ok("Taken off the watch-list.")
        } catch (err) {
          toast.fail(err)
          throw err
        }
      }}
    >
      {target && (
        <p className="text-sm text-fg-muted">
          {target.waiting > 0
            ? `${target.waiting} ${target.waiting === 1 ? "claim" : "claims"} waiting in it will stop carrying a warning and can be cleared in a batch.`
            : "No claim is waiting in it, so nothing changes at the desk."}{" "}
          Why it was watched: {target.reason}
        </p>
      )}
    </ConfirmDialog>
  )
  return { ask: setTarget, dialog }
}

/* ------------------------------------------------------------------------ */
/* The page                                                                  */
/* ------------------------------------------------------------------------ */

export function JournalsDesk({ showMoney }: { showMoney: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (draft) next.set("q", draft)
          else next.delete("q")
          return next
        },
        { replace: true }
      )
    }, 250)
    return () => clearTimeout(t)
  }, [draft, q, setSearchParams])

  const [adding, setAdding] = useState(false)
  const watch = useWatchList()
  const takeOff = useTakeOff()
  const list = useApi<{ results: JournalRow[] }>(["journals-top", q], `/api/journals/top?${new URLSearchParams({ ...(q ? { q } : {}), limit: "500" })}`)

  useHashScroll(!watch.isLoading && !list.isLoading)
  const watched = watch.data ?? []
  const watchedTitles = new Set(watched.flatMap((w) => [w.title, ...w.journal_titles]).filter(Boolean).map((t) => (t as string).toLowerCase()))
  const journals = list.data?.results ?? []
  const waitingInWatched = watched.reduce((s, w) => s + w.waiting, 0)

  const columns: Column<JournalRow>[] = [
    {
      key: "journal",
      header: "Journal",
      className: "w-full sm:max-w-0",
      cell: (j) => (
        <span className="block min-w-0 break-words text-base sm:truncate" title={j.key}>
          {unshout(j.key)}
        </span>
      ),
    },
    {
      key: "watch",
      header: "On the watch-list",
      empty: "No",
      className: "w-40",
      cell: (j) => (watchedTitles.has(j.key.toLowerCase()) ? <span className="font-medium text-caution">Watched</span> : null),
    },
    { key: "count", header: "Papers", align: "right", className: "w-24", cell: (j) => j.count.toLocaleString("en-IN") },
    ...(showMoney
      ? [{ key: "amount", header: "Paid", align: "right" as const, className: "w-32", cell: (j: JournalRow) => money(j.amount) }]
      : []),
  ]

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Journals"
        sub="The venues the research cell doubts, why, and the claims that touches. Below, every journal the college has published in."
        action={
          <Button kind="primary" onClick={() => setAdding(true)}>
            <Eye aria-hidden />
            Watch a journal
          </Button>
        }
        spot="spot-search"
      />

      <Answer
        items={[
          { label: "Journals on the watch-list", value: watch.isLoading ? undefined : watched.length, to: "#watched", zero: "No journal is watched" },
          {
            label: "Claims waiting in a watched journal",
            value: watch.isLoading ? undefined : waitingInWatched,
            to: "/clearing",
            zero: "None waiting in a watched journal",
            tone: "caution",
          },
          { label: "Journals the college has published in", value: list.isLoading || q ? undefined : journals.length, to: "#published" },
        ]}
      />

      <Section
        id="watched"
        title="On the watch-list"
        sub="Suspected clones, venues about to be discontinued, publishers with complaints. Every claim in one carries a warning, and batch clearing skips it."
        className="scroll-mt-6"
      >
        {watch.isLoading ? (
          <SkeletonRows rows={2} rowHeight={72} />
        ) : watch.isError ? (
          <ErrorState title="Could not load the watch-list" message="The server did not answer. Nothing has been changed." onRetry={() => watch.refetch()} />
        ) : watched.length === 0 ? (
          <EmptyState
            illustration="empty-nothing-to-review"
            title="No journal is being watched"
            message="Watch a journal when a venue looks doubtful: a cloned title, one about to be discontinued, a publisher with complaints."
            action={
              <Button kind="default" onClick={() => setAdding(true)}>
                Watch a journal
              </Button>
            }
          />
        ) : (
          <Rows>
            {watched.map((w) => (
              <li key={w.id} className="row py-4 sm:px-2">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                    <p className="break-words text-base font-medium">
                      {opensAs(w) ? (
                        <Link to={`/journals/${encodeURIComponent(opensAs(w) as string)}`} className="underline-offset-4 hover:underline">
                          {label(w)}
                        </Link>
                      ) : (
                        label(w)
                      )}
                      {w.issn && w.title && <span className="ml-2 text-sm font-normal tabular text-fg-muted">ISSN {w.issn}</span>}
                    </p>
                    <p className="mt-1 text-sm">
                      <span className="text-fg-muted">Why: </span>
                      {w.reason}
                    </p>
                    <Meta className="mt-0.5 block">
                      {w.added_by_name ? `Put there by ${w.added_by_name}` : "Put there by a reviewer"}
                      {w.created_at && (
                        <>
                          {" · "}
                          <When iso={w.created_at} />
                        </>
                      )}
                    </Meta>
                  </div>
                  <Button kind="quiet" size="sm" onClick={() => takeOff.ask(w)} aria-label={`Take ${label(w)} off the watch-list`}>
                    Take off the watch-list
                  </Button>
                </div>
                <p className="mt-2 text-sm">
                  <span className={w.waiting > 0 ? "font-medium text-caution" : "text-fg-muted"}>
                    {w.waiting > 0 ? `${w.waiting} ${w.waiting === 1 ? "claim is" : "claims are"} waiting to be cleared` : "Nothing is waiting to be cleared"}
                  </span>
                  <span className="text-fg-muted">
                    {" · "}
                    {w.claims_total.toLocaleString("en-IN")} {w.claims_total === 1 ? "claim" : "claims"} in all, {w.claims_paid.toLocaleString("en-IN")} paid
                  </span>
                </p>
                {w.waiting_claims.length > 0 && (
                  <Details className="mt-1" label="the claims waiting" count={w.waiting}>
                    <Rows>
                      {w.waiting_claims.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
                          <span className="min-w-0 flex-1">
                            <Link to={`/review/${c.id}?queue=clearing`} className="line-clamp-1 break-words underline-offset-4 hover:underline">
                              {unshout(c.paper_title)}
                            </Link>
                            <Meta className="block">
                              {c.owner_name} · <ClaimNo ticket={c.ticket_number} origin={c.origin} />
                            </Meta>
                          </span>
                          <span className="tabular text-fg-muted">{daysText(c.waiting_days)}</span>
                          <Button size="sm" kind="quiet" asChild>
                            <Link to={`/review/${c.id}?queue=clearing`}>Review</Link>
                          </Button>
                        </li>
                      ))}
                    </Rows>
                    {w.waiting > w.waiting_claims.length && (
                      <Meta className="mt-1 block">Showing the oldest {w.waiting_claims.length} of {w.waiting}.</Meta>
                    )}
                  </Details>
                )}
              </li>
            ))}
          </Rows>
        )}
      </Section>

      <Section id="published" title="Where the college publishes" sub="Most-used first. Open one to see its standing and every paper filed in it." className="scroll-mt-6">
        <div className="relative mb-3 w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search journal name" aria-label="Search journals" className="pl-8" />
        </div>
        {list.isLoading ? (
          <SkeletonRows rows={8} rowHeight={48} />
        ) : list.isError ? (
          <ErrorState title="Could not load the journal list" message="The server did not answer. Nothing has been lost." onRetry={() => list.refetch()} />
        ) : journals.length === 0 ? (
          <EmptyState
            art="no-results"
            icon={SearchX}
            title={q ? "No journal matches" : "Nothing published yet"}
            message={q ? "No journal name matches this search. Try a shorter or different term." : "Journals appear here once a paper is filed against one."}
          />
        ) : (
          <>
            <Table rows={journals} columns={columns} getKey={(j) => j.key} rowLink={(j) => `/journals/${encodeURIComponent(j.key)}`} maxHeight="none" minWidth="34rem" caption="Journals the college has published in" />
            {journals.length >= 500 && <Meta className="mt-2 block">Showing the top 500. Narrow the search to find one further down.</Meta>}
          </>
        )}
      </Section>

      <WatchDialog open={adding} onClose={() => setAdding(false)} />
      {takeOff.dialog}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* On one journal's own page                                                 */
/* ------------------------------------------------------------------------ */

/**
 * On a journal's record: whether the research cell watches it and why, with
 * the way to start or stop. Shown only to those who clear claims.
 */
export function WatchNotice({ title, issn }: { title: string; issn: string | null }) {
  const q = useApi<WatchEntry | null>(
    ["journal-watch-for", title, issn ?? ""],
    `/api/admin/journal-watch/for?${new URLSearchParams({ title, ...(issn ? { issn } : {}) })}`
  )
  const [adding, setAdding] = useState(false)
  const takeOff = useTakeOff()
  if (q.isLoading || q.isError) return null
  const w = q.data
  return (
    <section aria-label="Watch-list" className="max-w-prose">
      {w ? (
        <div className="rounded-panel bg-caution-wash px-4 py-3 text-sm">
          <p className="font-medium">On the watch-list</p>
          <p className="mt-0.5">
            <span className="text-fg-muted">Why: </span>
            {w.reason}
          </p>
          <p className="mt-0.5 text-fg-muted">
            {w.added_by_name ? `Put there by ${w.added_by_name}` : "Put there by a reviewer"}
            {w.created_at ? <> · <When iso={w.created_at} /></> : null}. {w.waiting > 0 ? `${w.waiting} ${w.waiting === 1 ? "claim is" : "claims are"} waiting to be cleared.` : "Nothing is waiting to be cleared."}
          </p>
          <Button className="mt-2" size="sm" kind="default" onClick={() => takeOff.ask(w)}>
            Take off the watch-list
          </Button>
        </div>
      ) : (
        <Button kind="default" size="sm" onClick={() => setAdding(true)}>
          <Eye aria-hidden />
          Watch this journal
        </Button>
      )}
      <WatchDialog open={adding} onClose={() => setAdding(false)} initial={{ title, issn }} />
      {takeOff.dialog}
    </section>
  )
}
