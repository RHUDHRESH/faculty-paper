import { cn } from "@/lib/cn"
import { Avatar, initialsOf } from "@/ui/person"

/**
 * Who a claim has been given to, for any queue that lists claims.
 *
 * The coordination page (`/coordination`) gives claims to reviewers, and the
 * server adds `assigned_to` to each row of `/api/admin/clearing-queue`. These
 * are the two small pieces a queue drops in to use it:
 *
 *   <AssignedToMeChip rows={rows} me={me?.id} active={mine} onToggle={...} />
 *   <AssigneeBadge assignee={row.assigned_to} me={me?.id} />
 *
 * and, to filter on the server rather than on the page in front of you,
 * `/api/admin/clearing-queue?assigned=me` (or `none`, or a user id).
 *
 * An assignment is advisory: anybody at the desk may still act on the claim.
 * It says who was asked to.
 */

/** As the queue API sends it: `null` when nobody has been asked. */
export type Assignee = {
  user_id: string
  name: string
  initials?: string
  photo_url?: string | null
  assigned_at?: string | null
}

export type WithAssignee = { assigned_to?: Assignee | null }

export function isAssignedToMe(row: WithAssignee, me: string | null | undefined): boolean {
  return !!me && row.assigned_to?.user_id === me
}

export function countAssignedToMe(rows: WithAssignee[], me: string | null | undefined): number {
  return rows.filter((r) => isAssignedToMe(r, me)).length
}

/** Face and first name of the assignee, or "You" when it is the viewer.
 *  Nothing at all when the claim is not assigned, unless `empty` is given. */
export function AssigneeBadge({
  assignee,
  me,
  empty,
  className,
}: {
  assignee: Assignee | null | undefined
  me?: string | null
  /** Text for an unassigned claim, e.g. "Not assigned". Omitted: renders nothing. */
  empty?: string
  className?: string
}) {
  if (!assignee) {
    return empty ? <span className={cn("text-sm text-fg-muted", className)}>{empty}</span> : null
  }
  const mine = !!me && assignee.user_id === me
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm", mine && "font-medium", className)}
      title={`Given to ${mine ? "you" : assignee.name}`}
    >
      <Avatar
        size="xs"
        person={{
          name: assignee.name,
          initials: assignee.initials || initialsOf(assignee.name),
          photo_url: assignee.photo_url ?? null,
        }}
      />
      <span className="truncate">{mine ? "You" : assignee.name}</span>
    </span>
  )
}

/** The queue's first filter for a reviewer: the claims given to them. Renders
 *  nothing while none are, so a reviewer nobody has assigned to sees no chip. */
export function AssignedToMeChip({
  rows,
  me,
  active,
  onToggle,
  className,
}: {
  rows: WithAssignee[]
  me: string | null | undefined
  active: boolean
  onToggle: () => void
  className?: string
}) {
  const n = countAssignedToMe(rows, me)
  if (n === 0 && !active) return null
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm ring-1 ring-inset transition-colors duration-[var(--dur-1)] ease-out max-sm:h-10",
        active
          ? "bg-accent-wash font-medium text-accent ring-accent-line"
          : "bg-surface text-fg-muted ring-line hover:text-fg",
        className
      )}
    >
      Assigned to me <span className="tabular">{n}</span>
    </button>
  )
}
