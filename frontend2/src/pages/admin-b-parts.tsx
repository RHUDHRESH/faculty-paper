import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"

import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { money } from "@/ui/paper"
import { Avatar } from "@/ui/person"
import { Details } from "@/ui/section"
import { Meta } from "@/ui/text"
import { Ago } from "@/ui/when"

/**
 * Small pieces the super admin's views share, so the same thing reads the same
 * way on every one of them (docs/ux/22): a claim number from the old ERP that
 * explains itself, a face and name, an amount that says so when it is missing,
 * and the change history of a record in plain words. The page anatomy itself
 * (PageHeader, Answer, Section, Rows, Details, Table) comes from the kit.
 */

export const NOT_RECORDED = "Not recorded"

/** A rupee amount, or "Not recorded": never a lone dash. */
export function amountText(value: number | null | undefined): string {
  return value == null ? NOT_RECORDED : money(value)
}

/** A whole number with Indian grouping, never "99+". */
export const count = formatCount

export function plural(n: number, one: string, many?: string): string {
  return `${count(n)} ${n === 1 ? one : (many ?? `${one}s`)}`
}

/* ------------------------------------------------------------------------ */
/* People and claim numbers                                                 */
/* ------------------------------------------------------------------------ */

export type Face = {
  user_id: string
  name: string
  initials?: string
  photo_url?: string | null
}

/** A face and a name that opens the person's record. */
export function FaceName({
  person,
  className,
  size = "xs",
  link = true,
}: {
  person: Face
  className?: string
  size?: "xs" | "sm"
  link?: boolean
}) {
  const inner = (
    <>
      <Avatar
        person={{
          name: person.name,
          initials: person.initials ?? "",
          photo_url: person.photo_url ?? null,
        }}
        size={size}
      />
      <span className="min-w-0 truncate">{person.name}</span>
    </>
  )
  const cls = cn("inline-flex min-w-0 max-w-full items-center gap-2", className)
  return link ? (
    <Link to={`/faculty/${person.user_id}`} className={cn(cls, "underline-offset-2 hover:underline")}>
      {inner}
    </Link>
  ) : (
    <span className={cls}>{inner}</span>
  )
}

export function isImported(no: string | null | undefined): boolean {
  return !!no && no.startsWith("ERP-")
}

/** What an ERP claim number is, said once per view (docs/ux/22). */
export const IMPORTED_MEANING =
  "Claim numbers that start with ERP- were brought across from the old ERP workbook. They are not numbers this system issued."

/**
 * A claim number. One from the old ERP carries a dotted underline and says
 * what it is on hover; ImportedNote states the same once in words at the top
 * of any view that lists them.
 */
export function ClaimNo({ no, className }: { no: string | null | undefined; className?: string }) {
  if (!no) return <span className={cn("text-fg-muted", className)}>Draft, no number yet</span>
  if (!isImported(no)) return <span className={cn("tabular", className)}>{no}</span>
  return (
    <span
      title={IMPORTED_MEANING}
      className={cn("tabular cursor-help underline decoration-dotted underline-offset-4", className)}
    >
      {no}
    </span>
  )
}

/** The legend, once, when the list below has any imported numbers. */
export function ImportedNote({ show = true }: { show?: boolean }) {
  if (!show) return null
  return <p className="text-sm text-fg-muted">{IMPORTED_MEANING}</p>
}

/* ------------------------------------------------------------------------ */
/* Change history                                                           */
/* ------------------------------------------------------------------------ */

type HistoryEntry = {
  id: string
  at: string
  who: Face | null
  what: string
  changes: { label: string; from: string; to: string }[]
  reason: string | null
  note?: string | null
}

type HistoryEntity = "Claim" | "User" | "FormulaConfig" | "Budget" | "PaidLedger" | "DuplicateFinding" | "system_setting"

function HistoryList({ entity, id }: { entity: HistoryEntity; id: string }) {
  const { data, isLoading, isError } = useApi<{ entries: HistoryEntry[] }>(
    ["history", entity, id],
    `/api/admin/history?entity=${entity}&id=${encodeURIComponent(id)}`
  )
  if (isLoading) return <Meta>Reading the log.</Meta>
  if (isError) return <Meta>The history could not be read. Try again in a moment.</Meta>
  if (!data || data.entries.length === 0) return <Meta>Nobody has changed this since it was recorded.</Meta>
  return (
    <ul className="divide-y divide-line">
      {data.entries.map((e) => (
        <li key={e.id} className="py-2.5 text-sm">
          <p>
            <span className="font-medium">{e.who?.name ?? "The system"}</span> {e.what}
            <Meta className="ml-2">
              <Ago iso={e.at} />
            </Meta>
          </p>
          {e.changes.map((c) => (
            <p key={c.label} className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-fg-muted">
              <span>{c.label}:</span>
              <span className="line-through decoration-fg-subtle">{c.from}</span>
              <ArrowRight aria-hidden className="size-3 self-center text-fg-subtle" />
              <span className="font-medium text-fg">{c.to}</span>
            </p>
          ))}
          {e.reason && <p className="mt-1 text-fg-muted">Reason given: {e.reason}</p>}
          {e.note && <p className="mt-1 line-clamp-3 text-fg-muted">Note: {e.note}</p>}
        </li>
      ))}
    </ul>
  )
}

/**
 * Who changed this record, when, from what to what. Read from the audit log and
 * told in words. Sits one step away: it opens on request and is read only then.
 */
export function ChangeHistory({
  entity,
  id,
  className,
}: {
  entity: HistoryEntity
  id: string
  className?: string
}) {
  return (
    <Details label="change history" className={className}>
      <HistoryList entity={entity} id={id} />
    </Details>
  )
}
