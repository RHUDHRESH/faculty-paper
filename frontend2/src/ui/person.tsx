import { useState } from "react"
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
    // Bracketed notes ("(sample)", "(retd)") are not part of the name.
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(Dr|Mr|Ms|Mrs|Miss|Prof|Er)\b\.?/gi, " ")
    .split(/[\s.,]+/)
    .filter((w) => /^\p{L}/u.test(w))
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0][0].toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/** Five sizes, and no others: 24, 32, 40, 64, 96 px. Initials are never below
 *  12px, so a fallback at 24px is still readable (DESIGN.md, "Avatar"). */
const SIZE = {
  xs: "size-6 text-xs tracking-tight",
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
    // A 1px inner ring keeps a pale photograph from dissolving into the paper.
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full",
    "ring-1 ring-inset ring-fg/10",
    SIZE[size],
    className
  )
  // A photo that fails to load (moved file, offline media) falls back to
  // initials rather than the browser's broken-image icon.
  const [failed, setFailed] = useState<string | null>(null)
  const photo = person?.photo_url && failed !== person.photo_url ? person.photo_url : null
  if (photo) {
    return (
      <img
        src={photo}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(photo)}
        className={cn(base, "bg-sunken object-cover")}
      />
    )
  }
  return (
    <span aria-hidden className={cn(base, "bg-navy-wash font-semibold text-navy")}>
      {person?.initials || initialsOf(person?.name)}
    </span>
  )
}

/**
 * A few faces in a row, overlapping, with "+n" for the rest: the co-authors of
 * a paper, the people at a desk, who has read a post. Four faces at most; the
 * count of the others is a real number (never "99+").
 *
 * The group has one accessible name (`label`) and each face is decorative, so
 * a screen reader hears "Co-authors: A, B, C and 3 more" once, not four
 * unlabelled pictures.
 */
export function FaceStack({
  people,
  max = 4,
  size = "sm",
  label,
  className,
}: {
  people: Pick<PersonBrief, "name" | "initials" | "photo_url">[]
  max?: number
  size?: "xs" | "sm" | "md"
  label?: string
  className?: string
}) {
  const shown = people.slice(0, max)
  const rest = people.length - shown.length
  const names = people.map((p) => p.name).join(", ")
  return (
    <span
      role="group"
      aria-label={label ? `${label}: ${names}` : names}
      className={cn("inline-flex items-center", className)}
    >
      {shown.map((p, i) => (
        <Avatar
          key={`${i}-${p.name}`}
          person={p}
          size={size}
          // Each face is cut from the one before it by a ring of the ground.
          className={cn("ring-2 ring-bg", i > 0 && (size === "md" ? "-ml-3" : "-ml-2"))}
        />
      ))}
      {rest > 0 && (
        <span
          className={cn(
            "ml-1.5 text-xs font-medium text-fg-muted tabular",
            size === "md" && "text-sm"
          )}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}

/**
 * A person as a portrait: 4:5, a 12px radius. For a profile, a person's card,
 * "who to work with". The face fills it; the fallback is the initials, large,
 * on the navy wash. (The round Avatar is for lists and rows.)
 */
export function Portrait({
  person,
  className,
}: {
  person: Pick<PersonBrief, "name" | "initials" | "photo_url"> | null | undefined
  className?: string
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const photo = person?.photo_url && failed !== person.photo_url ? person.photo_url : null
  const base = "relative block aspect-[4/5] w-full overflow-hidden rounded-lg ring-1 ring-inset ring-fg/10"
  if (photo) {
    return (
      <img
        src={photo}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(photo)}
        className={cn(base, "bg-sunken object-cover", className)}
      />
    )
  }
  return (
    <span
      aria-hidden
      className={cn(base, "grid place-items-center bg-navy-wash font-display text-5xl text-navy", className)}
    >
      {person?.initials || initialsOf(person?.name)}
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
