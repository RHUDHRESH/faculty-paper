import { useId, useState } from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, ArrowRight, BadgeCheck, ExternalLink, LoaderCircle, Search } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { Callout } from "@/ui/state"
import { Meta } from "@/ui/text"

import { listOf, sentenceCase, SourceTag, Tag } from "./bits"
import { readableDate } from "./identifiers"
import type { PaperLookup } from "./lookup"

/**
 * The first thing on the form: one box that takes whatever the claimant has.
 *
 * A DOI, a doi.org link, the publisher's link, a Scopus link or the title --
 * the server works out which (`core/services/paper_lookup.py`). It used to be
 * a DOI box, a title box and two buttons that meant different things, and
 * the one called "Pull it up from Scopus" failed on every production request
 * because the server has no Scopus key.
 */
export function PasteBox({
  value,
  onChange,
  onFind,
  busy,
}: {
  value: string
  onChange: (value: string) => void
  onFind: () => void
  busy: boolean
}) {
  const id = useId()
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        onFind()
      }}
    >
      <label htmlFor={id} className="block text-base font-medium">
        Paste the DOI or link
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          size="lg"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="10.1016/j.… or https://doi.org/…"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          className="min-w-0 flex-1"
        />
        <Button kind="primary" size="lg" type="submit" disabled={busy || !value.trim()}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Search />}
          {busy ? "Looking…" : "Find it"}
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-sm text-fg-muted">
        The DOI is printed on the first page of the paper. A publisher's link or the full title
        works too.
      </p>
    </form>
  )
}

/** Where each thing on the "still to check" list is answered. */
export const CHECK_TARGET: Record<string, { step: number; field: string }> = {
  position: { step: 2, field: "position" },
  affiliation: { step: 2, field: "affiliation" },
  date: { step: 0, field: "date" },
  type: { step: 0, field: "type" },
  metrics: { step: 1, field: "standing" },
  snip: { step: 1, field: "standing" },
  quartile: { step: 1, field: "standing" },
}

/** A skeleton of the card's own height, so the page does not jump when the
 *  answer lands. */
export function FoundCardSkeleton() {
  return (
    <div className="space-y-3 rounded-lg bg-surface p-4 ring-1 ring-inset ring-line" aria-hidden>
      <div className="skeleton h-4 w-24 rounded-sm" />
      <div className="skeleton h-5 w-4/5 rounded-sm" />
      <div className="skeleton h-4 w-3/5 rounded-sm" />
      <div className="skeleton h-4 w-2/5 rounded-sm" />
    </div>
  )
}

function Row({ label, source, children }: { label: string; source?: string | null; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 py-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="min-w-0 break-words">{children}</span>
        <SourceTag source={source} />
      </dd>
    </div>
  )
}

/**
 * What the lookup found, read back with where each part came from, and what
 * is still the claimant's to check.
 *
 * The sources are named because they are different promises: OpenAlex and
 * Crossref carry what the publisher declared; "our journal data" is the
 * college's own SCImago and SNIP tables; only Scopus speaks for indexing.
 */
