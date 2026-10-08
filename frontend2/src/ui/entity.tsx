import { FilePlusCorner, FileText, Gem, MessageCircle, Quote, UserRound } from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { unshout } from "@/lib/names"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Meta } from "@/ui/text"
import { StageTrack, type StageInfo } from "@/ui/paper"
import { JournalCover } from "@/ui/journal-cover"
import { Avatar, type PersonBrief } from "@/ui/person"
import { Picture } from "@/ui/picture"
import { DetailLink } from "@/ui/detail-sheet"

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
  /** A generated topic picture (public/illustrations/generated) shown in place of the journal cover. */
  picture?: string | null
  /** Right-hand actions (a menu). */
  actions?: React.ReactNode
  /** The record's id: the title then opens the paper panel, and the journal
   *  the journal panel, instead of going anywhere (`ui/detail-sheet`). */
  detailId?: string | null
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
  picture,
  detailId,
}: PaperCardProps) {
  const youAt = authors ? authors.findIndex((a) => a.you) : -1
  const pos = position ?? (authors && youAt >= 0 ? { index: youAt + 1, of: authors.length } : null)
  const meta = detailId ? (
    <>
      {journal && (
        <DetailLink kind="journal" name={journal}>
          {unshout(journal)}
        </DetailLink>
      )}
      {journal && year ? " · " : ""}
      {year}
    </>
  ) : (
    [journal ? unshout(journal) : journal, year].filter(Boolean).join(" · ")
  )
  const shown = unshout(title)
  const heading = detailId ? (
    <DetailLink kind="paper" id={detailId}>
      {shown}
    </DetailLink>
  ) : to ? (
    <Link to={to} className="hover:underline hover:underline-offset-4">
      {shown}
    </Link>
  ) : (
    shown
  )
  return (
    <article
      data-area="record"
      className={cn(dense ? "row flex items-start gap-3 px-4 py-2.5" : "panel flex gap-4 p-4", className)}
    >
      {!dense &&
        (picture ? (
          <Picture name={picture} className="size-14 shrink-0 rounded-xl bg-hover p-1" />
        ) : journal ? (
          <JournalCover title={journal} quartile={quartile} size="sm" className="mt-0.5" />
        ) : (
          <FileText aria-hidden className="mt-0.5 size-5 shrink-0 text-(--area)" strokeWidth={1.75} />
        ))}
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
        <div className="flex shrink-0 flex-col items-end gap-1 self-center">
          <Link
            to={claim.fileTo}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-accent shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-accent-wash"
          >
            <FilePlusCorner aria-hidden className="size-4" strokeWidth={1.75} />
            File
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
    "inline-flex h-8 items-center gap-1.5 rounded-control bg-surface px-3 text-sm font-medium text-fg shadow-raise ring-1 ring-inset ring-control-edge transition-[background-color,box-shadow] hover:bg-hover hover:ring-field active:bg-active active:shadow-press max-sm:h-10"
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
  detail,
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
  /** The name opens the journal panel (`ui/detail-sheet`) instead of `to`. */
  detail?: boolean
}) {
  return (
    <article data-area="research" className={cn("panel flex gap-4 p-4", className)}>
      <JournalCover title={name} publisher={publisher} quartile={quartile} size="md" />
      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-2 font-medium text-fg">
          {detail ? (
            <DetailLink kind="journal" name={name} />
          ) : to ? (
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

/* ------------------------------------------------------------------------ */
/* PersonRow, JournalRow: the hairline-list versions of the cards above       */
/* ------------------------------------------------------------------------ */

/** A person as one row of a hairline list. Same props as `PersonCard`. */
export function PersonRow({
  person,
  to,
  context,
  onMessage,
  messageTo,
  path,
  className,
}: {
  person: Pick<PersonBrief, "name" | "initials" | "photo_url"> & Partial<PersonBrief>
  to?: string
  affiliation?: string | null
  context?: React.ReactNode
  onMessage?: () => void
  messageTo?: string
  path?: React.ReactNode
  className?: string
}) {
  const sub = [person.department, person.designation].filter(Boolean).join(" · ")
  return (
    <article data-area="people" className={cn("flex items-center gap-3 py-3", className)}>
      <Avatar person={person} size="md" />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-medium text-fg">
          {to ? (
            <Link to={to} className="underline-offset-4 hover:underline">
              {person.name}
            </Link>
          ) : (
            person.name
          )}
        </h3>
        {sub && <Meta className="block truncate">{sub}</Meta>}
        {context && <Meta className="line-clamp-2 block">{context}</Meta>}
        {path}
      </div>
      {messageTo ? (
        <Button kind="quiet" size="sm" asChild className="shrink-0">
          <Link to={messageTo}>Message</Link>
        </Button>
      ) : onMessage ? (
        <Button kind="quiet" size="sm" className="shrink-0" onClick={onMessage}>
          Message
        </Button>
      ) : null}
    </article>
  )
}

/** A journal as one row of a hairline list. Same props as `JournalCard`. */
export function JournalRow({
  name,
  to,
  quartile,
  colleagues,
  subjects,
  className,
  detail,
}: {
  name: string
  to?: string
  publisher?: string | null
  quartile?: string | null
  snip?: number | null
  colleagues?: number | null
  subjects?: string[]
  className?: string
  detail?: boolean
}) {
  const line = [
    ...(subjects ?? []).slice(0, 3),
    colleagues != null && colleagues > 0 ? `${colleagues} ${colleagues === 1 ? "colleague" : "colleagues"} published here` : null,
  ].filter(Boolean)
  return (
    <article data-area="research" className={cn("flex items-center gap-3 py-3", className)}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-base font-medium text-fg">
            {detail ? (
              <DetailLink kind="journal" name={name} className="underline-offset-4" />
            ) : to ? (
              <Link to={to} className="underline-offset-4 hover:underline">
                {name}
              </Link>
            ) : (
              name
            )}
          </h3>
          {quartile && (
            <Chip tone={quartile === "Q1" ? "gold" : "neutral"} icon={quartile === "Q1" ? Gem : undefined} className="shrink-0">
              {quartile}
            </Chip>
          )}
        </div>
        {line.length > 0 && <Meta className="block truncate">{line.join(" · ")}</Meta>}
      </div>
    </article>
  )
}
