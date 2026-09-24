import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"

/**
 * How many conversations have a message you have not read, for the badge on
 * Messages in the sidebar. Its own small module so the shell does not pull
 * the chat page into the first download.
 */

/** The sidebar badge; an open conversation refreshes faster (`pages/chat.tsx`). */
const POLL_MS = 30_000

export function useUnreadMessages() {
  return useApi<{ unread: number; conversations: number }>(["dm", "unread"], "/api/dm/unread", {
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  })
}

/** How many conversations have something new. Nothing at all when none do. */
export function UnreadBadge({ className }: { className?: string }) {
  const unread = useUnreadMessages()
  const n = unread.data?.conversations ?? 0
  if (!n) return null
  return (
    <span
      role="status"
      aria-label={`${n} conversation${n === 1 ? "" : "s"} with new messages`}
      className={cn(
        "grid min-w-[1.1rem] place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-accent-fg tabular",
        className
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  )
}
