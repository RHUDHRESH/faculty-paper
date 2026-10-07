import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ChevronDown, Search } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { AttentionRows, type Attention } from "@/pages/admin-parts"
import { StartList, useStart, type Start } from "@/pages/admin-start"
import { greeting, Waiting, type Claim } from "@/pages/home-staff"
import { HomeTrack } from "@/pages/home-track"
import { AnswerLine, AnswerWord, tieNumbers } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Avatar, initialsOf } from "@/ui/person"
import { Picture } from "@/ui/picture"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"

/**
 * The super admin's first screen (docs/ux/29). One sentence says whether
 * anything is broken or stuck; under it, the list of what needs them, most
 * urgent first, each row one button from the place it is fixed; then where the
 * claims are and which wait on the admin's own desk.
 *
 * On a college that is not yet running (nothing loaded, or a desk with nobody)
 * the sentence is the setup and the list is the "Get the college running"
 * steps, with the next one as the one primary button.
 *
 * Nothing here is recomputed: the list is `/api/admin/attention` (the same
 * service every admin count comes from) and the steps are `/api/admin/start`.
 */

/** True once `ms` have passed, so a fast answer never flashes a skeleton. */
function useAfter(ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(t)
  }, [ms])
  return late
}

const VISIBLE = 5

function days(n: number | null | undefined): string {
  if (n == null) return ""
  if (n <= 0) return "Today"
  return `${n} ${n === 1 ? "day" : "days"}`
}

/** Opens the same finder Ctrl K opens, for the person who does not know the key. */
function openFinder() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))
}

function FindButton() {
  return (
    <Button onClick={openFinder} aria-label="Find a claim, person or payment">
      <Search />
      Find
      <kbd className="ml-1 rounded-sm bg-hover px-1.5 py-0.5 font-mono text-xs text-fg-muted max-sm:hidden">Ctrl K</kbd>
    </Button>
  )
}

