import { messagesOf, useBadges } from "@/app/badges"

/**
 * How many conversations have a message you have not read, for the badge on
 * Messages in the sidebar (drawn by the shell's `NavBadge`, like the desk
 * counts). Its own small module so the shell does not pull the chat page into
 * the first download.
 *
 * Read from the shell's one badges request (`app/badges.ts`) rather than polled
 * on its own; an open conversation refreshes faster (`pages/chat.tsx`).
 */
export function useUnreadMessages() {
  return useBadges(messagesOf)
}
