import { useState } from "react"
import { ChevronLeft, ChevronRight, Pin, PinOff, Star } from "lucide-react"

import { useAuth, type Me } from "@/app/auth"
import { useApi, useApiMutation } from "@/lib/query"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { EmptyState, InlineError, Skeleton } from "@/ui/state"
import { Meta, PageTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

type Author = { id: string | null; name: string; department: string }
export type WallCard = {
  key: string
  title: string
  journal: string
  quartile: string | null
  year: number | null
  authors: Author[]
  pinned: boolean
}
export type WallPayload = {
  department: string
  month: string
  months: { month: string; count: number }[]
  pinned: WallCard | null
  cards: WallCard[]
  departments: string[]
}

/** "2026-08" -> "August 2026". */
export function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })
}

/** Who may choose the paper of the month on this wall. Mirrors `_may_pin`. */
export function mayPin(me: Me | null, department: string): boolean {
  if (!me) return false
  if (me.role === "SUPER_ADMIN") return true
  if (!department) return me.role === "PRINCIPAL"
  return me.role === "HOD" && (me.department || "").toLowerCase() === department.toLowerCase()
}

/**
 * A month of the college's new publications, one card per paper.
 *
 * A paper several colleagues wrote is one card with all their names on it,
 * not one card each: the wall celebrates papers, and three copies of the
 * same title would read as three papers. It sits in the month the college
 * first recognised it, and its head of department can make it the paper of
 * the month. Past months are one press away.
 *
 * Title, authors, journal and quartile. Nothing about money, and nothing
 * about where a paper is in the chain -- only recognised papers are here.
 */
export function WallOfFame() {
  const { me } = useAuth()
  // Null until the reader picks one: until then the wall follows whoever is
  // signed in -- a claimant's own department, the college for everybody else.
  const [picked, setDepartment] = useState<string | null>(null)
  const department =
    picked ?? (me?.role === "FACULTY" || me?.role === "HOD" ? me.department || "" : "")
  const [month, setMonth] = useState<string>("")

  const params = new URLSearchParams()
  if (department) params.set("department", department)
  if (month) params.set("month", month)
  const query = useApi<WallPayload>(["wall", department, month], `/api/wall?${params}`)
  const data = query.data

  const months = data?.months ?? []
  const at = data ? months.findIndex((m) => m.month === data.month) : -1
  const older = at >= 0 ? months[at + 1]?.month : undefined
  const newer = at > 0 ? months[at - 1]?.month : undefined

  return (
    <div className="page space-y-8">
      <header className="space-y-1">
        <PageTitle>Wall of fame</PageTitle>
        <Sub>
          {department ? `${department}: ` : "The whole college: "}
          new publications, a month at a time.
        </Sub>
      </header>

      <div className="well flex flex-wrap items-center gap-3 p-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">Department</span>
          <select
            value={department}
            onChange={(e) => {
              setDepartment(e.target.value)
              setMonth("")
            }}
            className="h-8 max-w-[14rem] rounded-md bg-surface px-2 text-sm text-fg ring-1 ring-inset ring-field outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <option value="">Whole college</option>
            {(data?.departments ?? (department ? [department] : [])).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1 sm:ml-auto">
          <Button
            kind="quiet"
            size="icon"
            aria-label="Older month"
            disabled={!older}
            onClick={() => older && setMonth(older)}
          >
            <ChevronLeft />
          </Button>
          <select
            aria-label="Month"
            value={data?.month ?? ""}
            onChange={(e) => setMonth(e.target.value)}
            className="h-8 rounded-md bg-surface px-2 text-sm text-fg ring-1 ring-inset ring-field outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {data && months.every((m) => m.month !== data.month) && (
              <option value={data.month}>{monthName(data.month)}</option>
            )}
            {months.map((m) => (
              <option key={m.month} value={m.month}>
                {monthName(m.month)} ({m.count})
              </option>
            ))}
          </select>
          <Button
            kind="quiet"
            size="icon"
            aria-label="Newer month"
            disabled={!newer}
            onClick={() => newer && setMonth(newer)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      {query.isError ? (
        <InlineError message="Could not load the wall." onRetry={() => void query.refetch()} />
      ) : query.isLoading || !data ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36 rounded-lg" />
          ))}
        </div>
      ) : data.cards.length === 0 ? (
        <EmptyState
          art="nothing-filed"
          title={`Nothing new in ${monthName(data.month)}`}
          message="Papers appear here in the month the college recognises them."
        />
      ) : (
        <Board data={data} canPin={mayPin(me, data.department)} />
      )}
    </div>
  )
}

