import { useApi } from "@/lib/query"

/**
 * How many conversations have a message you have not read, for the badge on
 * Messages in the sidebar (drawn by the shell's `NavBadge`, like the desk
 * counts). Its own small module so the shell does not pull the chat page into
 * the first download.
 */

/** The sidebar badge; an open conversation refreshes faster (`pages/chat.tsx`). */
const POLL_MS = 30_000

export function useUnreadMessages() {
  return useApi<{ unread: number; conversations: number }>(["dm", "unread"], "/api/dm/unread", {
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  })
}
