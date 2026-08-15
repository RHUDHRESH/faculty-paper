import { useEffect, useState } from "react"

import { api } from "@/lib/api"

export type Note = {
  id: string
  title: string
  body?: string | null
  href?: string | null
  read: boolean
  created_at: string
}

/**
 * One poll and one copy of the list, shared by every bell on screen.
 *
 * The shell renders three NotificationBell instances (desktop rail, mobile
 * sheet, mobile header). With per-component state that was three independent
 * 45s polls, and marking everything read in one left the other two showing a
 * stale unread dot until their own timer came round.
 *
 * The recurring poll only asks for the unread count; the full list is fetched
 * when a bell is actually opened.
 */
const POLL_MS = 45000

type Snapshot = { items: Note[]; unread: number }

let snapshot: Snapshot = { items: [], unread: 0 }
let inFlight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null
const subscribers = new Set<(next: Snapshot) => void>()

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next }
  for (const fn of subscribers) fn(snapshot)
}

export async function refreshUnreadCount(): Promise<void> {
  try {
    const r = await api<{ unread: number }>("/api/notifications/unread-count")
    publish({ unread: r.unread })
  } catch {
    /* logged out, or offline — keep whatever we last had */
  }
}

export async function refreshNotifications(): Promise<void> {
  // Three bells opening together must not become three requests.
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const items = await api<Note[]>("/api/notifications")
      publish({ items, unread: items.filter((n) => !n.read).length })
    } catch {
      /* logged out, or offline — keep whatever we last had */
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * Drop the cached state on sign-out.
 *
 * The store is module state, so without this the next person to sign in on the
 * same tab saw the previous user's notifications until the first poll returned.
 */
export function clearNotifications(): void {
  publish({ items: [], unread: 0 })
}

export async function markAllNotificationsRead(): Promise<void> {
  await api("/api/notifications/read-all", { method: "POST", json: {} })
  publish({ items: snapshot.items.map((n) => ({ ...n, read: true })), unread: 0 })
}

/** Optimistic per-item read — clicking a notification should clear its dot
 * immediately, not on the next poll. */
export function markNotificationRead(id: string): void {
  const target = snapshot.items.find((n) => n.id === id)
  if (target && target.read) return
  publish({
    items: snapshot.items.map((n) => (n.id === id ? { ...n, read: true } : n)),
    unread: Math.max(0, snapshot.unread - 1),
  })
  api(`/api/notifications/${id}/read`, { method: "POST", json: {} }).catch(() => {
    /* the next refresh reconciles */
  })
}

export function useNotifications(): Snapshot {
  const [local, setLocal] = useState<Snapshot>(snapshot)

  useEffect(() => {
    subscribers.add(setLocal)
    refreshUnreadCount()
    // The interval belongs to the first subscriber, not to each of them.
    if (!timer) timer = setInterval(refreshUnreadCount, POLL_MS)
    return () => {
      subscribers.delete(setLocal)
      if (subscribers.size === 0 && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }, [])

  return local
}