function Board({ data, canPin }: { data: WallPayload; canPin: boolean }) {
  const invalidates = [["wall"]]
  const pin = useApiMutation<{ department: string; month: string; key: string }>("/api/wall/pin", {
    invalidates,
  })
  const unpin = useApiMutation<void>(
    () =>
      `/api/wall/pin?month=${data.month}${data.department ? `&department=${encodeURIComponent(data.department)}` : ""}`,
    { method: "DELETE", invalidates }
  )
  const busy = pin.isPending || unpin.isPending

  async function choose(card: WallCard) {
    try {
      await pin.mutateAsync({ department: data.department, month: data.month, key: card.key })
      toast.ok(`“${card.title}” is the paper of the month`)
    } catch (err) {
      toast.fail(err)
    }
  }
  async function clear() {
    try {
      await unpin.mutateAsync(undefined)
    } catch (err) {
      toast.fail(err)
    }
  }

  const rest = data.cards.filter((c) => !c.pinned)
  return (
    <div className="space-y-6">
      {data.pinned && (
        <section aria-label="Paper of the month" className="panel-lead p-5 sm:p-7">
          <p className="flex items-center gap-2 text-sm font-medium text-accent">
            <Star className="size-4" aria-hidden />
            Paper of the month
          </p>
          <CardBody card={data.pinned} lead />
          {canPin && (
            <Button kind="quiet" size="sm" className="mt-4" disabled={busy} onClick={() => void clear()}>
              <PinOff />
              Unpin
            </Button>
          )}
        </section>
      )}
      <p className="text-sm text-fg-muted">
        {data.cards.length} paper{data.cards.length === 1 ? "" : "s"} in {monthName(data.month)}
      </p>
      {/* grid-cols-1 rather than the implicit column: an implicit track sizes
          to max-content, and a long journal name on one line then pushes the
          whole list off a phone screen. */}
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {rest.map((card) => (
          <li key={card.key} className="panel flex min-w-0 flex-col p-4 sm:p-5">
            <CardBody card={card} />
            {canPin && (
              <Button
                kind="quiet"
                size="sm"
                className="mt-3 self-start"
                disabled={busy}
                onClick={() => void choose(card)}
              >
                <Pin />
                Make paper of the month
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CardBody({ card, lead = false }: { card: WallCard; lead?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <p className={cn("font-semibold text-pretty", lead ? "mt-2 text-xl" : "text-base")}>{card.title}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
        {card.quartile && (
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-xs font-semibold",
              card.quartile === "Q1" ? "bg-positive-wash text-positive" : "bg-sunken text-fg-muted"
            )}
          >
            {card.quartile}
          </span>
        )}
        {/* The year before the journal: a long journal name truncates, and
            anything after it would wrap onto a line of its own. */}
        {card.year && <span className="tabular">{card.year} ·</span>}
        <span className="min-w-0 flex-1 truncate">{card.journal || "Journal not recorded"}</span>
      </p>
      <Meta className="mt-2 block">
        {card.authors.map((a, i) => (
          <span key={`${a.id ?? a.name}-${i}`}>
            {i > 0 && ", "}
            <span className="text-fg">{a.name}</span>
            {a.department && <span> ({a.department})</span>}
          </span>
        ))}
      </Meta>
    </div>
  )
}
