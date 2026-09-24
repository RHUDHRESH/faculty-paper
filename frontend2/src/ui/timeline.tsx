import { Award, FileText, Gem, Quote, type LucideIcon } from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import type { Area } from "@/ui/chip"

export type TimelineKind = "paper" | "first-q1" | "citation" | "award"

export type TimelineEvent = {
  /** ISO date or "YYYY" / "YYYY-MM". Events are grouped by its year. */
  date: string
  kind: TimelineKind
  title: React.ReactNode
  detail?: React.ReactNode
  to?: string
}

const KIND: Record<TimelineKind, { icon: LucideIcon; area: Area; label: string }> = {
  paper: { icon: FileText, area: "record", label: "Paper" },
  "first-q1": { icon: Gem, area: "honours", label: "First Q1" },
  citation: { icon: Quote, area: "research", label: "Citation milestone" },
  award: { icon: Award, area: "honours", label: "Award" },
}

/**
 * A vertical career line (docs/ux/00 §8): year markers, then events with an
 * area-coloured dot. Newest year first. Used on My research and Person.
 */
export function Timeline({ events, className }: { events: TimelineEvent[]; className?: string }) {
  const byYear = new Map<string, TimelineEvent[]>()
  for (const e of [...events].sort((a, b) => b.date.localeCompare(a.date))) {
    const y = e.date.slice(0, 4)
    byYear.set(y, [...(byYear.get(y) ?? []), e])
  }
  return (
    <ol className={cn("relative flex flex-col gap-6 border-l border-edge pl-6", className)}>
      {[...byYear].map(([year, list]) => (
        <li key={year}>
          <h3 className="-ml-6 mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
            <span aria-hidden className="-ml-[5px] size-2.5 rounded-full bg-edge" />
            {year}
          </h3>
          <ol className="flex flex-col gap-3">
            {list.map((e, i) => {
              const k = KIND[e.kind]
              const Icon = k.icon
              return (
                <li key={i} data-area={k.area} className="relative">
                  <span aria-hidden className="absolute top-1.5 -left-[29px] size-2 rounded-full bg-(--area-fill)" />
                  <div className="flex items-start gap-2">
                    <Icon aria-label={k.label} className="mt-0.5 size-4 shrink-0 text-(--area)" strokeWidth={1.75} />
                    <div className="min-w-0">
                      <p className="text-sm text-fg">
                        {e.to ? (
                          <Link to={e.to} className="hover:underline hover:underline-offset-4">
                            {e.title}
                          </Link>
                        ) : (
                          e.title
                        )}
                      </p>
                      {e.detail && <p className="text-xs text-fg-muted">{e.detail}</p>}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        </li>
      ))}
    </ol>
  )
}
