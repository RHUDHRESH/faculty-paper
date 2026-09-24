import { useEffect, useState } from "react"

import { useAuth } from "@/app/auth"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { NumberInput } from "@/ui/field"
import { GoalRing, type Goals } from "@/ui/goal-rings"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

type RollUp = {
  department: string
  year: number
  people_in_department: number
  people_with_goals: number
  metrics: {
    metric: string
    label: string
    people: number
    target_total: number
    done_total: number
    met: number
  }[]
}

/**
 * A person's own goals for the year, set by them and seen only by them.
 *
 * Progress is counted from the papers the college has recognised, the same
 * records the badges use, so a goal and a badge never disagree about how
 * many papers somebody has. There are no reminders and no deadlines here:
 * the page answers "how am I doing" when it is asked, and asks nothing back.
 *
 * Research faculty see their quota as a goal they did not have to set,
 * because the research coordinator agreed it with them. A head of department
 * also sees how their department's goals are going -- as counts, never whose
 * goal is whose.
 */
export function GoalsPage() {
  const { me } = useAuth()
  const now = new Date().getFullYear()
  const [year, setYear] = useState(now)
  const query = useApi<Goals>(["goals", "mine", year], `/api/me/goals?year=${year}`)
  const save = useApiMutation<{ year: number; goals: { metric: string; target: number }[] }, Goals>(
    "/api/me/goals",
    { method: "PUT", invalidates: [["goals"]] }
  )
  const [draft, setDraft] = useState<Record<string, string>>({})

  const data = query.data
  useEffect(() => {
    if (!data) return
    const next: Record<string, string> = {}
    for (const m of data.metrics) {
      const g = data.goals.find((x) => x.metric === m.key && !x.built_in)
      next[m.key] = g ? String(g.target) : ""
    }
    setDraft(next)
  }, [data])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!data) return
    const goals = data.metrics.map((m) => ({
      metric: m.key,
      target: Math.max(0, Math.floor(Number(draft[m.key] || 0))),
    }))
    try {
      await save.mutateAsync({ year, goals })
      toast.ok(`Goals for ${year} saved`)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <div className="page space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <PageTitle>Your goals</PageTitle>
          <Sub>What you mean to publish this year, in your own numbers. Only you see them.</Sub>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">Year</span>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="h-8 rounded-md bg-surface px-2 text-sm text-fg ring-1 ring-inset ring-field outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {[now + 1, now, now - 1].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </header>

      {query.isError ? (
        <InlineError message="Could not load your goals." onRetry={() => void query.refetch()} />
      ) : !data ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : (
        <>
          <section aria-label="Where your goals stand" className="space-y-3">
            <SectionTitle>Where they stand</SectionTitle>
            {data.goals.length === 0 ? (
              <p className="text-base text-fg-muted">No goals for {year} yet. Set one below.</p>
            ) : (
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                {data.goals.map((g) => (
                  <GoalRing key={`${g.metric}-${g.built_in}`} goal={g} size={104} />
                ))}
              </div>
            )}
          </section>

          <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label="Set your goals">
            <SectionTitle>Set them</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              {data.metrics.map((m) => (
                <label key={m.key} className="flex items-center justify-between gap-4">
                  <span className="text-base">
                    {m.label}
                    {m.key === "CITATIONS" && !data.citations_available && (
                      <Meta className="block">Counted once Scopus reports citations for your papers.</Meta>
                    )}
                  </span>
                  <NumberInput
                    className="w-28"
                    min={0}
                    max={1000}
                    inputMode="numeric"
                    aria-label={`${m.label} goal for ${year}`}
                    placeholder="None"
                    value={draft[m.key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [m.key]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <Meta className="block">Leave a box empty, or put 0, for no goal.</Meta>
            <Button type="submit" kind="primary" disabled={save.isPending}>
              Save goals for {year}
            </Button>
          </form>
        </>
      )}

      {(me?.role === "HOD" || me?.role === "SUPER_ADMIN") && me?.department && (
        <DepartmentGoals year={year} />
      )}
    </div>
  )
}

function DepartmentGoals({ year }: { year: number }) {
  const query = useApi<RollUp>(["goals", "department", year], `/api/hod/goals?year=${year}`)
  if (query.isError || !query.data) return null
  const d = query.data
  return (
    <section aria-label="Your department's goals" className="space-y-3">
      <div>
        <SectionTitle>{d.department}'s goals for {d.year}</SectionTitle>
        <Meta className="block">
          {d.people_with_goals} of {d.people_in_department} people have set a goal. Counts only —
          whose goal is whose stays with them.
        </Meta>
      </div>
      {d.metrics.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {d.metrics.map((m) => (
            <li key={m.metric} className="flex flex-wrap items-baseline justify-between gap-3 py-2.5">
              <span className="text-base">{m.label}</span>
              <span className="text-sm text-fg-muted tabular">
                {m.people} {m.people === 1 ? "person" : "people"} · {m.met} met · {m.done_total} of{" "}
                {m.target_total} altogether
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
