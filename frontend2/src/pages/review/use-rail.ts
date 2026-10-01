import { useApi } from "@/lib/query"

import type { QueueName, RailClaim } from "./types"

export const QUEUE_LABEL: Record<QueueName, string> = {
  clearing: "Clearing queue",
  approvals: "Approvals",
  authorisations: "Authorisations",
}

export const QUEUE_PATH: Record<QueueName, string> = {
  clearing: "/clearing",
  approvals: "/approvals",
  authorisations: "/authorisations",
}

export function isQueueName(v: string | null): v is QueueName {
  return v === "clearing" || v === "approvals" || v === "authorisations"
}

/**
 * The claims the workspace steps through with j and k.
 *
 * The clearing queue is fetched under the same key the clearing page uses, so
 * arriving from the list costs no request, and a decision here refreshes the
 * list behind it. The server's order (oldest first) is the queue's own
 * priority and is never re-sorted here.
 */
export function useRail(queue: QueueName, enabled: boolean) {
  const clearing = useApi<RailClaim[]>(["clearing-queue"], "/api/admin/clearing-queue?status=SUBMITTED", {
    enabled: enabled && queue === "clearing",
    placeholderData: (prev) => prev,
  })
  const approvals = useApi<{ results: RailClaim[] }>(["principal-queue", "rail"], "/api/principal/queue?limit=100", {
    enabled: enabled && queue === "approvals",
    placeholderData: (prev) => prev,
  })
  const authorisations = useApi<{ results: RailClaim[] }>(["director-queue", "rail"], "/api/director/queue?limit=100", {
    enabled: enabled && queue === "authorisations",
    placeholderData: (prev) => prev,
  })

  const active = queue === "clearing" ? clearing : queue === "approvals" ? approvals : authorisations
  const rows: RailClaim[] =
    queue === "clearing" ? (clearing.data ?? []) : ((queue === "approvals" ? approvals.data : authorisations.data)?.results ?? [])
  return { rows, isLoading: active.isLoading, isError: active.isError, refetch: active.refetch }
}

/** The rows a filter leaves, in the queue's own order. Matches the claim
 *  number, paper, claimant or journal, like the list's search box. */
export function filterRows(rows: RailClaim[], text: string): RailClaim[] {
  const needle = text.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((c) =>
    [c.paper_title, c.ticket_number, c.owner_name, c.journal_title]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle))
  )
}

/** Which claim follows `id` when it leaves the queue: the next one down, or
 *  the one above it when it was the last. Null when nothing else is left. */
export function nextAfter(rows: RailClaim[], id: string): RailClaim | null {
  const at = rows.findIndex((r) => r.id === id)
  if (at < 0) return rows[0] ?? null
  return rows[at + 1] ?? rows[at - 1] ?? null
}
