import { Link } from "react-router-dom"

import { useApi } from "@/lib/query"
import { cn } from "@/lib/cn"
import { Meta, SectionTitle } from "@/ui/text"

export type Goal = {
  metric: string
  label: string
  target: number
  done: number | null
  available: boolean
  fraction: number | null
  met: boolean
  built_in: boolean
}

export type Goals = {
  year: number
  years: number[]
  goals: Goal[]
  metrics: { key: string; label: string }[]
  citations_available: boolean
}

/**
 * One goal as a ring: how far along it is, and the two numbers that say so.
 *
 * The numbers are always written out beside the ring. A ring alone asks the
 * reader to judge an arc, and colour alone would say "met" to only some of
 * the people reading it; "3 of 4" says it to everybody.
 */
export function GoalRing({ goal, size = 88 }: { goal: Goal; size?: number }) {
  const stroke = Math.max(6, Math.round(size / 11))
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const fraction = Math.min(1, goal.fraction ?? 0)
  const words = goal.available
    ? `${goal.done} of ${goal.target}`
    : "Not counted yet"
  return (
    <figure className="flex min-w-0 flex-col items-center gap-2 text-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${goal.label}: ${words}`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-sunken"
        />
        {goal.available && fraction > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference * fraction} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className={cn(
              "transition-[stroke-dasharray] duration-[var(--dur-3)] ease-out",
              goal.met ? "stroke-positive" : "stroke-accent"
            )}
          />
        )}
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className="fill-fg text-lg font-semibold tabular"
        >
          {goal.available ? goal.done : "—"}
        </text>
      </svg>
      <figcaption className="min-w-0">
        <span className="block truncate text-sm font-medium">{goal.label}</span>
        <Meta className={cn("block tabular", goal.met && "text-positive")}>
          {goal.met ? `${words} · met` : words}
        </Meta>
      </figcaption>
    </figure>
  )
}

/**
 * The signed-in person's goals for this year, as rings. For a home page or a
 * profile: one line to mount, and it fetches its own data.
 *
 * With no goals set it offers the one link that would set them, and says
 * nothing else -- no reminder, no count of days left. A failed request draws
 * nothing: this sits beside things that matter more.
 */
export function GoalRings({ className, title }: { className?: string; title?: string }) {
  const query = useApi<Goals>(["goals", "mine", ""], "/api/me/goals")
  if (query.isError || query.isLoading || !query.data) return null
  const { goals, year } = query.data

  return (
    <section aria-label={`Your goals for ${year}`} className={cn("space-y-3", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle>{title ?? `Your goals for ${year}`}</SectionTitle>
        <Link to="/goals" className="text-sm text-accent hover:underline">
          {goals.length ? "Change" : "Set goals"}
        </Link>
      </div>
      {goals.length === 0 ? (
        <p className="text-base text-fg-muted">
          Set a number of papers for {year}, if you would like to track one. Only you see it.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {goals.map((g) => (
            <GoalRing key={`${g.metric}-${g.built_in}`} goal={g} />
          ))}
        </div>
      )}
    </section>
  )
}
