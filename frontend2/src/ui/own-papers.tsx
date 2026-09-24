import { Link } from "react-router-dom"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"

/**
 * What an officer who is also an academic is told on their desk's queue.
 *
 * Nobody decides their own paper, at any desk (`rbac.is_own_claim` on the
 * server, which also leaves it out of the queue). So their own paper is simply
 * not in the list, and a queue that is quietly missing one of theirs reads as
 * the paper having been lost -- hence one sentence, always the same, saying
 * where it went and where to follow it. It never says whether one of theirs
 * is waiting at this desk right now: that would tell a claimant which desk
 * holds their paper, which no claimant is told.
 *
 * Nothing for the super admin, who files nothing of their own.
 */
export function OwnPapersNote({ className }: { className?: string }) {
  const { me } = useAuth()
  if (!can(me?.role).fileOwnPapers) return null
  return (
    <p className={cn("text-sm text-fg-muted", className)}>
      Your own papers are never in this queue — another officer or the super admin decides them.
      Follow yours under{" "}
      <Link to="/papers" className="text-accent underline-offset-4 hover:underline">
        My papers
      </Link>
      .
    </p>
  )
}
