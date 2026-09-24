import { BookOpen, FilePlusCorner, FileText, Gem, MessageCircle, Quote, UserRound } from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { Chip } from "@/ui/chip"
import { StageTrack, type StageInfo } from "@/ui/paper"
import { Avatar, type PersonBrief } from "@/ui/person"

/* ------------------------------------------------------------------------ */
/* PaperCard                                                                 */
/* ------------------------------------------------------------------------ */

export type PaperAuthor = { name: string; you?: boolean; /** A college member's profile. */ to?: string }

export type PaperCardProps = {
  title: string
  /** Where the title goes (paper detail). */
  to?: string
  journal?: string | null
  year?: number | string | null
  quartile?: string | null
  /** In order. The one with `you` is bolded. */
  authors?: PaperAuthor[]
  /** "2 of 6". Worked out from `authors` when omitted. */
  position?: { index: number; of: number } | null
  /** "Scopus", "OpenAlex", "ERP". */
  sources?: string[]
  /**
   * Claim state: a stage (mini StageTrack), or "unclaimed" with where
   * "File it" goes. Omit for someone else's paper.
   */
  claim?: { stage: StageInfo } | { unclaimed: true; fileTo: string }
  /** Dense row for lists (44px rows, hairline separators by the parent). */
  dense?: boolean
  className?: string
  /** Times cited, shown with a Quote icon when known. */
  citations?: number | null
  /** Replaces the default author line (e.g. a "With:" co-author line). */
  authorLine?: React.ReactNode
  /** Extra lines under the card body (claim state, notes). */
  children?: React.ReactNode
  /** Right-hand actions (a menu). */
  actions?: React.ReactNode
}

function authorLine(authors: PaperAuthor[], max = 6) {
  const shown = authors.slice(0, max)
  return (
    <>
      {shown.map((a, i) => (
        <span key={i}>
          {i > 0 && ", "}
          {a.you ? (
            <strong className="font-semibold text-fg">{a.name}</strong>
          ) : a.to ? (
            <Link to={a.to} className="text-fg hover:underline hover:underline-offset-4">
              {a.name}
            </Link>
          ) : (
            a.name
          )}
        </span>
      ))}
      {authors.length > max && `, +${authors.length - max}`}
    </>
  )
}

/** A paper, anywhere it is listed (docs/ux/00 §8). */
export function PaperCard({
  title,
  to,
  journal,
  year,
  quartile,
  authors,
  position,
  sources,
  claim,
  dense,
  className,
  citations,
  authorLine: customAuthors,
  children,
  actions,
}: PaperCardProps) {
  const youAt = authors ? authors.findIndex((a) => a.you) : -1
  const pos = position ?? (authors && youAt >= 0 ? { index: youAt + 1, of: authors.length } : null)
  const meta = [journal, year].filter(Boolean).join(" · ")
  const heading = to ? (
    <Link to={to} className="hover:underline hover:underline-offset-4">
      {title}
    </Link>
  ) : (
    title
  )
  return (
    <article
      data-area="record"
      className={cn(dense ? "row flex items-start gap-3 px-4 py-2.5" : "panel flex gap-4 p-4", className)}
    >
      {!dense && <FileText aria-hidden className="mt-0.5 size-5 shrink-0 text-(--area)" strokeWidth={1.75} />}
      <div className="min-w-0 flex-1">
        <h3 className={cn("line-clamp-2 font-medium text-fg", dense ? "text-sm" : "text-base")}>{heading}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
          {meta && <span className="min-w-0 truncate">{meta}</span>}
          {quartile && (
            <Chip tone={quartile === "Q1" ? "gold" : "neutral"} icon={quartile === "Q1" ? Gem : undefined}>
              {quartile}
            </Chip>
          )}
          {sources?.map((s) => (
            <Chip key={s}>{s}</Chip>
          ))}
          {citations != null && (
            <span className="inline-flex items-center gap-1 tabular-nums" title={`Cited ${citations} times`}>
              <Quote aria-hidden className="size-4" strokeWidth={1.75} />
              <span className="sr-only">Citations:</span>
              {citations}
            </span>
          )}
        </div>
        {customAuthors && !dense && <div className="mt-1 text-sm text-fg-muted">{customAuthors}</div>}
        {!customAuthors && authors && authors.length > 0 && !dense && (
          <p className="mt-1 line-clamp-1 text-sm text-fg-muted">
            {authorLine(authors)}
            {pos && <span className="text-fg-subtle"> · {pos.index} of {pos.of}</span>}
          </p>
        )}
        {claim && "stage" in claim && !dense && <StageTrack stage={claim.stage} className="mt-3 max-w-sm" />}
        {children}
      </div>
      {claim && "unclaimed" in claim && (
        <div className="flex shrink-0 flex-col items-end gap-1">
          {!dense && <span className="text-xs text-fg-subtle">Not claimed</span>}
          <Link
            to={claim.fileTo}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg shadow-raise hover:bg-accent-hover"
          >
            <FilePlusCorner aria-hidden className="size-4" strokeWidth={1.75} />
            File it
          </Link>
        </div>
      )}
      {claim && "stage" in claim && dense && (
        <span className="shrink-0 text-xs text-fg-muted">{claim.stage.label}</span>
      )}
      {actions && <div className="shrink-0">{actions}</div>}
    </article>
  )
}

