import { useEffect, useState } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { Award, Gem, HandHeart, Monitor, Pin, PinOff, Star, X } from "lucide-react"

import { useAuth, type Me } from "@/app/auth"
import { useCollegeName } from "@/app/institution"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Avatar, initialsOf } from "@/ui/person"
import { SharePlate } from "@/ui/share-plate"
import { Illustration } from "@/ui/illustration"
import { InlineError, Skeleton } from "@/ui/state"
import { toast } from "@/ui/toast"

type Author = { id: string | null; name: string; department: string; photo_url?: string | null; initials?: string }
export type WallCard = {
  key: string
  title: string
  journal: string
  quartile: string | null
  year: number | null
  authors: Author[]
  pinned: boolean
  departments?: string[]
  featured?: boolean
  reaction_count?: number
  me_reacted?: boolean
  doi?: string | null
  claim_id?: string | null
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

function shortMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "2-digit" })
}

/** Who may choose the paper of the month on this wall. Mirrors `_may_pin`. */
export function mayPin(me: Me | null, department: string): boolean {
  if (!me) return false
  if (me.role === "SUPER_ADMIN") return true
  if (!department) return me.role === "PRINCIPAL"
  return me.role === "HOD" && (me.department || "").toLowerCase() === department.toLowerCase()
}

/** "{Month Year} — {n} new papers, {q} in Q1 journals." */
export function monthTitle(data: Pick<WallPayload, "month" | "cards">): string {
  const n = data.cards.length
  const q = data.cards.filter((c) => c.quartile === "Q1").length
  return `${monthName(data.month)} — ${n} new paper${n === 1 ? "" : "s"}, ${q} in Q1 journal${q === 1 ? "" : "s"}.`
}

function paperHref(card: WallCard): string | null {
  if (card.claim_id) return `/papers/${card.claim_id}`
  if (card.doi) return `https://doi.org/${card.doi}`
  return null
}

function useWall(department: string, month: string) {
  const params = new URLSearchParams()
  if (department) params.set("department", department)
  if (month) params.set("month", month)
  const qs = params.toString()
  return useApi<WallPayload>(["wall", department, month], `/api/wall${qs ? `?${qs}` : ""}`)
}

/**
 * The wall of fame (docs/ux/14): a month of new papers as certificate tiles,
 * Q1 papers double-width with a gold ribbon. A paper several colleagues
 * wrote is one tile with all their faces on it. Congratulate once per
 * person. Lives as the Leaderboard's `?view=wall` tab; `department` and
 * `month` are URL state owned by the caller.
 *
 * Title, authors, journal and quartile. Nothing about money.
 */
export function WallBoard({
  department,
  month,
  onMonth,
  onDepartment,
}: {
  department: string
  month: string
  onMonth: (m: string) => void
  onDepartment?: (d: string) => void
}) {
  const { me } = useAuth()
  const query = useWall(department, month)
  const data = query.data
  const [, setParams] = useSearchParams()

  return (
    <section aria-labelledby="wall-title" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-area-honours">
            <Award aria-hidden className="size-4" strokeWidth={1.75} />
            Wall of fame · {department || "Whole college"}
          </p>
          <h2 id="wall-title" className="honour mt-1 text-2xl text-pretty sm:text-3xl">
            {data ? monthTitle(data) : " "}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          {onDepartment && (
            <select
              aria-label="Wall department"
              value={department}
              onChange={(e) => onDepartment(e.target.value)}
              className="h-8 max-w-[14rem] rounded-md bg-surface px-2 text-sm text-fg ring-1 ring-inset ring-field outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <option value="">Whole college</option>
              {(data?.departments ?? (department ? [department] : [])).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          )}
          <Button
            onClick={() =>
              setParams((p) => {
                const n = new URLSearchParams(p)
                n.set("display", "1")
                return n
              })
            }
          >
            <Monitor aria-hidden />
            Display on a screen
          </Button>
        </div>
      </div>

      {data && data.months.length > 0 && (
        <nav aria-label="Months" className="-mx-1 overflow-x-auto pb-1">
          <ul className="flex w-max gap-2 px-1">
            {data.months.map((m) => {
              const on = m.month === data.month
              return (
                <li key={m.month}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onMonth(m.month)}
                    className={cn(
                      "inline-flex h-8 items-center gap-2 rounded-full px-3 text-sm whitespace-nowrap",
                      on
                        ? "bg-area-honours-wash font-semibold text-area-honours shadow-[inset_0_0_0_1px_var(--color-area-honours-line)]"
                        : "text-fg-muted hover:bg-hover hover:text-fg"
                    )}
                  >
                    {shortMonth(m.month)}
                    <span className="tabular text-xs opacity-80">{m.count}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
      )}

      {query.isError ? (
        <InlineError message="Could not load the wall. Nothing has changed." onRetry={() => void query.refetch()} />
      ) : query.isLoading || !data ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className={cn("h-44 rounded-2xl", i === 0 && "md:col-span-2")} />
          ))}
        </div>
      ) : data.cards.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Illustration name="spot-wall-of-fame" width={140} />
          <p className="font-semibold">No new papers yet this month</p>
          <p className="text-sm text-fg-muted">The first one filed will lead the wall.</p>
        </div>
      ) : (
        <Tiles data={data} canPin={mayPin(me, data.department)} />
      )}
    </section>
  )
}

