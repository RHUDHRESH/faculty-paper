import { useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { keepPreviousData } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Minus, Trophy } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Switch } from "@/ui/field"
import { ErrorState, SkeletonRows, SkeletonText } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Figure, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * Who published, and which department, over a period — ranked.
 *
 * Open to every role and never carrying money: a leaderboard of amounts
 * would be a leaderboard of other people's pay, so the server builds these
 * boards without reading an amount at all. The page's job is the question a
 * reader brings to any ranking — where am I, which way did I move, and what
 * is the number I am being ranked by — so the reader's own place leads, and
 * the weighting is printed rather than left for them to guess.
 */

type Period = { key: string; label: string; from: string | null; to: string | null }

type Method = {
  weights: Record<string, number>
  from_claims: number
  from_ledger: number
  left_out: number
  citations: boolean
  updated: string
}

type Tally = { papers: number; q1: number; score: number; first_author: number }
type Sort = keyof Tally

type PersonRow = Tally & {
  id: string
  name: string
  department: string | null
  designation: string | null
  rank: number
  joint: boolean
  movement: number | null
  me: boolean
}

type DepartmentRow = Tally & {
  department: string
  people: number
  rank: number
  joint: boolean
  per_head: Tally
  movement: number | null
  me: boolean
}

type BoardBase = {
  period: Period & { compared_with: Period | null }
  periods: Period[]
  sort: Sort
  method: Method
}

type PeopleBoard = BoardBase & {
  board: "people"
  department: string | null
  departments: string[]
  rows: PersonRow[]
  me: { rank: number; of: number; joint: boolean; value: number; movement: number | null } | null
  totals: { papers: number; people: number; people_with_papers: number }
}

type DepartmentBoard = BoardBase & {
  board: "departments"
  per_head: boolean
  rows: DepartmentRow[]
  me: { department: string; rank: number; of: number; joint: boolean; movement: number | null } | null
  totals: { papers: number; departments: number; people: number }
}

type Board = PeopleBoard | DepartmentBoard

const PERIODS: Period[] = [
  { key: "academic", label: "This academic year", from: null, to: null },
  { key: "last_academic", label: "Last academic year", from: null, to: null },
  { key: "calendar", label: "This calendar year", from: null, to: null },
  { key: "all", label: "All time", from: null, to: null },
]

const SORTS: { value: Sort; label: string }[] = [
  { value: "score", label: "Score" },
  { value: "papers", label: "Papers" },
  { value: "q1", label: "Q1 papers" },
  { value: "first_author", label: "First-author papers" },
]

/** How many rows show before "Show all" — the reader's own row always does. */
const TOP = 50

const selectClass =
  "h-8 rounded-md border-0 bg-surface px-2 text-sm text-fg shadow-well ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent"

