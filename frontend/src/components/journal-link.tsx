"use client"

import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

/**
 * A journal name, as a door rather than a label.
 *
 * "Ceramics International" was printed as dead text on every screen that
 * mentioned it, so the questions the college actually asks about a journal --
 * how often do we publish there, who does, what is it ranked, has that moved
 * -- each meant a fresh search. The name is the obvious place to ask them
 * from, and it was the one thing on the row you could not click.
 *
 * A missing journal stays dead text: an em dash that navigates is worse than
 * one that does not.
 */
export function JournalLink({
  title,
  portal,
  className,
}: {
  title?: string | null
  /** "/admin", "/principal" — the record opens inside the reader's own portal
   *  so the sidebar and the back button keep working. */
  portal: string
  className?: string
}) {
  const name = (title || "").trim()
  if (!name) return <span className="text-muted-foreground">—</span>
  return (
    <Link
      to={`${portal}/journal?title=${encodeURIComponent(name)}`}
      title={name}
      className={cn(
        "interactive block truncate text-primary underline-offset-4 hover:underline",
        className
      )}
    >
      {name}
    </Link>
  )
}
