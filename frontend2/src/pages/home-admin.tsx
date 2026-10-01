import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ChevronDown } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { AttentionRows, type Attention } from "@/pages/admin-parts"
import { HomeHead, Waiting, type Claim } from "@/pages/home-staff"
import { HomeTrack } from "@/pages/home-track"
import { Button } from "@/ui/button"
import { Avatar, initialsOf } from "@/ui/person"
import { Answer } from "@/ui/answer"
import { Picture } from "@/ui/picture"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"

/**
 * The super admin's first screen. It answers one question: is anything broken
 * or stuck, and where do I fix it?
 *
 * The answer is a list, most urgent first, and each row is one click from the
 * place it is fixed. Under it, where the claims are and which of them wait on
 * the admin's own desk. Nothing here is recomputed: the list comes from
 * `/api/admin/attention`, the same service the Admin page reads, so a number
 * here is the number there.
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

function AttentionSection() {
  const q = useApi<Attention>(HOME_DATA.attention.key, HOME_DATA.attention.path)
  const slow = useAfter(300)
  const [all, setAll] = useState(false)

  if (q.isError) {
    return <InlineError message="Could not check the system's health." onRetry={() => void q.refetch()} />
  }
  if (!q.data) {
    return slow ? <Skeleton className="h-40 w-full" /> : <div className="h-40" aria-hidden />
  }
  const { items, ok } = q.data
  const shown = all ? items : items.slice(0, VISIBLE)
  const rest = items.length - shown.length

  return (
    <section aria-labelledby="attention-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <SectionTitle>
          <span id="attention-title">
            {items.length === 0
              ? "Nothing needs you"
              : items.length === 1
                ? "One thing needs attention"
                : `${items.length} things need attention`}
          </span>
        </SectionTitle>
        {items.length > 0 && <Meta>Most urgent first. Each row opens where it is fixed.</Meta>}
      </div>

      {items.length === 0 ? (
        <div className="flex items-center gap-5 border-y border-line py-6">
          <Picture name="spot-approvals" className="w-24 shrink-0 max-sm:hidden" />
          <p className="text-base text-fg-muted">
            Every desk has a person, nothing is stuck and the record adds up. Come back when a claim is
            filed or an import is due.
          </p>
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <SectionTitle>Waiting to be cleared</SectionTitle>
        <Link to="/clearing" className="text-sm text-accent underline-offset-4 hover:underline">
          {waiting
            ? `Open all ${waiting.toLocaleString("en-IN")} ${waiting === 1 ? "claim" : "claims"}, oldest first`
            : "Open claims"}
        </Link>
      </div>
      {clearing.isError ? (
        <InlineError message="Could not load the claims waiting to be cleared." onRetry={() => void clearing.refetch()} />
      ) : !clearing.data ? (
        slow ? <Skeleton className="h-52 w-full" /> : <div className="h-52" aria-hidden />
      ) : rows.length === 0 ? (
        <p className="border-y border-line py-6 text-base text-fg-muted">
          Nothing is waiting to be cleared. A claim appears here the moment it is filed.
        </p>
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

/** The four figures that answer "is anything broken or stuck?" at a glance. */
function AtAGlance() {
  const attention = useApi<Attention>(HOME_DATA.attention.key, HOME_DATA.attention.path)
  const counts = useApi<{ counts: { filed: number } }>(HOME_DATA.stageCounts.key, HOME_DATA.stageCounts.path)
  const items = attention.data?.items
  const countOf = (key: string) => (items ? (items.find((i) => i.key === key)?.count ?? 0) : null)
  return (
    <Answer
      items={[
        {
          value: items ? items.length : null,
          label: items?.length === 1 ? "Thing needs attention" : "Things need attention",
          zero: "Nothing needs attention",
          tone: items && items.some((i) => i.severity === "critical") ? "critical" : "caution",
        },
        {
          value: counts.data ? counts.data.counts.filed : null,
          label: "Waiting to be cleared",
          zero: "Nothing waiting to clear",
          to: "/clearing",
        },
        { value: countOf("requests"), label: "Profile corrections waiting", zero: "No corrections waiting", to: "/requests" },
        {
          value: countOf("author_matches"),
          label: "Author names to match",
          zero: "Every author name is matched",
          to: "/people/matches",
        },
      ]}
    />
  )
}

export function AdminHome() {
  const { me } = useAuth()
  return (
    <div className="page space-y-10">
      <HomeHead
        name={me?.name}
        picture="spot-home-admin"
        sentence="Is anything broken or stuck? Start at the top of the list and work down."
      />
      <AtAGlance />
      <AttentionSection />
      <HomeTrack heading="Where every claim is" />
      <ToClear />
    </div>
  )
}
