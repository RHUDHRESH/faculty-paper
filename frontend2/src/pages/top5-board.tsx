import { useState } from "react"
import { keepPreviousData } from "@tanstack/react-query"
import { Link } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { deptLabel } from "@/lib/names"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Select } from "@/ui/field"
import { FIRST_PERIOD, PeriodFrame, periodQuery, type Period, type PeriodChoices, type PeriodState } from "@/pages/period-frame"
import { Avatar, PersonLink } from "@/ui/person"
import { money } from "@/ui/paper"
import { Section } from "@/ui/section"
import { EmptyState, InlineError, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"

/**
 * The Top 5: three short ranked lists from the college's settled papers, the
 * cumulative SNIP of the papers settled for a person, the incentive paid to
 * them, and how many papers were settled.
 *
 * It sits under the figures on the Principal, Director, Super admin, Research
 * coordinator and head of department homes, and on Reports. The server decides
 * what each reader gets: a head of department sees their own department and no
 * incentive list at all (`remuneration` is null), so this draws only the lists
 * it is given. Anybody else the server refuses draws nothing.
 */

export type Top5Row = {
  rank: number
  user_id: string | null
  staff_id: string | null
  name: string
  department: string | null
  photo: string | null
  photo_url?: string | null
  initials?: string | null
  value: number
  /** On the incentive list only: papers the college paid for more than once (counted once, paid in full). */
  paid_more_than_once?: number
}

export type Top5Payload = {
  period: Period
  label: string
  /** "2026-09" for a month; the year of an academic year (its first) or of a calendar year. */
  month?: string | null
  year?: number | null
  academic?: boolean
  department: string | null
  generated_at: string
  /** The months paid in and the years around them, for the pickers. */
  choices?: PeriodChoices
  snip: Top5Row[]
  /** Left out entirely for a head of department: the server never sends the key. */
  remuneration?: Top5Row[]
  count: Top5Row[]
}

/** The roles the server answers for (`api/top5.py`). */
const COLLEGE_WIDE = new Set(["PRINCIPAL", "VICE_PRINCIPAL", "DIRECTOR", "SUPER_ADMIN", "RESEARCH_COORDINATOR", "FINANCE"])

export const top5Allowed = (role: string | undefined) => !!role && (COLLEGE_WIDE.has(role) || role === "HOD")

const snip = (v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type ListSpec = {
  key: "snip" | "remuneration" | "count"
  title: string
  header: string
  show: (v: number) => string
  kind: "number" | "money"
}

const LISTS: ListSpec[] = [
  { key: "snip", title: "Cumulative SNIP", header: "SNIP", show: snip, kind: "number" },
  { key: "remuneration", title: "Incentive paid", header: "Amount", show: (v) => money(v), kind: "money" },
  { key: "count", title: "Papers settled", header: "Papers", show: (v) => formatCount(v), kind: "number" },
]

function columns(spec: ListSpec): Column<Top5Row>[] {
  return [
    {
      key: "rank",
      header: "Rank",
      align: "right",
      className: "w-10 px-2 tabular-nums text-fg-muted",
      exportValue: (r) => r.rank,
      exportKind: "number",
      cell: (r) => r.rank,
    },
    {
      key: "name",
      header: "Name",
      // `max-w-0` with `w-full` is what lets a table cell shrink below its
      // content: the name takes what the value does not need and ends in an
      // ellipsis, so the figure beside it is never the thing that is cut.
      className: "w-full max-w-0 px-2",
      exportValue: (r) => r.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            size="sm"
            person={{ name: r.name, initials: r.initials ?? "", photo_url: r.photo_url ?? r.photo ?? null }}
          />
          <span className="min-w-0 flex-1">
            <PersonLink id={r.user_id} name={r.name} className="block truncate" />
            {r.department && <span className="block truncate text-xs text-fg-muted" title={deptLabel(r.department)}>{deptLabel(r.department)}</span>}
          </span>
        </span>
      ),
    },
    {
      key: "department",
      header: "Department",
      defaultHidden: true,
      exportValue: (r) => (r.department ? deptLabel(r.department) : null),
      cell: (r) => (r.department ? deptLabel(r.department) : null),
    },
    {
      key: "value",
      header: spec.header,
      label: spec.title,
      align: "right",
      className: "whitespace-nowrap px-2 tabular-nums font-medium",
      headerClassName: "px-2",
      exportValue: (r) => r.value,
      exportKind: spec.kind,
      cell: (r) =>
        r.paid_more_than_once ? (
          <span className="block">
            {spec.show(r.value)}
            <span className="block text-xs font-normal text-fg-muted">
              {r.paid_more_than_once === 1 ? "Includes 1 paper paid more than once" : `Includes ${r.paid_more_than_once} papers paid more than once`}
            </span>
          </span>
        ) : (
          spec.show(r.value)
        ),
    },
  ]
}

export function Top5Board({
  className,
  id = "top5",
  title = "Top 5",
}: {
  className?: string
  id?: string
  title?: string
}) {
  const { me } = useAuth()
  const wide = !!me?.role && COLLEGE_WIDE.has(me.role)
  const allowed = top5Allowed(me?.role)
  const [when, setWhen] = useState<PeriodState>(FIRST_PERIOD)
  const [department, setDepartment] = useState("")

  const query = useApi<Top5Payload>(
    ["top5", periodQuery(when), wide ? department : ""],
    `/api/dashboard/top5?${periodQuery(when)}${wide && department ? `&department=${encodeURIComponent(department)}` : ""}`,
    { enabled: allowed, placeholderData: keepPreviousData }
  )
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments", { enabled: wide })

  if (!allowed) return null

  const data = query.data
  const lists = LISTS.filter((l) => data?.[l.key] != null)
  const empty = !!data && lists.every((l) => (data[l.key] ?? []).length === 0)
  const scope = data?.department ? `${deptLabel(data.department)}, ` : ""

  const controls = wide ? (
    <Select
      size="sm"
      aria-label="Department"
      value={department}
      onChange={(e) => setDepartment(e.target.value)}
      className="w-auto max-w-full max-sm:w-full"
    >
      <option value="">All departments</option>
      {(departments.data ?? []).map((d) => (
        <option key={d} value={d}>
          {deptLabel(d)}
        </option>
      ))}
    </Select>
  ) : null

  return (
    <Section id={id} title={title} action={controls} className={className} data-testid="top5-board">
      <PeriodFrame state={when} onChange={setWhen} choices={data?.choices} used={data} idPrefix={`${id}-period`}>
        {query.isError ? (
          <InlineError message="Could not load the Top 5. Nothing has changed." onRetry={() => void query.refetch()} />
        ) : !data ? (
          <SkeletonRows rows={5} rowHeight={48} />
        ) : empty ? (
          <EmptyState
            size="compact"
            title="Nothing settled in this period"
            message="Papers appear here once they have been settled. Try all time, or another department."
          />
        ) : (
          <div className="space-y-4">
          {/* The lists take as many columns as the room beside the strip allows
              (a container query, not the window's width): three need 64rem, two
              need 42rem, else they stack. Each is then over 18rem wide, so a
              value never has to be clipped. */}
          <div className="@container">
          <div
            className={
              lists.length === 3
                ? "grid grid-cols-[minmax(0,1fr)] gap-8 @2xl:grid-cols-2 @5xl:grid-cols-3 @2xl:gap-6"
                : "grid grid-cols-[minmax(0,1fr)] gap-8 @2xl:grid-cols-2 @2xl:gap-6"
            }
          >
            {lists.map((spec) => {
              const rows = data[spec.key] ?? []
              return (
                <section key={spec.key} aria-label={spec.title} className="min-w-0" data-testid={`top5-${spec.key}`}>
                  <h3 className="mb-2 text-base font-medium text-fg">{spec.title}</h3>
                  <Table
                    rows={rows}
                    columns={columns(spec)}
                    getKey={(r) => r.user_id ?? r.staff_id ?? r.name}
                    stack={false}
                    empty={<span>Nothing settled in this period.</span>}
                    tools={{
                      id: `top5-${spec.key}`,
                      title: `Top 5, ${spec.title.toLowerCase()}`,
                      subtitle: `${scope}${data.label}`,
                    }}
                  />
                </section>
              )
            })}
          </div>
          </div>
          <p className="text-sm text-fg-muted">
            {data.label}{data.period === "all" ? "" : ", by the month the money was paid"}.{" "}
            <Link to="/standings" className="font-medium text-accent underline-offset-2 hover:underline">
              See everybody
            </Link>
          </p>
          </div>
        )}
      </PeriodFrame>
    </Section>
  )
}