/* ------------------------------------------------------------------------ */
/* PersonCard                                                                */
/* ------------------------------------------------------------------------ */

/** A person (docs/ux/00 §8). Pass `path` (a ConnectionPath) for the connection variant. */
export function PersonCard({
  person,
  to,
  affiliation = "Saveetha",
  context,
  onMessage,
  messageTo,
  path,
  className,
}: {
  person: Pick<PersonBrief, "name" | "initials" | "photo_url"> & Partial<PersonBrief>
  to?: string
  /** "Saveetha" for our own, or the external affiliation. */
  affiliation?: string | null
  /** "3 papers together · last 2025". */
  context?: React.ReactNode
  onMessage?: () => void
  messageTo?: string
  /** The connection variant: usually a <ConnectionPath>. */
  path?: React.ReactNode
  className?: string
}) {
  const sub = [person.department, person.designation].filter(Boolean).join(" · ")
  const btn =
    "inline-flex h-8 items-center gap-1.5 rounded-md bg-surface px-3 text-sm text-fg shadow-[inset_0_0_0_1px_var(--color-edge)] hover:bg-hover"
  return (
    <article data-area="people" className={cn("panel flex flex-col gap-3 p-4", className)}>
      <div className="flex items-start gap-3">
        <Avatar person={person} size="md" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium text-fg">
            {to ? (
              <Link to={to} className="hover:underline hover:underline-offset-4">
                {person.name}
              </Link>
            ) : (
              person.name
            )}
          </h3>
          {sub && <p className="truncate text-sm text-fg-muted">{sub}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {affiliation && <Chip tone={affiliation === "Saveetha" ? "area" : "neutral"}>{affiliation}</Chip>}
            {context && <span className="text-sm text-fg-muted">{context}</span>}
          </div>
        </div>
      </div>
      {path}
      {(onMessage || messageTo || to) && (
        <div className="flex flex-wrap gap-2">
          {messageTo ? (
            <Link to={messageTo} className={btn}>
              <MessageCircle aria-hidden className="size-4" strokeWidth={1.75} />
              Message
            </Link>
          ) : onMessage ? (
            <button type="button" onClick={onMessage} className={btn}>
              <MessageCircle aria-hidden className="size-4" strokeWidth={1.75} />
              Message
            </button>
          ) : null}
          {to && (
            <Link to={to} className={btn}>
              <UserRound aria-hidden className="size-4" strokeWidth={1.75} />
              View
            </Link>
          )}
        </div>
      )}
    </article>
  )
}

/* ------------------------------------------------------------------------ */
/* JournalCard                                                               */
/* ------------------------------------------------------------------------ */

/** A journal (docs/ux/00 §8). */
export function JournalCard({
  name,
  to,
  publisher,
  quartile,
  snip,
  colleagues,
  subjects,
  className,
}: {
  name: string
  to?: string
  publisher?: string | null
  quartile?: string | null
  snip?: number | null
  /** "N colleagues published here". */
  colleagues?: number | null
  subjects?: string[]
  className?: string
}) {
  return (
    <article data-area="research" className={cn("panel flex gap-4 p-4", className)}>
      <BookOpen aria-hidden className="mt-0.5 size-5 shrink-0 text-(--area)" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-2 font-medium text-fg">
          {to ? (
            <Link to={to} className="hover:underline hover:underline-offset-4">
              {name}
            </Link>
          ) : (
            name
          )}
        </h3>
        {publisher && <p className="truncate text-sm text-fg-muted">{publisher}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {quartile && (
            <Chip tone={quartile === "Q1" ? "gold" : "neutral"} icon={quartile === "Q1" ? Gem : undefined}>
              {quartile}
            </Chip>
          )}
          {snip != null && <Chip>SNIP {snip.toFixed(2)}</Chip>}
          {subjects?.slice(0, 3).map((s) => (
            <Chip key={s} tone="area">
              {s}
            </Chip>
          ))}
        </div>
        {colleagues != null && colleagues > 0 && (
          <p className="mt-2 text-sm text-fg-muted">
            {colleagues} {colleagues === 1 ? "colleague" : "colleagues"} published here
          </p>
        )}
      </div>
    </article>
  )
}
