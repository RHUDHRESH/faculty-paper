import { useQuery } from "@tanstack/react-query"

import { GROUP_AREA, type Row } from "@/app/search-engine"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Chip } from "@/ui/chip"
import { Avatar, initialsOf } from "@/ui/person"
import { Picture, topicPicture } from "@/ui/picture"

type ConnectionBody = {
  hops: number | null
  paths: { people: { key: string; user_id: string | null; name: string; photo_url?: string | null; via: { id: string }[] }[] }[]
}

/** "3 papers together", "2 steps away via <face> Name", or "Not connected yet". */
export function ConnectionLine({ meId, to }: { meId: string; to: string }) {
  const self = to === meId
  const { data, isLoading } = useQuery<ConnectionBody>({
    queryKey: ["connection", meId, to],
    queryFn: () => api<ConnectionBody>(`/api/people/${meId}/connection?to=${encodeURIComponent(to)}`),
    enabled: !!to && !self,
    retry: false,
    staleTime: 5 * 60_000,
  })
  if (self) return <span className="text-xs text-fg-subtle">This is you</span>
  if (!to) return null
  if (isLoading) return <span aria-hidden className="inline-block h-3 w-28 animate-pulse rounded bg-sunken" />
  const path = data?.paths[0]?.people
  if (!data || !path || data.hops == null || data.hops > 3) return <span className="text-xs text-fg-subtle">Not connected yet</span>
  if (data.hops === 1) {
    const n = path[path.length - 1]?.via?.length ?? 0
    return <span className="text-xs font-medium text-accent">{n ? `${n} ${n === 1 ? "paper" : "papers"} together` : "Worked with you"}</span>
  }
  const via = path[1]
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-xs text-fg-muted">
      <span className="shrink-0">{data.hops} steps away via</span>
      {via && <Avatar person={{ name: via.name, initials: initialsOf(via.name), photo_url: via.photo_url ?? null }} size="xs" className="size-5 shrink-0 text-[10px]" />}
      <span className="truncate text-fg">{via?.name}</span>
    </span>
  )
}

/** A readable venue: never a raw URL. */
function venueOf(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null
  if (/^https?:/i.test(v)) {
    try {
      return new URL(v).hostname.replace(/^www\./, "")
    } catch {
      return null
    }
  }
  return v
}

/** Kind-aware sentence under the title. */
export function subtitleOf(row: Row): string | undefined {
  const m = row.item?.meta
  if (!m) return row.subtitle
  if (row.kind === "person") {
    if (m.external) return [row.item!.subtitle, m.papers ? `${m.papers} papers` : null].filter(Boolean).join(" · ")
    return [m.department, m.designation, m.papers ? `${m.papers} papers` : null].filter(Boolean).join(" · ")
  }
  if (row.kind === "paper") return [venueOf(m.venue), m.year].filter(Boolean).join(" · ") || undefined
  return row.subtitle
}

export function RowLead({ row, roomy }: { row: Row; roomy: boolean }) {
  const it = row.item
  const m = it?.meta ?? {}
  const Icon = row.icon
  const area = GROUP_AREA[row.kind]
  if (row.kind === "person" && it)
    return <Avatar person={{ name: it.title, initials: initialsOf(it.title), photo_url: m.external ? null : (m.photo_url ?? null) }} size={roomy ? "lg" : "sm"} className="shrink-0" />
  const pic = row.kind === "paper" || row.kind === "topic" || row.kind === "claim" ? topicPicture(row.title, m.venue) : null
  const box = roomy ? "size-16 rounded-xl" : "size-8 rounded-md"
  if (pic)
    return (
      <span data-area={area} className={cn("grid shrink-0 place-items-center overflow-hidden bg-(--area-wash)", box)}>
        <Picture name={pic} className="h-full w-full" />
      </span>
    )
  if (row.kind === "journal" && m.quartile)
    return (
      <span data-area="research" title={`Quartile ${m.quartile}`} className={cn("grid shrink-0 place-items-center bg-(--area-wash) font-semibold text-(--area)", box, roomy ? "text-lg" : "text-xs")}>
        {m.quartile}
      </span>
    )
  return (
    <span data-area={area} className={cn("grid shrink-0 place-items-center", box, area ? "bg-(--area-wash)" : "bg-sunken")}>
      <Icon aria-hidden className={cn(roomy ? "size-6" : "size-4", area ? "text-(--area)" : "text-fg-subtle")} strokeWidth={1.75} />
    </span>
  )
}

/**
 * One result row, shared by the Ctrl-K palette (compact) and /search (roomy):
 * a face for people, a topic picture for papers, the quartile for journals,
 * and how you are connected to each colleague.
 */
export function ResultRow({
  row,
  id,
  active,
  onPick,
  onHover,
  roomy = false,
  meId,
  trailing,
}: {
  row: Row
  id: string
  active: boolean
  onPick: () => void
  onHover?: () => void
  roomy?: boolean
  /** Shows the connection line on colleague rows. */
  meId?: string
  trailing?: React.ReactNode
}) {
  const m = row.item?.meta ?? {}
  const sub = subtitleOf(row)
  const chips = row.chips.filter((c) => c !== "Saveetha" && !(row.kind === "person" && m.external))
  if (row.kind === "journal" && m.quartile && !roomy) chips.unshift(m.quartile)
  if (row.kind === "paper" && m.mine && !chips.includes("Yours")) chips.unshift("Yours")
  const connect = row.kind === "person" && meId && typeof m.connect === "string" && !m.external ? (m.connect as string) : null
  const withCollege = row.kind === "person" && m.external ? ((m.college_coauthors ?? []) as { name: string }[]) : []
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onPick}
      className={cn(
        "flex cursor-pointer items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-(--color-accent)",
        roomy ? "gap-4 rounded-xl px-3 py-3" : "gap-3 rounded-lg px-3 py-2",
        active ? "bg-hover" : roomy && "hover:bg-hover/60"
      )}
    >
      <RowLead row={row} roomy={roomy} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-fg", roomy ? "line-clamp-2 text-[15px] font-medium" : "truncate text-sm")}>{row.title}</span>
        {sub && <span className={cn("block truncate text-fg-muted", roomy ? "text-sm" : "text-xs")}>{sub}</span>}
        {roomy && connect && (
          <span className="mt-1 flex">
            <ConnectionLine meId={meId!} to={connect} />
          </span>
        )}
        {roomy && withCollege.length > 0 && (
          <span className="mt-1 block truncate text-xs text-fg-muted">Wrote with {withCollege.slice(0, 2).map((c) => c.name).join(", ")}</span>
        )}
      </span>
      {chips.slice(0, 2).map((c) => (
        <Chip key={c} tone={c === "Yours" ? "area" : "neutral"} className="max-w-40 truncate max-sm:hidden">
          {c}
        </Chip>
      ))}
      {trailing}
      {active && !roomy && (
        <span className="shrink-0 text-xs text-fg-subtle max-sm:hidden">
          {row.run ? "↵ run" : "↵ open"}
          {row.secondary && ` · Ctrl↵ ${row.secondary.label.toLowerCase()}`}
        </span>
      )}
    </div>
  )
}
