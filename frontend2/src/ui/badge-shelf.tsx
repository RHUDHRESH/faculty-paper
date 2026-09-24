import { Link } from "react-router-dom"
import {
  Award,
  BookOpen,
  CalendarCheck,
  Layers,
  type LucideIcon,
  Network,
  PenLine,
  Quote,
  Star,
  Target,
  Trophy,
} from "lucide-react"

import { useApi } from "@/lib/query"
import { cn } from "@/lib/cn"
import { SectionTitle, Meta } from "@/ui/text"
import { Skeleton } from "@/ui/state"

/** A badge as `/api/users/{id}/badges` sends it. It never carries money. */
export type Badge = {
  id: string
  kind: string
  key: string
  label: string
  description: string
  detail: string
  earned_on: string
  evidence: { title: string; journal: string; year: number | null }
  /** Only on the owner's own shelf: the claim the badge was earned by. */
  claim_id: string | null
}

type Shelf = {
  user: { id: string; name: string; department: string | null }
  badges: Badge[]
  catalogue: { kind: string; label: string; description: string }[]
}

const ICON: Record<string, LucideIcon> = {
  FIRST_PAPER: BookOpen,
  FIRST_Q1: Star,
  PAPERS_5: Layers,
  PAPERS_10: Layers,
  PAPERS_25: Layers,
  FIRST_AUTHOR: PenLine,
  CROSS_DEPARTMENT: Network,
  QUOTA_MET: Target,
  TOP10_DEPARTMENT: Trophy,
  STREAK_3: CalendarCheck,
  STREAK_6: CalendarCheck,
  FIRST_CITATION: Quote,
}

export function badgeIcon(kind: string): LucideIcon {
  return ICON[kind] ?? Award
}

/** "2024-03-01" -> "Mar 2024". A badge is dated to the month, not the day. */
export function earnedLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number)
  if (!y || !m) return iso
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" })
}

/**
 * A person's badges, for any page that shows a person.
 *
 * Self-contained on purpose -- give it a user id and it fetches, draws and
 * handles its own states -- so a profile page mounts it with one line and
 * does not have to know how badges work. Without it each page that shows a
 * person would rebuild the same list and the next one would forget the
 * evidence line, which is the part that makes a badge mean something: every
 * badge names the paper that earned it.
 *
 * A failed request draws nothing rather than an error box: a shelf is a
 * courtesy on somebody else's page, and it must never be the thing that
 * makes that page look broken.
 */
export function BadgeShelf({
  userId,
  title = "Badges",
  own = false,
  className,
}: {
  userId: string
  title?: string
  /** On the person's own page: says how badges are earned when there are none. */
  own?: boolean
  className?: string
}) {
  const shelf = useApi<Shelf>(["badges", userId], `/api/users/${userId}/badges`, {
    enabled: Boolean(userId),
  })

  if (shelf.isError) return null
  const badges = shelf.data?.badges ?? []
  if (!shelf.isLoading && badges.length === 0 && !own) return null

  return (
    <section aria-label={title} id="badges" className={cn("space-y-3", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle>{title}</SectionTitle>
        {badges.length > 0 && <Meta>{badges.length} earned</Meta>}
      </div>
      {shelf.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      ) : badges.length === 0 ? (
        <p className="max-w-prose text-base text-fg-muted">
          No badges yet. They arrive on their own when a paper is approved for payment or paid —
          a first paper, a first Q1, a paper led as first author, and more.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {badges.map((b) => (
            <BadgeTile key={b.id} badge={b} />
          ))}
        </ul>
      )}
    </section>
  )
}

export function BadgeTile({ badge: b, className }: { badge: Badge; className?: string }) {
  const Icon = badgeIcon(b.kind)
  const evidence = b.claim_id ? (
    <Link to={`/papers/${b.claim_id}`} className="hover:underline">
      {b.evidence.title}
    </Link>
  ) : (
    b.evidence.title
  )
  return (
    <li className={cn("panel flex min-w-0 gap-3 p-4", className)}>
      <span
        aria-hidden
        className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-wash text-accent ring-1 ring-inset ring-accent-line"
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="font-medium">{b.label}</span>
          <Meta className="tabular">{earnedLabel(b.earned_on)}</Meta>
        </p>
        {b.detail && b.kind !== "TOP10_DEPARTMENT" && (
          <p className="text-sm text-fg-muted">{b.detail}</p>
        )}
        {b.evidence.title && (
          <p className="mt-1 line-clamp-2 text-sm text-fg-muted" title={b.evidence.title}>
            {evidence}
          </p>
        )}
      </div>
    </li>
  )
}