export function FoundCard({
  res,
  filled,
  collegeName,
  onJump,
}: {
  res: PaperLookup
  filled: string[]
  collegeName: string
  onJump: (key: string) => void
}) {
  const headingId = useId()
  const paper = res.paper
  if (!paper) return null
  const src = res.field_sources
  const metrics = res.metrics
  const claimant = res.claimant
  // Mid-sentence, "our journal data" is a phrase, not a name.
  const answered = res.sources
    .filter((s) => s.ok && (s.count ?? 0) > 0)
    .map((s) => (s.id === "journals" ? s.label.toLowerCase() : s.label))
  const failed = res.sources.filter((s) => !s.ok && s.detail)

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-lg bg-surface p-4 ring-1 ring-inset ring-positive/40"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="flex items-center gap-1.5 text-base font-semibold text-positive">
          <BadgeCheck className="size-4" aria-hidden />
          Found it
        </h3>
        {answered.length > 0 && <Meta>From {listOf(answered)}</Meta>}
      </div>

      {res.warnings.map((w) => (
        <Callout key={w} tone="critical" title="Check this before going on">
          {w}
        </Callout>
      ))}

      {res.already_filed && (
        <Callout tone="caution" title="You have already filed this paper">
          {res.already_filed.is_draft ? "It is one of your drafts" : `It is ticket ${res.already_filed.ticket_number || "on your list"}`}
          .{" "}
          <Link
            to={res.already_filed.is_draft ? `/papers/${res.already_filed.id}/edit` : `/papers/${res.already_filed.id}`}
            className="font-medium text-accent underline underline-offset-2"
          >
            Open it
          </Link>{" "}
          instead of filing it twice — one claim per article.
        </Callout>
      )}

      <dl className="divide-y divide-line">
        <Row label="Title" source={src.title}>
          <span className="font-medium">{paper.title}</span>
        </Row>
        <Row label="Journal" source={src.journal}>
          {paper.journal || "Not given"}
          {paper.issn && <span className="text-fg-muted"> · ISSN {paper.issn}</span>}
        </Row>
        <Row label="Published" source={src.publication_date}>
          {paper.publication_date ? readableDate(paper.publication_date) : "Not given"}
          {paper.document_type && <span className="text-fg-muted"> · {paper.document_type}</span>}
        </Row>
        <Row label="Authors" source={src.authors}>
          {paper.total_authors ?? paper.authors.length} author{(paper.total_authors ?? 0) === 1 ? "" : "s"}
          {claimant?.position ? (
            <span className="text-fg-muted">
              {" "}
              · you are author {claimant.position}
              {claimant.name_on_paper ? ` (${claimant.name_on_paper})` : ""}
            </span>
          ) : null}
        </Row>
        {res.affiliation && res.affiliation.status !== "unknown" && (
          <Row label="Affiliation" source={src.authors}>
            {res.affiliation.status === "yes"
              ? `${collegeName} is printed on the paper`
              : res.affiliation.status === "other"
                ? `Names “${res.affiliation.text}”, not ${collegeName}`
                : `${collegeName} is not printed on the paper`}
          </Row>
        )}
        {metrics?.found ? (
          <>
            <Row label="Quartile" source={src.quartile}>
              {metrics.quartile || "No quartile"}
              {metrics.category && <span className="text-fg-muted"> · {metrics.category}</span>}
            </Row>
            <Row label="SNIP" source={src.snip}>
              {metrics.snip != null ? metrics.snip : "Not held"}
              {metrics.snip_year && <span className="text-fg-muted"> · {metrics.snip_year}</span>}
            </Row>
            {metrics.engineering_class && (
              <Row label="Subject area" source={src.engineering_class}>
                {metrics.engineering_class === "Engineering"
                  ? "Engineering — the quartile incentive applies"
                  : "Not Engineering — no quartile incentive"}
              </Row>
            )}
          </>
        ) : (
          <Row label="Quartile and SNIP">Not in our journal tables</Row>
        )}
        {(paper.citations > 0 || paper.open_access_url) && (
          <Row label="More">
            {paper.citations > 0 && `Cited ${paper.citations} time${paper.citations === 1 ? "" : "s"}`}
            {paper.citations > 0 && paper.open_access_url && " · "}
            {paper.open_access_url && (
              <a
                href={paper.open_access_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-accent underline-offset-2 hover:underline"
              >
                Free copy of the paper
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </Row>
        )}
      </dl>

      <p className="text-sm text-fg-muted">
        {filled.length
          ? `${sentenceCase(listOf(filled))} ${filled.length === 1 ? "is" : "are"} filled in below. Everything stays editable.`
          : "Nothing needed changing — this matches what you had already entered."}
      </p>

      {res.to_check.length > 0 ? (
        <div className="rounded-md bg-caution-wash p-3">
          <p className="text-sm font-medium">Still yours to check</p>
          <ul className="mt-1.5 space-y-1.5">
            {res.to_check.map((c) => (
              <li key={c.key + c.text} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
                <span className="min-w-0">{c.text}</span>
                {CHECK_TARGET[c.key] && (
                  <button
                    type="button"
                    onClick={() => onJump(c.key)}
                    className="inline-flex shrink-0 items-center gap-0.5 font-medium text-accent underline-offset-2 hover:underline"
                  >
                    Go to it
                    <ArrowRight className="size-3" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm">
          Nothing else to check from the record. You will still confirm the affiliation and attach
          the files.
        </p>
      )}

      {failed.length > 0 && (
        <p className="text-xs text-fg-subtle">{failed.map((s) => s.detail).join(" ")}</p>
      )}
    </section>
  )
}

/** A lookup that did not land on one paper: why, and what to do instead. */
export function LookupProblem({
  res,
  onPick,
  error,
}: {
  res: PaperLookup | null
  onPick: (doi: string) => void
  error: string | null
}) {
  if (error) {
    return (
      <Callout tone="caution" title="Could not look that up">
        {error}
      </Callout>
    )
  }
  if (!res || res.ok) return null
  if (res.code === "choose" && res.candidates.length) {
    return (
      <div className="space-y-2">
        <p className="text-base font-medium">{res.message}</p>
        <ul className="divide-y divide-line overflow-hidden rounded-md bg-surface ring-1 ring-inset ring-line">
          {res.candidates.map((c, i) => (
            <li key={c.doi || i}>
              <button
                type="button"
                disabled={!c.doi}
                onClick={() => c.doi && onPick(c.doi)}
                className="block w-full px-3 py-2.5 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="block text-base font-medium">{c.title || "Untitled record"}</span>
                <Meta className="mt-0.5 block">
                  {[c.journal, c.year ? String(c.year) : null, c.author_count ? `${c.author_count} authors` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </Meta>
                {c.authors.length > 0 && <Meta className="block">{c.authors.join(", ")}</Meta>}
                {c.doi && <Meta className="block break-all">{c.doi}</Meta>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <Callout tone="caution" title="Not found automatically">
      {res.message} You can carry on and fill the details in below.
    </Callout>
  )
}

type ProfileCandidate = {
  title: string | null
  doi: string | null
  journal_title: string | null
  publication_year: number | null
  author_count: number | null
  linked_to_author: boolean | null
  already_claimed: boolean
}

/**
 * The papers on the claimant's own Scopus profile, newest first -- the list
 * they recognise their paper from without looking anything up. Offered only
 * where Scopus is connected (`/api/lookup/sources`): without a key every
 * attempt fails, and a button that always fails is a button that teaches
 * people the form is broken.
 */
export function ScopusProfilePicker({
  scopusAuthorUrl,
  ownerId,
  onPick,
}: {
  scopusAuthorUrl: string
  ownerId?: string | null
  onPick: (doiOrTitle: string) => void
}) {
  const { data: available } = useApi<{ scopus: boolean }>(["lookup", "sources"], "/api/lookup/sources", {
    staleTime: Infinity,
  })
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState<ProfileCandidate[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  if (!available?.scopus) return null

  async function load() {
    setOpen(true)
    setBusy(true)
    setMessage(null)
    try {
      const res = await api<{ ok: boolean; message: string | null; candidates: ProfileCandidate[] }>(
        "/api/lookup/candidates",
        {
          method: "POST",
          json: { scopus_author_url: scopusAuthorUrl.trim() || undefined, owner_id: ownerId || undefined, limit: 15 },
        }
      )
      setRows(res.candidates)
      if (!res.candidates.length) setMessage(res.message || "No papers were found on that profile.")
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Scopus did not answer. Paste the DOI instead.")
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button kind="quiet" size="md" onClick={() => void load()}>
        Or pick it from your Scopus profile
      </Button>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-base font-medium">Papers on your Scopus profile</p>
      {busy && (
        <p className="flex items-center gap-1.5 text-sm text-fg-muted">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          Asking Scopus…
        </p>
      )}
      {message && <p className="text-sm text-caution">{message}</p>}
      {rows && rows.length > 0 && (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-md bg-surface ring-1 ring-inset ring-line">
          {rows.map((c, i) => (
            <li key={c.doi || i}>
              <button
                type="button"
                disabled={c.already_claimed}
                onClick={() => onPick(c.doi || c.title || "")}
                className={cn(
                  "block w-full px-3 py-2.5 text-left hover:bg-hover",
                  "disabled:cursor-not-allowed disabled:opacity-60"
                )}
              >
                <span className="block text-sm font-medium">{c.title || "Untitled record"}</span>
                <Meta className="block">
                  {[c.journal_title, c.publication_year ? String(c.publication_year) : null].filter(Boolean).join(" · ")}
                </Meta>
                {c.already_claimed && (
                  <Tag tone="critical" icon={AlertTriangle} className="mt-1">
                    You have already filed for this one
                  </Tag>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
