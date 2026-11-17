import { useState } from "react"
import { keepPreviousData } from "@tanstack/react-query"

import { useAuth } from "@/app/auth"
import { deptLabel } from "@/lib/names"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Select } from "@/ui/field"
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
}

export type Top5Payload = {
  period: Period
  label: string
  department: string | null
  generated_at: string
  snip: Top5Row[]
  /** Null for a head of department. */
  /** Left out entirely for the money-blind roles (a head of department). */
  remuneration?: Top5Row[] | null
  count: Top5Row[]
}

type Period = "all" | "year" | "month"

const PERIODS: { value: Period; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "year", label: "This academic year" },
  { value: "month", label: "This month" },
]

/** The roles the server answers for (`api/top5.py`). */
const COLLEGE_WIDE = new Set(["PRINCIPAL", "DIRECTOR", "SUPER_ADMIN", "RESEARCH_COORDINATOR", "FINANCE"])

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
      className: "w-12 tabular-nums text-fg-muted",
      exportValue: (r) => r.rank,
      exportKind: "number",
      cell: (r) => r.rank,
    },
    {
      key: "name",
      header: "Name",
      exportValue: (r) => r.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar
            size="sm"
            person={{ name: r.name, initials: r.initials ?? "", photo_url: r.photo_url ?? r.photo ?? null }}
          />
          <span className="min-w-0">
            <PersonLink id={r.user_id} name={r.name} className="block truncate" />
            {r.department && <span className="block truncate text-xs text-fg-muted">{deptLabel(r.department)}</span>}
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
      className: "tabular-nums font-medium",
      exportValue: (r) => r.value,
      exportKind: spec.kind,
      cell: (r) => spec.show(r.value),
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
  const [period, setPeriod] = useState<Period>("all")
  const [department, setDepartment] = useState("")

  const query = useApi<Top5Payload>(
    ["top5", period, wide ? department : ""],
    `/api/dashboard/top5?period=${period}${wide && department ? `&department=${encodeURIComponent(department)}` : ""}`,
    { enabled: allowed, placeholderData: keepPreviousData }
  )
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments", { enabled: wide })

  if (!allowed) return null

  const data = query.data
  const lists = LISTS.filter((l) => data?.[l.key] != null)
  const empty = !!data && lists.every((l) => (data[l.key] ?? []).length === 0)
  const scope = data?.department ? `${deptLabel(data.department)}, ` : ""

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        size="sm"
        aria-label="Period"
        value={period}
        onChange={(e) => setPeriod(e.target.value as Period)}
        className="w-auto max-sm:w-full"
      >
        {PERIODS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </Select>
      {wide && (
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
      )}
    </div>
  )

  return (
    <Section id={id} title={title} action={controls} className={className} data-testid="top5-board">
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
        <div
          className={
            lists.length === 3
              ? "grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-3 lg:gap-6"
              : "grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-2 lg:gap-6"
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
      )}
    </Section>
  )
}
