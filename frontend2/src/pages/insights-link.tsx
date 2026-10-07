import { Link } from "react-router-dom"
import { MessageCircleQuestionMark } from "lucide-react"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"

/**
 * The way into Ask the data from a page that answers its own questions first:
 * the Principal's Home, the research office's, a head's department page. One
 * quiet line and a button, after the page's own work. Without it the page is
 * a sidebar door somebody opens once and forgets, and the question the home
 * did not answer goes to an export and a pivot table instead.
 *
 * Kept apart from `insights.tsx` so a home does not load the page to link to it.
 */
export function AskTheData({ about, className }: { about: string; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 text-base text-fg-muted print:hidden", className)}>
      <span>{about}</span>
      <Button kind="default" size="sm" asChild>
        <Link to="/insights">
          <MessageCircleQuestionMark />
          Ask the data
        </Link>
      </Button>
    </p>
  )
}
