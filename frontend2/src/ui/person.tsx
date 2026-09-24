import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"

/** Enough of a person to draw their face and name, as the server's
 *  `social.person_brief` sends it. */
export type PersonBrief = {
  id: string
  name: string
  initials: string
  photo_url: string | null
  department?: string | null
  designation?: string | null
}

/** Two letters for an avatar, the way the server works them out
 *  (`social.initials`): titles dropped, first and last real word. Needed on
 *  this side for a post shown before the server has answered. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name || "")
    .replace(/\b(Dr|Mr|Ms|Mrs|Miss|Prof|Er)\b\.?/gi, " ")
    .split(/[\s.,]+/)
    .filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0][0].toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

const SIZE = {
  xs: "size-6 text-xs",
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-16 text-lg",
  xl: "size-24 text-2xl",
} as const

/**
 * A person's photo, or their initials where they have not set one.
 *
 * Without it every row in the feed is a name in grey text, and a reader
 * scanning for the colleague they know cannot find them by the one thing
 * people actually recognise at a glance. The initials sit on the accent
 * wash rather than a colour per person: a colour that means nothing is still
 * read as meaning something.
 */
export function Avatar({
  person,
  size = "md",
  className,
}: {
  person: Pick<PersonBrief, "name" | "initials" | "photo_url"> | null | undefined
  size?: keyof typeof SIZE
  className?: string
}) {
  const base = cn(
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full",
    SIZE[size],
    className
  )
  if (person?.photo_url) {
    return (
      <img
        src={person.photo_url}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn(base, "bg-sunken object-cover")}
      />
    )
  }
  return (
    <span aria-hidden className={cn(base, "bg-accent-wash font-semibold text-accent")}>
      {person?.initials || "?"}
    </span>
  )
}

/**
 * A colleague's name that opens their profile.
 *
 * Every name in the app that is a person should be one of these: a name you
 * cannot click is a dead end in a place whose whole point is finding the
 * people behind the work.
 */
export function PersonLink({
  id,
  name,
  className,
}: {
  id: string | null | undefined
  name: string | null | undefined
  className?: string
}) {
  if (!id) return <span className={className}>{name || "A colleague"}</span>
  return (
    <Link
      to={`/u/${id}`}
      className={cn("font-medium text-fg underline-offset-4 hover:underline", className)}
    >
      {name || "A colleague"}
    </Link>
  )
}
