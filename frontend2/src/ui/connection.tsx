import { Waypoints } from "lucide-react"
import { Fragment } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { Avatar, type PersonBrief } from "@/ui/person"

export type Hop = {
  person: Pick<PersonBrief, "name" | "initials" | "photo_url"> & { id?: string }
  /** Evidence for the link *into* this person: "3 papers", "same dept". */
  evidence?: string
}

/**
 * `You → X → Y` (docs/ux/00 §8): avatars joined by a line, each hop labelled
 * with its evidence. Pass up to 3 `paths`; they stack. The first hop of each
 * path is the reader.
 */
export function ConnectionPath({
  paths,
  className,
}: {
  paths: Hop[][]
  className?: string
}) {
  const shown = paths.slice(0, 3)
  return (
    <div data-area="people" className={cn("flex flex-col gap-3", className)}>
      {shown.map((path, p) => (
        <ol
          key={p}
          aria-label={path.map((h, i) => (i === 0 ? h.person.name : `${h.person.name}${h.evidence ? ` (${h.evidence})` : ""}`)).join(" → ")}
          className="flex flex-wrap items-center gap-1 gap-y-2 sm:flex-nowrap sm:overflow-x-auto"
        >
          <Waypoints aria-hidden className="mr-1 size-4 shrink-0 text-(--area)" strokeWidth={1.75} />
          {path.map((h, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <li aria-hidden className="flex min-w-10 flex-1 flex-col items-center">
                  <span className="text-[10px] leading-3 whitespace-nowrap text-fg-muted">{h.evidence}</span>
                  <span className="mt-0.5 h-px w-full bg-(--area-line)" />
                </li>
              )}
              <li className="flex shrink-0 flex-col items-center gap-0.5">
                {h.person.id ? (
                  <Link to={`/u/${h.person.id}`} title={h.person.name}>
                    <Avatar person={h.person} size="sm" />
                  </Link>
                ) : (
                  <Avatar person={h.person} size="sm" />
                )}
                <span className="max-w-16 truncate text-[11px] text-fg-muted">{i === 0 ? "You" : h.person.name.split(" ")[0]}</span>
              </li>
            </Fragment>
          ))}
        </ol>
      ))}
    </div>
  )
}
