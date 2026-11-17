import { useDeferredValue, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { keepPreviousData } from "@tanstack/react-query"
import { Coins, FileCheck, Sigma } from "lucide-react"

import { useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { deptLabel } from "@/lib/names"
import { useApi } from "@/lib/query"
import {
  FIRST_PERIOD,
  PeriodFrame,
  periodQuery,
  type Period,
  type PeriodChoices,
  type PeriodState,
} from "@/pages/period-frame"
import { fmtSnip, HowCounted } from "@/pages/standing-papers"
import { Field, Input, Select } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { Pagination } from "@/ui/pagination"
import { Avatar } from "@/ui/person"
import { money } from "@/ui/paper"
import { EmptyState, InlineError, SkeletonRows } from "@/ui/state"
import { StatTile } from "@/ui/stat"
import { Table, type Column, type SortDir } from "@/ui/table"

/**
 * Standings: everybody's cumulative SNIP, incentive paid and papers settled,
 * for a month, a year or all time, and how each number is made.
 *
 * The Top 5 is the first five of this table, in the same order, from the same
 * server pass. The server decides who sees what: the office sees everybody, a
 * head of department their department with no incentive (the keys never
 * arrive), and a faculty member only themself, with their place in the college.
 * Clicking a name opens "How this is counted", the papers behind the numbers.
 */

type Measure = "snip" | "remuneration" | "count"

export type StandingRow = {
  key: string
  user_id: string | null
  staff_id: string | null
  name: string
  department: string | null
  designation: string | null
  photo: string | null
  photo_url?: string | null
  initials?: string | null
  snip: number
  count: number
  remuneration?: number
  rank_snip: number | null
  rank_count: number | null
  rank_remuneration?: number | null
}

export type StandingsPayload = {
  period: Period
  label: string
  month: string | null
  year: number | null
  academic: boolean
  scope: "college" | "department" | "self"
  money: boolean
  department: string | null
  choices: PeriodChoices
  page: number
  page_size: number
  total: number
  totals: { snip: number; count: number; remuneration?: number }
  rows: StandingRow[]
}

const PAGE = 50
const RANK_KEY: Record<Measure, "rank_snip" | "rank_count" | "rank_remuneration"> = {
  snip: "rank_snip",
  count: "rank_count",
  remuneration: "rank_remuneration",
}
const MEASURE_NAME: Record<Measure, string> = {
  snip: "cumulative SNIP",
  remuneration: "incentive paid",
  count: "papers settled",
}

const ordinal = (n: number) => {
  const v = n % 100
  return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] ?? ["th", "st", "nd", "rd"][v] ?? "th"}`
}

function fromUrl(params: URLSearchParams): PeriodState {
  const p = params.get("period")
  const period: Period = p === "month" || p === "year" ? p : "all"
  const year = params.get("year")
  return {
    period,
    month: /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month") : null,
    year: year && /^\d{4}$/.test(year) ? `${params.get("academic") === "false" ? "c" : "a"}${year}` : null,
  }
}

export function Standings() {
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const [when, setWhen] = useState<PeriodState>(() => (params.has("period") ? fromUrl(params) : FIRST_PERIOD))
  const [q, setQ] = useState("")
  const [department, setDepartment] = useState("")
  const [sort, setSort] = useState<{ key: string; dir: SortDir }>({ key: "snip", dir: "desc" })
  const [page, setPage] = useState(0)
  const search = useDeferredValue(q.trim())
  const person = params.get("person")

  const base = (extra: string) =>
    `/api/dashboard/standings?${periodQuery(when)}&sort=${sort.key}&dir=${sort.dir}` +
    `${search ? `&q=${encodeURIComponent(search)}` : ""}${department ? `&department=${encodeURIComponent(department)}` : ""}${extra}`

  const query = useApi<StandingsPayload>(
    ["standings", periodQuery(when), sort.key, sort.dir, search, department, page],
    base(`&page=${page + 1}&page_size=${PAGE}`),
    { enabled: !!me, placeholderData: keepPreviousData }
  )
  const data = query.data
  const college = data?.scope === "college"
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments", { enabled: !!college })

  const open = (who: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (who) next.set("person", who)
        else next.delete("person")
        return next
      },
      { replace: false }
    )

  const withMoney = data ? data.money : me?.role !== "HOD"
  const measure = (["snip", "remuneration", "count"].includes(sort.key) ? sort.key : "snip") as Measure
  const rankOf = (r: StandingRow) => r[RANK_KEY[measure === "remuneration" && !withMoney ? "snip" : measure]] ?? null

  const columns: Column<StandingRow>[] = [
    {
      key: "rank",
      header: "Rank",
      label: `Rank by ${MEASURE_NAME[measure]}`,
      align: "right",
      className: "w-14 tabular text-fg-muted",
      empty: "Not ranked",
      exportValue: (r) => rankOf(r),
      exportKind: "number",
      cell: (r) => rankOf(r),
    },
    {
      key: "name",
      header: "Faculty",
      sortable: data?.scope !== "self",
      exportValue: (r) => r.name,
      cell: (r) => (
        <button
          type="button"
          onClick={() => open(r.user_id ?? r.key)}
          aria-label={`How ${r.name}'s numbers are counted`}
          className="flex min-w-0 items-center gap-2.5 rounded-control text-left hover:underline"
        >
          <Avatar
            size="sm"
            person={{ name: r.name, initials: r.initials ?? "", photo_url: r.photo_url ?? r.photo ?? null }}
          />
          <span className="min-w-0">
            <span className="block truncate font-medium text-fg">{r.name}</span>
            <span className="block truncate text-xs text-fg-muted">
              {[r.designation, r.staff_id].filter(Boolean).join(" · ")}
            </span>
          </span>
        </button>
      ),
    },
    {
      key: "department",
      header: "Department",
      sortable: data?.scope !== "self",
      exportValue: (r) => (r.department ? deptLabel(r.department) : null),
      cell: (r) => (r.department ? deptLabel(r.department) : null),
    },
    {
      key: "staff_id",
      header: "Staff ID",
      defaultHidden: true,
      exportValue: (r) => r.staff_id,
      cell: (r) => r.staff_id,
    },
    {
      key: "snip",
      header: "Cumulative SNIP",
      align: "right",
      sortable: true,
      className: "whitespace-nowrap",
      exportValue: (r) => r.snip,
      exportKind: "number",
      cell: (r) => fmtSnip(r.snip),
    },
    ...(withMoney
      ? [
          {
            key: "remuneration",
            header: "Incentive paid",
            align: "right" as const,
            sortable: true,
            className: "whitespace-nowrap",
            exportValue: (r: StandingRow) => r.remuneration ?? 0,
            exportKind: "money" as const,
            cell: (r: StandingRow) => money(r.remuneration ?? 0),
          },
        ]
      : []),
    {
      key: "count",
      header: "Papers settled",
      align: "right",
      sortable: true,
      className: "whitespace-nowrap",
      exportValue: (r) => r.count,
      exportKind: "number",
      cell: (r) => formatCount(r.count),
    },
  ]

  const title = me?.role === "FACULTY" ? "My standing" : "Standings"
  const mine = data?.scope === "self" ? data.rows[0] : undefined
  const whom = !data ? "" : data.scope === "self" ? "you" : data.scope === "department" ? "your department" : "the college"

  return (
    <div className="page space-y-6">
      <PageHeader
        title={title}
        sub={
          data?.scope === "self"
            ? "Your cumulative SNIP, incentive paid and papers settled, and where that puts you in the college."
            : "Cumulative SNIP, incentive paid and papers settled, for every faculty member. Click a name to see how it is made."
        }
        action={
          me?.role === "FACULTY" ? null : (
            <Link to="/reports/all" className="text-sm font-medium text-accent underline-offset-2 hover:underline">
              All reports
            </Link>
          )
        }
      />

      <PeriodFrame
        state={when}
        onChange={(next) => {
          setWhen(next)
          setPage(0)
        }}
        choices={data?.choices}
        used={data}
        idPrefix="standings-period"
      >
        <div className="space-y-5">
          <div
            className={`grid grid-cols-[minmax(0,1fr)] gap-4 ${withMoney ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
            data-testid="standings-figures"
          >
            <StatTile
              icon={Sigma}
              figure={data ? fmtSnip(data.totals.snip) : null}
              label={`Cumulative SNIP, ${whom}`}
            />
            {withMoney && (
              <StatTile
                icon={Coins}
                figure={data ? money(data.totals.remuneration ?? 0) : null}
                label={`Incentive paid, ${whom}`}
              />
            )}
            <StatTile
              icon={FileCheck}
              figure={data ? formatCount(data.totals.count) : null}
              label={`Papers settled, ${whom}`}
            />
          </div>

          {mine && (
            <p className="text-sm text-fg-muted" data-testid="standings-mine">
              In the college you are{" "}
              {[
                mine.rank_snip && `${ordinal(mine.rank_snip)} for cumulative SNIP`,
                withMoney && mine.rank_remuneration && `${ordinal(mine.rank_remuneration)} for incentive paid`,
                mine.rank_count && `${ordinal(mine.rank_count)} for papers settled`,
              ]
                .filter(Boolean)
                .join(", ") || "not yet ranked, because nothing has been settled for you in this period"}
              .
            </p>
          )}

          {data?.scope !== "self" && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Search" className="min-w-0 flex-1 basis-56">
                <Input
                  type="search"
                  value={q}
                  placeholder="Name or staff ID"
                  onChange={(e) => {
                    setQ(e.target.value)
                    setPage(0)
                  }}
                />
              </Field>
              {college && (
                <Field label="Department" className="min-w-0 basis-56">
                  <Select
                    value={department}
                    onChange={(e) => {
                      setDepartment(e.target.value)
                      setPage(0)
                    }}
                  >
                    <option value="">All departments</option>
                    {(departments.data ?? []).map((d) => (
                      <option key={d} value={d}>
                        {deptLabel(d)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          )}

          {query.isError ? (
            <InlineError message="Could not load the standings. Nothing has changed." onRetry={() => void query.refetch()} />
          ) : !data ? (
            <SkeletonRows rows={8} rowHeight={48} />
          ) : (
            <div className="space-y-3">
              <Table
                rows={data.rows}
                columns={columns}
                getKey={(r) => r.key}
                isCurrent={(r) => data.scope !== "self" && r.user_id === me?.id}
                sortKey={sort.key}
                sortDir={sort.dir}
                onSort={(key) => {
                  setPage(0)
                  setSort((s) =>
                    s.key === key
                      ? { key, dir: s.dir === "desc" ? "asc" : "desc" }
                      : { key, dir: key === "name" || key === "department" ? "asc" : "desc" }
                  )
                }}
                empty={
                  <EmptyState
                    size="compact"
                    title="Nobody matches"
                    message="Try another name or staff ID, or another department."
                  />
                }
                tools={{
                  id: "standings",
                  title: "Standings",
                  subtitle: `${data.department ? `${deptLabel(data.department)}, ` : ""}${data.label}`,
                  getAllRows: async () => {
                    const all = await api<StandingsPayload>(base("&page=1&page_size=2000"))
                    return all.rows
                  },
                }}
              />
              <Pagination page={page} pageSize={PAGE} total={data.total} onChange={setPage} />
              <p className="text-sm text-fg-muted">
                {data.label}, by the month the money was paid. Ranks run from 1, ties broken by name, and nobody with
                nothing counted is ranked.
              </p>
            </div>
          )}
        </div>
      </PeriodFrame>

      <HowCounted who={person} state={when} onClose={() => open(null)} />
    </div>
  )
}

export default Standings