function Tiles({ data, canPin }: { data: WallPayload; canPin: boolean }) {
  const invalidates = [["wall"]]
  const pin = useApiMutation<{ department: string; month: string; key: string }>("/api/wall/pin", { invalidates })
  const unpin = useApiMutation<void>(
    () =>
      `/api/wall/pin?month=${data.month}${data.department ? `&department=${encodeURIComponent(data.department)}` : ""}`,
    { method: "DELETE", invalidates }
  )
  const busy = pin.isPending || unpin.isPending

  async function feature(card: WallCard) {
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

  // The featured paper leads; the server already sorts Q1 before the rest.
  const cards = [...data.cards].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  return (
    <ul className="grid grid-flow-row-dense grid-cols-1 gap-4 md:grid-cols-3">
      {cards.map((card) => {
        const wide = card.quartile === "Q1" || card.pinned
        return (
          <SharePlate
            key={card.key}
            as="li"
            ribbon={card.quartile === "Q1" ? "gold" : "navy"}
            className={cn("flex min-w-0 flex-col p-5", wide && "md:col-span-2")}
          >
            <Tile card={card} wide={wide} />
            {canPin && (
              <div className="mt-3 print:hidden">
                {card.pinned ? (
                  <Button kind="quiet" size="sm" disabled={busy} onClick={() => void clear()}>
                    <PinOff />
                    Unpin
                  </Button>
                ) : (
                  <Button kind="quiet" size="sm" disabled={busy} onClick={() => void feature(card)}>
                    <Pin />
                    Make paper of the month
                  </Button>
                )}
              </div>
            )}
          </SharePlate>
        )
      })}
    </ul>
  )
}

function Tile({ card, wide, anonymous = false }: { card: WallCard; wide: boolean; anonymous?: boolean }) {
  const href = paperHref(card)
  const members = card.authors.filter((a) => a.id)
  const depts = card.departments ?? Array.from(new Set(card.authors.map((a) => a.department).filter(Boolean)))
  const title = (
    <span className={cn("line-clamp-3 text-pretty", wide ? "honour text-xl" : "text-base font-semibold")}>
      {card.title}
    </span>
  )
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {card.pinned && (
          <Chip tone="gold" icon={Star}>
            Paper of the month
          </Chip>
        )}
        {card.quartile === "Q1" && (
          <Chip tone="gold" icon={Gem}>
            Q1
          </Chip>
        )}
        {!anonymous && members.length > 0 && (
          <span className="flex -space-x-2">
            {members.slice(0, 5).map((a) => (
              <Link key={a.id} to={`/u/${a.id}`} aria-label={a.name} className="rounded-full ring-2 ring-paper">
                <Avatar size="sm" person={{ name: a.name, initials: a.initials ?? initialsOf(a.name), photo_url: a.photo_url ?? null }} />
              </Link>
            ))}
          </span>
        )}
      </div>
      {href ? (
        href.startsWith("http") ? (
          <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
            {title}
          </a>
        ) : (
          <Link to={href} className="hover:underline">
            {title}
          </Link>
        )
      ) : (
        <p>{title}</p>
      )}
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-fg-muted">
        <span className="min-w-0 truncate">{card.journal || "Journal not recorded"}</span>
        {card.quartile && card.quartile !== "Q1" && <span>· {card.quartile}</span>}
        {card.year && <span className="tabular">· {card.year}</span>}
      </p>
      {anonymous ? (
        <p className="text-sm text-fg-muted">
          {card.authors.length} author{card.authors.length === 1 ? "" : "s"} from {depts.join(" · ") || "the college"}
        </p>
      ) : (
        <p className="text-sm">
          {card.authors.map((a, i) => (
            <span key={`${a.id ?? a.name}-${i}`}>
              {i > 0 && ", "}
              {a.id ? (
                <Link to={`/u/${a.id}`} className="font-medium hover:underline">
                  {a.name}
                </Link>
              ) : (
                <span>{a.name}</span>
              )}
            </span>
          ))}
          {depts.length > 0 && <span className="text-fg-muted"> · {depts.join(" · ")}</span>}
        </p>
      )}
      {!anonymous && <Congratulate card={card} />}
    </div>
  )
}