function AttentionList({ items, ok }: Pick<Attention, "items" | "ok">) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, VISIBLE)
  const rest = items.length - shown.length
  return (
    <section aria-label="What needs you" className="space-y-3">
      {items.length === 0 ? (
        <div className="flex items-center gap-5 border-y border-line py-6">
          <Picture name="spot-approvals" className="w-24 shrink-0 max-sm:hidden" />
          <p className="text-base text-fg-muted">Come back when a claim is filed or an import is due.</p>
        </div>
      ) : (
        <AttentionRows items={shown} />
      )}
      {rest > 0 && (
        <Button kind="quiet" size="sm" onClick={() => setAll(true)}>
          <ChevronDown />
          Show {rest} more
        </Button>
      )}
      {ok.length > 0 && (
        <details className="group text-sm text-fg-muted">
          <summary className="cursor-pointer list-none underline-offset-4 hover:text-fg hover:underline">
            {ok.length} {ok.length === 1 ? "thing is" : "things are"} in order
          </summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {ok.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function ToClear() {
  const { me } = useAuth()
  const D = HOME_DATA
  const clearing = useApi<Claim[]>(D.clearingQueue.key, D.clearingQueue.path)
  const counts = useApi<{ counts: { filed: number } }>(D.stageCounts.key, D.stageCounts.path)
  const slow = useAfter(300)
  const waiting = counts.data?.counts.filed ?? null
  const rows = (clearing.data ?? [])
    .filter((c) => !me?.id || c.owner_id !== me.id)
    .slice()
    .sort((a, b) => (b.waiting_days ?? 0) - (a.waiting_days ?? 0))
    .slice(0, 5)

  return (
    <Waiting>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <SectionTitle>Waiting to be cleared</SectionTitle>
        <Button asChild size="sm">
          <Link to="/clearing">
            {waiting ? `Open all ${waiting.toLocaleString("en-IN")}` : "Open claims"}
          </Link>
        </Button>
      </div>
      {clearing.isError ? (
        <InlineError message="Could not load the claims waiting to be cleared." onRetry={() => void clearing.refetch()} />
      ) : !clearing.data ? (
        slow ? <Skeleton className="h-52 w-full" /> : <div className="h-52" aria-hidden />
      ) : rows.length === 0 ? (
        <p className="border-y border-line py-6 text-base text-fg-muted">Nothing is waiting to be cleared.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((c) => {
            const d = c.waiting_days ?? null
            return (
              <li key={c.id} className="flex items-center gap-3 py-3 sm:gap-4 sm:px-2">
                <Avatar
                  size="md"
                  person={{
                    name: c.owner_name || "",
                    initials: initialsOf(c.owner_name),
                    photo_url: c.owner_photo_url ?? null,
                  }}
                />
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/review/${c.id}`}
                    className="block truncate text-base font-medium underline-offset-4 hover:underline"
                  >
                    {paperTitle(c.paper_title)}
                  </Link>
                  <Meta className="block truncate">
                    {[c.owner_name, c.owner_department].filter(Boolean).join(" · ")}
                  </Meta>
                </div>
                <span
                  className={cn(
                    "w-16 shrink-0 text-right text-sm tabular text-fg-muted",
                    d != null && d > 30 && "font-medium text-critical",
                    d != null && d > 14 && d <= 30 && "text-caution"
                  )}
                  title={d != null ? `Waiting ${days(d).toLowerCase()}` : undefined}
                >
                  {days(d)}
                </span>
                <Button size="sm" asChild>
                  <Link to={`/review/${c.id}`} aria-label={`Clear: ${paperTitle(c.paper_title)}`}>
                    Clear
                  </Link>
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </Waiting>
  )
}

/** The one sentence. Two short clauses at most; the pill is the word that matters. */
function Sentence({ data }: { data: Attention | undefined }) {
  if (!data) return <AnswerLine>Checking the system.</AnswerLine>
  const n = data.items.length
  if (n === 0) return <AnswerLine>Nothing is broken or stuck.</AnswerLine>
  const urgent = data.items.filter((i) => i.severity === "critical").length
  const head = n === 1 ? "One thing needs you" : `${n.toLocaleString("en-IN")} things need you`
  return (
    <AnswerLine>
      {tieNumbers(head)},{" "}
      {urgent > 0 ? (
        <>
          {tieNumbers(urgent === n ? (n === 1 ? "and it is" : "all") : `${urgent} of them`)}{" "}
          <AnswerWord tone="crimson">urgent</AnswerWord>.
        </>
      ) : (
        <>
          <AnswerWord tone="sage">none urgent</AnswerWord>.
        </>
      )}
    </AnswerLine>
  )
}

/** Not running yet: the sentence is the setup, the list is the steps. */
function SetupHome({ start }: { start: Start }) {
  const next = start.steps.find((s) => s.key === start.next)
  const left = start.total - start.done
  return (
    <>
      <AnswerLine>
        {tieNumbers(left === 1 ? "One step is left" : `${left} steps are left`)}
        {next ? (
          <>
            . Next, <AnswerWord tone="clay">{next.title.toLowerCase()}</AnswerWord>.
          </>
        ) : (
          "."
        )}
      </AnswerLine>
      <StartList data={start} />
    </>
  )
}

export function AdminHome() {
  const { me } = useAuth()
  const attention = useApi<Attention>(HOME_DATA.attention.key, HOME_DATA.attention.path)
  const start = useStart()
  const slow = useAfter(300)

  // "Not running" means nobody can use the system yet: nothing is loaded, or a
  // desk has nobody. A college that only still has to take a backup is running.
  const unready = (k: string) => start.data?.steps.find((s) => s.key === k)?.state !== "done"
  const setup = !!start.data && !start.data.complete && (unready("record") || unready("desks"))

  return (
    <div className="page space-y-10">
      <PageHeader title={greeting(me?.name, me?.placeholder)} spot="spot-home-admin" action={setup ? undefined : <FindButton />} />

      {!start.data && !start.isError ? (
        // Which of the two homes this is depends on /start, so wait for it
        // rather than show the daily list and swap it for the steps.
        slow ? <Skeleton className="h-72 w-full" /> : <div className="h-72" aria-hidden />
      ) : setup && start.data ? (
        <SetupHome start={start.data} />
      ) : (
        <>
          <Sentence data={attention.data} />
          {attention.isError ? (
            <InlineError message="Could not check the system's health." onRetry={() => void attention.refetch()} />
          ) : !attention.data ? (
            slow ? <Skeleton className="h-40 w-full" /> : <div className="h-40" aria-hidden />
          ) : (
            <AttentionList items={attention.data.items} ok={attention.data.ok} />
          )}
          <HomeTrack heading="Where every claim is" />
          <ToClear />
        </>
      )}
    </div>
  )
}
