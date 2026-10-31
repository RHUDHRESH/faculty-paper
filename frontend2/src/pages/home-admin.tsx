import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ChevronDown, Search } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { SEVERITY_WORD, unitFor, type Attention, type AttentionItem } from "@/pages/admin-parts"
import { StartList, useStart, type Start } from "@/pages/admin-start"
import { greeting, type Claim } from "@/pages/home-staff"
import { HomeTrack } from "@/pages/home-track"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Section } from "@/ui/section"
import { InlineError, Skeleton } from "@/ui/state"
import { Table, type Column } from "@/ui/table"

/**
 * The super admin's first screen (docs/ux/29). Three figures say whether
 * anything is broken or stuck; one table lists what needs them, most urgent
 * first, each row one button from the place it is fixed; a second lists the
 * claims waiting on the admin's own desk, and the stage counts sit below.
 *
 * On a college that is not yet running (nothing loaded, or a desk with nobody)
 * the page is the "Get the college running" steps, with the next one as the
 * one primary button.
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

const VISIBLE = 10

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
    <Button kind="primary" onClick={openFinder} aria-label="Find a claim, person or payment">
      <Search />
      Find
      <kbd className="ml-1 rounded-sm bg-hover px-1.5 py-0.5 font-mono text-xs text-fg-muted max-sm:hidden">Ctrl K</kbd>
    </Button>
  )
}

const SEVERITY_TEXT: Record<AttentionItem["severity"], string> = {
  critical: "text-critical",
  warning: "text-caution",
  info: "text-fg-muted",
}

const ATTENTION_COLUMNS: Column<AttentionItem>[] = [
  {
    key: "title",
    header: "What needs you",
    exportValue: (i) => i.title,
    cell: (i) => (
      <span data-testid={`attention-${i.key}`}>
        <Link to={i.to} className="font-medium text-fg underline-offset-4 hover:underline">
          {i.title}
        </Link>
        <span className="block text-sm text-fg-muted" title={i.why}>
          {i.why}
        </span>
        {i.legacy ? (
          <Link to={i.to} className="block text-xs text-fg-muted underline-offset-4 hover:underline">
            {i.legacy.toLocaleString("en-IN")} more from before this system
          </Link>
        ) : null}
      </span>
    ),
  },
  {
    key: "severity",
    header: "How urgent",
    exportValue: (i) => SEVERITY_WORD[i.severity],
    cell: (i) => <span className={cn("font-medium", SEVERITY_TEXT[i.severity])}>{SEVERITY_WORD[i.severity]}</span>,
  },
  {
    key: "count",
    header: "How many",
    align: "right",
    empty: "Not counted",
    exportValue: (i) => i.count,
    cell: (i) =>
      i.count != null ? (
        <span>
          <span className="font-semibold">{i.count.toLocaleString("en-IN")}</span>
          {i.unit && <span className="ml-1 text-fg-muted">{unitFor(i.count, i.unit)}</span>}
        </span>
      ) : null,
  },
  {
    key: "action",
    header: "Action",
    label: "Fix it",
    cell: (i) => (
      <Button asChild size="sm" kind="default">
        <Link to={i.to} aria-label={`${i.action}: ${i.title}`}>
          {i.action}
        </Link>
      </Button>
    ),
  },
]

function AttentionList({ items, ok }: Pick<Attention, "items" | "ok">) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, VISIBLE)
  const rest = items.length - shown.length
  return (
    <Section id="attention" title="What needs you" className="scroll-mt-6">
      <Table
        rows={shown}
        columns={ATTENTION_COLUMNS}
        getKey={(i) => i.key}
        tools={{ id: "admin-home", title: "What needs you" }}
        empty={<p className="py-6 text-base text-fg-muted">Nothing is broken or stuck. Come back when a claim is filed or an import is due.</p>}
      />
      {rest > 0 && (
        <Button kind="quiet" size="sm" className="mt-2" onClick={() => setAll(true)}>
          <ChevronDown />
          Show {rest} more
        </Button>
      )}
      {ok.length > 0 && (
        <details className="group mt-3 text-sm text-fg-muted">
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
    </Section>
  )
}

function ToClear() {
  const { me } = useAuth()
  const D = HOME_DATA
  const clearing = useApi<Claim[]>(D.clearingQueue.key, D.clearingQueue.path)
  const counts = useApi<{ counts: { filed: number } }>(D.stageCounts.key, D.stageCounts.path)
  const waiting = counts.data?.counts.filed ?? null
  const rows = (clearing.data ?? [])
    .filter((c) => !me?.id || c.owner_id !== me.id)
    .slice()
    .sort((a, b) => (b.waiting_days ?? 0) - (a.waiting_days ?? 0))
    .slice(0, VISIBLE)

  const columns: Column<Claim>[] = [
    {
      key: "paper",
      header: "Claim",
      exportValue: (c) => paperTitle(c.paper_title),
      cell: (c) => (
        <Link to={`/review/${c.id}`} className="font-medium text-fg underline-offset-4 hover:underline">
          {paperTitle(c.paper_title)}
        </Link>
      ),
    },
    {
      key: "owner",
      header: "Claimant",
      exportValue: (c) => [c.owner_name, c.owner_department].filter(Boolean).join(", "),
      cell: (c) => [c.owner_name, c.owner_department].filter(Boolean).join(", "),
    },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      exportValue: (c) => c.waiting_days ?? null,
      cell: (c) => {
        const d = c.waiting_days ?? null
        return (
          <span
            className={cn(d != null && d > 30 && "font-medium text-critical", d != null && d > 14 && d <= 30 && "text-caution")}
            title={d != null ? `Waiting ${days(d).toLowerCase()}` : undefined}
          >
            {days(d)}
          </span>
        )
      },
    },
    {
      key: "action",
      header: "Action",
      label: "Clear",
      cell: (c) => (
        <Button kind="default" size="sm" asChild>
          <Link to={`/review/${c.id}`} aria-label={`Clear: ${paperTitle(c.paper_title)}`}>
            Clear
          </Link>
        </Button>
      ),
    },
  ]

  return (
    <Section
      title="Waiting to be cleared"
      action={
        <Link to="/clearing" className="text-sm text-accent underline-offset-4 hover:underline">
          View all{waiting != null ? ` ${waiting.toLocaleString("en-IN")}` : ""}
        </Link>
      }
    >
      {clearing.isError ? (
        <InlineError message="Could not load the claims waiting to be cleared." onRetry={() => void clearing.refetch()} />
      ) : !clearing.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <Table
          rows={rows}
          columns={columns}
          getKey={(c) => c.id}
          tools={{ id: "admin-home-clear", title: "Waiting to be cleared" }}
          empty={<p className="py-6 text-base text-fg-muted">Nothing is waiting to be cleared.</p>}
        />
      )}
    </Section>
  )
}

/** Not running yet: the steps, with the next one as the one primary button. */
function SetupHome({ start }: { start: Start }) {
  const next = start.steps.find((s) => s.key === start.next)
  const left = start.total - start.done
  return (
    <Section
      title="Get the college running"
      sub={`${left === 1 ? "One step is left" : `${left} steps are left`}${next ? `. Next: ${next.title.toLowerCase()}.` : "."}`}
      showSub
    >
      <StartList data={start} />
    </Section>
  )
}