function Congratulate({ card }: { card: WallCard }) {
  const invalidates = [["wall"]]
  const add = useApiMutation<{ key: string }>("/api/wall/cheer", { invalidates })
  const remove = useApiMutation<void>(() => `/api/wall/cheer?key=${encodeURIComponent(card.key)}`, {
    method: "DELETE",
    invalidates,
  })
  const count = card.reaction_count ?? 0
  const mine = card.me_reacted ?? false
  return (
    <div className="mt-auto pt-1 print:hidden">
      <Button
        size="sm"
        kind={mine ? "default" : "quiet"}
        aria-pressed={mine}
        aria-label={`Congratulate the authors of ${card.title}`}
        disabled={add.isPending || remove.isPending}
        onClick={() => void (mine ? remove.mutateAsync(undefined) : add.mutateAsync({ key: card.key })).catch(toast.fail)}
        className={cn(mine && "text-area-honours")}
      >
        <HandHeart aria-hidden />
        {mine ? "Congratulated" : "Congratulate"}
        <span className="tabular">{count}</span>
      </Button>
    </div>
  )
}

/**
 * Kiosk mode for the lobby TV (`/wall?display=1`): full screen, no chrome,
 * one tile at a time every 8 seconds, cycling through the month. It shows
 * no one's name: the college has no per-person consent for a public screen
 * yet, so a tile says how many authors and which departments. Esc exits.
 */
export function WallKiosk({ department, month }: { department: string; month: string }) {
  const query = useWall(department, month)
  const college = useCollegeName()
  const navigate = useNavigate()
  const [at, setAt] = useState(0)
  const cards = query.data?.cards ?? []

  useEffect(() => {
    if (cards.length < 2) return
    const t = window.setInterval(() => setAt((i) => (i + 1) % cards.length), 8000)
    return () => window.clearInterval(t)
  }, [cards.length])
  useEffect(() => {
    const exit = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate("/leaderboard?view=wall")
    }
    window.addEventListener("keydown", exit)
    return () => window.removeEventListener("keydown", exit)
  }, [navigate])

  const card = cards.length ? cards[at % cards.length] : null
  return (
    <div role="dialog" aria-label="Wall of fame display" className="fixed inset-0 z-[100] flex flex-col bg-paper p-8 text-fg sm:p-14">
      <div aria-hidden className="ribbon absolute inset-x-0 top-0 h-[6px]" />
      <header className="flex items-start justify-between gap-6">
        <div>
          <p className="text-lg font-medium text-area-honours">{college} · Wall of fame</p>
          <h1 className="honour text-honour mt-2">{query.data ? monthTitle(query.data) : " "}</h1>
        </div>
        <Button kind="quiet" size="icon" aria-label="Leave display mode" onClick={() => navigate("/leaderboard?view=wall")}>
          <X />
        </Button>
      </header>
      <div className="flex flex-1 items-center justify-center py-8">
        {card ? (
          <SharePlate ribbon={card.quartile === "Q1" ? "gold" : "navy"} className="aspect-video w-full max-w-5xl p-10 sm:p-14">
            <div className="flex h-full flex-col justify-center [&_.honour]:text-4xl [&_p]:text-xl">
              <Tile card={card} wide anonymous />
            </div>
          </SharePlate>
        ) : (
          <p className="text-2xl text-fg-muted">No new papers yet this month — the first one filed will lead the wall.</p>
        )}
      </div>
      {cards.length > 1 && (
        <p className="text-center text-sm text-fg-muted tabular">
          {(at % cards.length) + 1} of {cards.length}
        </p>
      )}
    </div>
  )
}

/**
 * `/wall`: kiosk when `?display=1`, otherwise the Leaderboard's wall tab.
 * Deep links keep their month and department.
 */
export function WallOfFame() {
  const [params] = useSearchParams()
  const department = params.get("department") ?? params.get("dept") ?? ""
  const month = params.get("month") ?? ""
  if (params.get("display") === "1") return <WallKiosk department={department} month={month} />
  const next = new URLSearchParams({ view: "wall" })
  if (department) next.set("dept", department)
  if (month) next.set("month", month)
  return <Navigate replace to={`/leaderboard?${next}`} />
}

export default WallOfFame