export function ordinal(n: number): string {
  const teen = n % 100
  if (teen >= 11 && teen <= 13) return `${n}th`
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`
}

function count(n: number): string {
  return n.toLocaleString("en-IN")
}

function places(n: number): string {
  return `${n} place${n === 1 ? "" : "s"}`
}

export function Leaderboard() {
  const [params, setParams] = useSearchParams()
  const board = params.get("board") === "departments" ? "departments" : "people"
  const period = params.get("period") || "academic"
  const sort = (params.get("sort") as Sort | null) || "score"
  const department = params.get("department") || ""
  const perHead = params.get("per_head") === "true"
  const [showAll, setShowAll] = useState(false)

  function set(patch: Record<string, string>) {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
    setShowAll(false)
  }

  const query = new URLSearchParams({ board, period, sort })
  if (board === "people" && department) query.set("department", department)
  if (board === "departments" && perHead) query.set("per_head", "true")

  const q = useApi<Board>(["leaderboard", board, period, sort, department, perHead], `/api/leaderboard?${query}`, {
    // The previous board stays on screen while the next one loads, so a
    // filter change reads as the numbers changing rather than the page
    // blanking out and redrawing.
    placeholderData: keepPreviousData,
  })
  const data = q.data && q.data.board === board ? q.data : undefined
  const periods = data?.periods ?? PERIODS

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>Leaderboard</PageTitle>
        <Sub className="mt-1">
          Papers by people and departments here, counted from filed papers and the payment
          ledger's history. No money is shown.
        </Sub>
      </header>

      <div
        role="tablist"
        aria-label="Board"
        className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-sunken p-0.5"
      >
        {(["people", "departments"] as const).map((b) => (
          <button
            key={b}
            type="button"
            role="tab"
            aria-selected={board === b}
            onClick={() => set({ board: b === "people" ? "" : b, department: "", per_head: "" })}
            className={cn(
              "h-7 shrink-0 rounded-sm px-3 text-sm font-medium transition-colors",
              "duration-[var(--dur-1)] ease-out",
              board === b ? "bg-surface text-fg" : "text-fg-muted hover:text-fg"
            )}
          >
            {b === "people" ? "People" : "Departments"}
          </button>
        ))}
      </div>

      <div className="well flex flex-wrap items-end gap-x-4 gap-y-3 rounded-lg px-3 py-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-fg-muted">
          Period
          <select
            aria-label="Period"
            value={period}
            onChange={(e) => set({ period: e.target.value === "academic" ? "" : e.target.value })}
            className={selectClass}
          >
            {periods.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-fg-muted">
          Rank by
          <select
            aria-label="Rank by"
            value={sort}
            onChange={(e) => set({ sort: e.target.value === "score" ? "" : e.target.value })}
            className={selectClass}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {board === "people" ? (
          <label className="flex flex-col gap-1 text-xs font-medium text-fg-muted">
            Department
            <select
              aria-label="Department"
              value={department}
              onChange={(e) => set({ department: e.target.value })}
              className={cn(selectClass, "max-w-[14rem]")}
            >
              <option value="">All departments</option>
              {(data?.board === "people" ? data.departments : []).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="pb-1.5">
            <Switch
              checked={perHead}
              onCheckedChange={(on) => set({ per_head: on ? "true" : "" })}
              label="Rank per person"
            />
          </div>
        )}
      </div>

      {q.isLoading ? (
        <div className="space-y-4">
          <SkeletonText lines={2} className="max-w-sm" />
          <SkeletonRows rows={8} rowHeight={40} />
        </div>
      ) : q.isError ? (
        <ErrorState
          title="Could not load the leaderboard"
          message={q.error.message}
          onRetry={() => void q.refetch()}
        />
      ) : data ? (
        <>
          <Standing data={data} />
          {data.board === "people" ? (
            <PeopleTable data={data} showAll={showAll} onShowAll={() => setShowAll(true)} />
          ) : (
            <DepartmentTable data={data} />
          )}
          <HowCounted data={data} />
        </>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Where the reader stands                                                  */
/* ------------------------------------------------------------------------ */

function movementSentence(movement: number | null, since: Period | null): string | null {
  if (movement === null || !since) return null
  if (movement > 0) return `Up ${places(movement)} since ${since.label}.`
  if (movement < 0) return `Down ${places(-movement)} since ${since.label}.`
  return `The same place as in ${since.label}.`
}

/**
 * The reader's place, first, in words.
 *
 * Four hundred rows is a list nobody reads to find one name. "You're 14th of
 * 399" is the answer to the question they opened the page with; the table
 * under it is for everything else.
 */
function Standing({ data }: { data: Board }) {
  const since = data.period.compared_with
  const sortLabel = SORTS.find((s) => s.value === data.sort)?.label.toLowerCase() ?? "score"

  if (data.board === "people") {
    const me = data.me
    if (!me) {
      return (
        <p className="text-base text-fg-muted">
          {count(data.totals.papers)} papers by {count(data.totals.people_with_papers)} of{" "}
          {count(data.totals.people)} people in {data.period.label.toLowerCase()}.
        </p>
      )
    }
    const moved = movementSentence(me.movement, since)
    // Papers, not the ranked measure: somebody ranked by Q1 with five papers
    // and no Q1 has papers, and is simply joint last on that measure.
    const papers = data.rows.find((r) => r.me)?.papers ?? 0
    return (
      <section className="panel-lead rounded-lg px-4 py-4 sm:px-5" aria-label="Your place">
        {papers === 0 ? (
          <>
            <p className="text-lg font-semibold text-fg">You have no papers counted in this period yet.</p>
            <Meta className="mt-1 block">
              {data.period.label}. A paper counts in the period it was published, once it is
              filed.
            </Meta>
          </>
        ) : (
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-lg font-semibold text-fg">
                {me.joint ? `You're joint ${ordinal(me.rank)} of ${count(me.of)}` : `You're ${ordinal(me.rank)} of ${count(me.of)}`}
              </p>
              <Meta className="mt-1 block">
                {data.period.label}
                {data.department ? `, in ${data.department}` : ""}.{moved ? ` ${moved}` : ""}
              </Meta>
            </div>
            <div className="text-right">
              <Figure className="text-3xl">{count(me.value)}</Figure>
              <Meta className="block">{sortLabel}</Meta>
            </div>
          </div>
        )}
      </section>
    )
  }

  const me = data.me
  if (!me) {
    return (
      <p className="text-base text-fg-muted">
        {count(data.totals.papers)} papers across {count(data.totals.departments)} departments in{" "}
        {data.period.label.toLowerCase()}.
      </p>
    )
  }
  const moved = movementSentence(me.movement, since)
  return (
    <section className="panel-lead rounded-lg px-4 py-4 sm:px-5" aria-label="Your department's place">
      <p className="text-lg font-semibold text-fg">
        {me.joint
          ? `Your department is joint ${ordinal(me.rank)} of ${count(me.of)}`
          : `Your department is ${ordinal(me.rank)} of ${count(me.of)}`}
      </p>
      <Meta className="mt-1 block">
        {me.department}, {data.period.label.toLowerCase()}
        {data.per_head ? ", per person" : ""}.{moved ? ` ${moved}` : ""}
      </Meta>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* The tables                                                               */
/* ------------------------------------------------------------------------ */

/** Up, down or level — said in words for anybody not reading the colour. */
function Movement({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span className="text-fg-subtle" aria-label="No comparison">
        —
      </span>
    )
  }
  if (value === 0) {
    return (
      <span className="inline-flex items-center justify-end gap-0.5 text-fg-muted" aria-label="No change">
        <Minus className="size-3.5" aria-hidden />
      </span>
    )
  }
  const up = value > 0
  const n = Math.abs(value)
  return (
    <span
      className={cn("inline-flex items-center justify-end gap-0.5", up ? "text-positive" : "text-critical")}
      aria-label={`${up ? "Up" : "Down"} ${places(n)}`}
    >
      {up ? <ArrowUp className="size-3.5" aria-hidden /> : <ArrowDown className="size-3.5" aria-hidden />}
      <span aria-hidden>{n}</span>
    </span>
  )
}

function Place({ rank, joint }: { rank: number; joint: boolean }) {
  return (
    <span className="tabular text-fg-muted" title={joint ? `Joint ${ordinal(rank)}` : undefined}>
      {joint ? "=" : ""}
      {rank}
    </span>
  )
}

function YouPill({ children = "You" }: { children?: string }) {
  return (
    <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-fg">{children}</span>
  )
}

const WIDE = "hidden sm:table-cell"

const TALLY_HEADERS: Record<Sort, string> = {
  score: "Score",
  papers: "Papers",
  q1: "Q1",
  first_author: "First author",
}

/**
 * One column per measure. On a phone only the measure being ranked by is
 * shown: four numbers beside a name did not fit 390px, and the one that
 * decides the order is the one the reader needs.
 */
function tallyColumns<T extends Tally>(sort: Sort): Column<T>[] {
  return (Object.keys(TALLY_HEADERS) as Sort[]).map((key) => ({
    key,
    header: TALLY_HEADERS[key],
    align: "right" as const,
    className: key === sort ? undefined : WIDE,
    headerClassName: key === sort ? undefined : WIDE,
    cell: (r: T) => count(r[key]),
  }))
}

function PeopleTable({
  data,
  showAll,
  onShowAll,
}: {
  data: PeopleBoard
  showAll: boolean
  onShowAll: () => void
}) {
  const shown = showAll
    ? data.rows
    : data.rows.filter((r, i) => i < TOP || r.me)
  const region = useRef<HTMLElement>(null)
  const myRank = data.me?.rank

  // Bring the reader's own row into the table's view on load — found in the
  // browser: at joint 11th it sat just under the fold of the table's own
  // scroll box. Only that box is scrolled, never the page under the reader.
  useEffect(() => {
    const row = region.current?.querySelector<HTMLElement>('tr[aria-current="true"]')
    const box = row?.closest<HTMLElement>(".overflow-auto")
    if (!row || !box) return
    const top = row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2
    if (row.offsetTop + row.offsetHeight > box.clientHeight) box.scrollTop = Math.max(0, top)
  }, [myRank, data.sort, data.period.key, data.department])

  const columns: Column<PersonRow>[] = [
    { key: "rank", header: "#", className: "w-10", cell: (r) => <Place rank={r.rank} joint={r.joint} /> },
    {
      key: "name",
      header: "Name",
      // Wraps rather than truncating: on a phone a no-wrap name column is
      // what pushed the score and the movement off the side of the table.
      className: "min-w-[9rem] whitespace-normal",
      cell: (r) => (
        <div className="min-w-0">
          <Link
            to={`/u/${r.id}`}
            className="font-medium text-fg underline-offset-4 hover:text-accent hover:underline"
          >
            {r.name}
          </Link>
          {r.me && <YouPill />}
          <Meta className="block text-xs">
            {[r.department, r.designation].filter(Boolean).join(" · ") || "—"}
          </Meta>
        </div>
      ),
    },
    ...tallyColumns<PersonRow>(data.sort),
    { key: "movement", header: "Move", align: "right", cell: (r) => <Movement value={r.movement} /> },
  ]

  return (
    <section ref={region} className="space-y-2" aria-label="People">
      <Table
        rows={shown}
        columns={columns}
        getKey={(r) => r.id}
        isCurrent={(r) => r.me}
        caption={`People ranked by ${data.sort}`}
        empty="Nobody in this department is on the roster."
      />
      {!showAll && data.rows.length > shown.length && (
        <Button kind="quiet" size="sm" onClick={onShowAll}>
          Show all {count(data.rows.length)}
        </Button>
      )}
    </section>
  )
}

function DepartmentTable({ data }: { data: DepartmentBoard }) {
  // On a phone, one number beside the department: whichever decides the
  // order. The total and the per-person figure are both visible from `sm` up.
  const totals = tallyColumns<DepartmentRow>(data.sort).map((c) =>
    data.per_head && c.key === data.sort ? { ...c, className: WIDE, headerClassName: WIDE } : c
  )
  const perPerson = data.per_head ? undefined : WIDE
  const columns: Column<DepartmentRow>[] = [
    { key: "rank", header: "#", className: "w-10", cell: (r) => <Place rank={r.rank} joint={r.joint} /> },
    {
      key: "department",
      header: "Department",
      cell: (r) => (
        <span>
          <span className="font-medium text-fg">{r.department}</span>
          {r.me && <YouPill>Yours</YouPill>}
        </span>
      ),
    },
    { key: "people", header: "People", align: "right", className: WIDE, headerClassName: WIDE, cell: (r) => count(r.people) },
    ...totals,
    {
      key: "per_head",
      header: "Per person",
      align: "right",
      className: perPerson,
      headerClassName: perPerson,
      cell: (r) => r.per_head[data.sort].toFixed(2),
    },
    { key: "movement", header: "Move", align: "right", cell: (r) => <Movement value={r.movement} /> },
  ]
  return (
    <section aria-label="Departments">
      <Table
        rows={data.rows}
        columns={columns}
        getKey={(r) => r.department}
        isCurrent={(r) => r.me}
        caption={`Departments ranked by ${data.sort}${data.per_head ? " per person" : ""}`}
        empty="No department has anybody on the roster."
      />
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* How it is counted                                                        */
/* ------------------------------------------------------------------------ */

/**
 * The rules, printed. A ranking whose arithmetic the reader cannot see is a
 * ranking they argue with; one that says "Q1 = 4" is one they can check.
 */
function HowCounted({ data }: { data: Board }) {
  const m = data.method
  const w = m.weights
  return (
    <section className="space-y-2 border-t border-line pt-6" aria-label="How this is counted">
      <SectionTitle className="flex items-center gap-2">
        <Trophy className="size-4 text-fg-muted" aria-hidden />
        How this is counted
      </SectionTitle>
      <ul className="max-w-3xl list-disc space-y-1.5 pl-5 text-sm text-fg-muted">
        <li>
          Score: Q1 = {w.Q1}, Q2 = {w.Q2}, Q3 = {w.Q3}, Q4 = {w.Q4}, any other indexed paper ={" "}
          {w.other_indexed}, a paper that is not indexed = 0.
        </li>
        <li>
          Papers that are filed, under review, approved or paid count; drafts and rejected claims do
          not. A paper is counted once however many rows describe it.
        </li>
        <li>
          {count(m.from_claims)} from filed papers and {count(m.from_ledger)} from the payment ledger's
          history. Ledger papers use the quartile recorded on their own row.
          {m.left_out > 0
            ? ` ${count(m.left_out)} rows by people no longer on the roster are left out.`
            : ""}
        </li>
        <li>
          A paper counts in the period it was published. Where only the year is known, it counts from
          1 January. The academic year starts on 1 June.
        </li>
        <li>First-author counts come from filed papers only; the ledger does not record author order.</li>
        {!m.citations && <li>Citations are not recorded here, so they are not ranked.</li>}
        {data.board === "departments" && (
          <li>
            A department counts each paper once, however many of its people wrote it. Per person
            divides by the department's current faculty.
          </li>
        )}
        <li>Faculty and heads of department are ranked. Figures refresh every five minutes.</li>
      </ul>
    </section>
  )
}
