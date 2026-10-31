import { useEffect, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { useAuth } from "@/app/auth"
import { api, type ApiError } from "@/lib/api"
import { BADGES_KEY } from "@/lib/query"
import { useIdle } from "@/lib/use-idle"

/**
 * The frame's three badges -- the desk counts beside the sidebar entries, the
 * bell's unread number and the Messages badge -- from one request.
 *
 * They were three polls (60 s, 45 s, 30 s), so a tab left open sent a request
 * every fourteen seconds for as long as it was on screen, and a free host and
 * database that are never quiet never sleep. They share one query now:
 *
 *  - `useBadgeClock` is mounted once, by the shell. It is the only thing that
 *    owns a timer: every two minutes while somebody is at the page, none after
 *    five minutes of no input, and one request at once when they come back.
 *  - `useBadges` reads one slice of the answer and schedules nothing, so the
 *    bell (drawn twice, for the wide and the narrow header), the Messages badge
 *    and the sidebar can read it as often as they like at no cost.
 *
 * Each slice is exactly what its own endpoint answers (`/claims/counts`,
 * `/notifications/unread-count`, `/dm/unread`), so every reader keeps the
 * shape it had.
 */

export interface ShellBadges {
  stage_counts: { counts: Record<string, number>; statuses?: Record<string, number>; stages?: Record<string, string[]> }
  notifications: { unread: number }
  dm: { unread: number; conversations: number }
}

/** How often the badges are read while somebody is at the page. */
export const BADGES_POLL_MS = 120_000
/** How long without any input before the page stops reading them. */
export const BADGES_IDLE_MS = 5 * 60_000
const FRESH_MS = 30_000

const read = () => api<ShellBadges>("/api/shell/badges")

export const stageCountsOf = (b: ShellBadges) => b.stage_counts
export const notificationsOf = (b: ShellBadges) => b.notifications
export const messagesOf = (b: ShellBadges) => b.dm

/** One slice of the badges. Reads what is there; the clock below keeps it current. */
export function useBadges<S>(select: (b: ShellBadges) => S) {
  const { me } = useAuth()
  return useQuery<ShellBadges, ApiError, S>({
    queryKey: BADGES_KEY,
    queryFn: read,
    select,
    staleTime: FRESH_MS,
    enabled: !!me,
  })
}

/**
 * Keeps the badges current: the single poll. Mount it once.
 *
 * Coming back after the page went idle reads them immediately, rather than
 * leaving a badge from half an hour ago on screen for another two minutes.
 * Returning to the tab reads them too, when they are older than `FRESH_MS`.
 */
export function useBadgeClock(enabled: boolean) {
  const qc = useQueryClient()
  const idle = useIdle(BADGES_IDLE_MS)

  useQuery<ShellBadges, ApiError>({
    queryKey: BADGES_KEY,
    queryFn: read,
    staleTime: FRESH_MS,
    enabled,
    refetchInterval: idle ? false : BADGES_POLL_MS,
    refetchOnWindowFocus: true,
  })

  const wasIdle = useRef(false)
  useEffect(() => {
    if (wasIdle.current && !idle && enabled) void qc.invalidateQueries({ queryKey: BADGES_KEY })
    wasIdle.current = idle
  }, [idle, enabled, qc])
}
