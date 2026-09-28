import { useId } from "react"
import { BadgeCheck } from "lucide-react"

import { cn } from "@/lib/cn"

import { Tag } from "./bits"
import type { StoredAuthor } from "./lookup"

/**
 * Every author of the paper, in order, with the claimant marked -- and moved
 * with one press.
 *
 * Position is a term in the payout, and the lookup finds it by matching a
 * name, which is right most of the time and wrong for the "S. Anand" who
 * shares a paper with another S. Anand. A number in a box could be changed,
 * but not checked: nobody could see which name the number pointed at. A
 * radio group over the names makes the answer and the evidence the same
 * thing, and gives arrow-key selection for free.
 *
 * Each row also says whether the paper prints the college beside that name,
 * because "the college is on the paper, but not beside yours" is exactly the
 * affiliation the research cell sends back.
 */
export function AuthorList({
  authors,
  position,
  onPick,
  collegeName,
  className,
}: {
  authors: StoredAuthor[]
  position: number
  onPick: (position: number) => void
  collegeName: string
  className?: string
}) {
  const name = useId()
  return (
    <fieldset className={className}>
      <legend className="sr-only">Which author are you?</legend>
      <ol className="divide-y divide-line overflow-hidden rounded-md bg-surface ring-1 ring-inset ring-line">
        {authors.map((a) => {
          const me = a.position === position
          return (
            <li key={a.position}>
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors duration-[var(--dur-1)]",
                  me ? "bg-accent-wash" : "hover:bg-hover"
                )}
              >
                <span className="relative mt-0.5 inline-grid size-4 shrink-0 place-items-center">
                  <input
                    type="radio"
                    name={name}
                    checked={me}
                    onChange={() => onPick(a.position)}
                    className={cn(
                      "peer col-start-1 row-start-1 size-4 appearance-none rounded-full outline-none",
                      "bg-surface ring-1 ring-inset ring-field checked:ring-accent",
                      "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
                    )}
                  />
                  <span className="pointer-events-none col-start-1 row-start-1 hidden size-1.5 rounded-full bg-accent peer-checked:block" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-base", me && "font-medium")}>
                    <span className="tabular text-fg-muted">{a.position}.</span> {a.name || "Unnamed author"}
                  </span>
                  {a.college === "yes" ? (
                    <span className="mt-0.5 block text-xs text-positive">{collegeName}</span>
                  ) : a.college === "other" ? (
                    <span className="mt-0.5 block text-xs text-caution">
                      Not {collegeName} — an institution with a similar name
                    </span>
                  ) : a.college === "no" ? (
                    <span className="mt-0.5 block text-xs text-fg-subtle">another institution</span>
                  ) : null}
                </span>
                {me && (
                  <Tag tone="accent" icon={BadgeCheck} className="mt-0.5 shrink-0">
                    You
                  </Tag>
                )}
              </label>
            </li>
          )
        })}
      </ol>
    </fieldset>
  )
}
