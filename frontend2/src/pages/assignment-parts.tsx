import { cn } from "@/lib/cn"
import { Select } from "@/ui/field"

/**
 * The pieces of an assignment that the head's department page and a faculty
 * member's home screen both draw.
 *
 * One definition, because the two screens are two ends of the same record:
 * the head sets a status in one and the person it is for moves it in the
 * other, and a status spelt one way on one screen and another way on the
 * next reads as two different states.
 */

export type AssignmentKind = "TASK" | "PAIRING" | "RESEARCH_AREA"
export type AssignmentStatus = "OPEN" | "IN_PROGRESS" | "DONE"

export type Assignment = {
  id: string
  department: string
  kind: AssignmentKind
  kind_label: string
  title: string
  notes: string
  status: AssignmentStatus
  status_label: string
  assignee_id: string
  assignee_name: string
  partner_id: string | null
  partner_name: string | null
  due_date: string | null
  set_by: string | null
  created_at: string | null
  updated_at: string | null
}

/** As `/api/me/assignments` sends it: which end of it I am on, and who with. */
export type MyAssignment = Assignment & {
  my_part: "ASSIGNEE" | "PARTNER"
  with_name: string | null
}

export const STATUSES: { value: AssignmentStatus; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "DONE", label: "Done" },
]

/** What kind of work this is, as a small label ahead of its title. */
export function KindBadge({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm bg-sunken px-1.5 py-px text-xs font-medium text-fg-muted",
        className
      )}
    >
      {label}
    </span>
  )
}

/**
 * The status, changed where it is read.
 *
 * A native select rather than the `Combobox`: three fixed options need no
 * filter box, and a select is one keypress from any of them. It carries the
 * assignment's title in its name, because a column of identical "Status"
 * controls is a column a screen reader cannot tell apart.
 */
export function StatusSelect({
  value,
  title,
  onChange,
  disabled,
}: {
  value: AssignmentStatus
  title: string
  onChange: (status: AssignmentStatus) => void
  disabled?: boolean
}) {
  return (
    <Select
      size="sm"
      value={value}
      onChange={(e) => onChange(e.target.value as AssignmentStatus)}
      disabled={disabled}
      aria-label={`Status of ${title}`}
      className="w-auto shrink-0"
    >
      {STATUSES.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </Select>
  )
}