export function AdminHome() {
  const { me } = useAuth()
  const attention = useApi<Attention>(HOME_DATA.attention.key, HOME_DATA.attention.path)
  const counts = useApi<{ counts: { filed: number } }>(HOME_DATA.stageCounts.key, HOME_DATA.stageCounts.path)
  const start = useStart()
  const slow = useAfter(300)

  // "Not running" means nobody can use the system yet: nothing is loaded, or a
  // desk has nobody. A college that only still has to take a backup is running.
  const unready = (k: string) => start.data?.steps.find((s) => s.key === k)?.state !== "done"
  const setup = !!start.data && !start.data.complete && (unready("record") || unready("desks"))

  const items = attention.data?.items
  const urgent = items ? items.filter((i) => i.severity === "critical").length : undefined

  return (
    <div className="page space-y-8">
      <PageHeader
        title={greeting(me?.name, me?.placeholder)}
        sub={setup ? "Finish these steps so everyone can start using it." : "Whether anything is broken or stuck, and what waits at the desks."}
        action={setup ? undefined : <FindButton />}
      />

      {!start.data && !start.isError ? (
        // Which of the two homes this is depends on /start, so wait for it
        // rather than show the daily list and swap it for the steps.
        slow ? <Skeleton className="h-72 w-full" /> : <div className="h-72" aria-hidden />
      ) : setup && start.data ? (
        <SetupHome start={start.data} />
      ) : (
        <>
          <Answer
            items={[
              { value: items?.length, label: "Things need you", zero: "Nothing is broken or stuck", to: "/#attention" },
              { value: urgent, label: "Urgent", zero: "None urgent", to: "/#attention", tone: "critical" },
              { value: counts.data?.counts.filed, label: "Waiting to be cleared", zero: "Nothing is waiting", to: "/clearing" },
            ]}
          />
          {attention.isError ? (
            <InlineError message="Could not check the system's health." onRetry={() => void attention.refetch()} />
          ) : !attention.data ? (
            slow ? <Skeleton className="h-40 w-full" /> : <div className="h-40" aria-hidden />
          ) : (
            <AttentionList items={attention.data.items} ok={attention.data.ok} />
          )}
          <ToClear />
          <HomeTrack heading="Where every claim is" list={false} />
        </>
      )}
    </div>
  )
}
