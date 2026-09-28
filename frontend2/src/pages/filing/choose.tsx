import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight, ClipboardPaste, CloudDownload, RefreshCw, Search } from "lucide-react"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { ChoiceGroup, ChoiceTile } from "@/ui/choice"
import { Input } from "@/ui/field"
import { Illustration } from "@/ui/share-plate"
import { Callout, SkeletonText } from "@/ui/state"

/** One paper from `GET /api/me/scopus-pull` (frontend2/API.md). */
export type PulledPaper = {
  publication_id: string
  title: string
  venue: string | null
  issn: string | null
  year: number | null
  date: string | null
  type: string | null
  doi: string | null
  eid: string | null
  citations: number | null
  author_position: number | null
  total_authors: number | null
  authors: string[]
  already_claimed: boolean
  claim_id: string | null
  claim_status: string | null
}

export type ScopusPull = { count: number; unclaimed: number; papers: PulledPaper[] }

export type Method = "pull" | "paste"

/**
 * Step 1 of filing (docs/ux/04): how the paper is chosen. Pulling one of
 * *my* papers from the record comes first and is the default; pasting a DOI
 * is the alternative, for a paper the record has not caught yet.
 */
export function ChooseMethod({
  method,
  onMethod,
  pull,
  pullLoading,
  pullError,
  onRetryPull,
  selectedId,
  onSelect,
  paste,
}: {
  method: Method
  onMethod: (m: Method) => void
  pull: ScopusPull | undefined
  pullLoading: boolean
  pullError: boolean
  onRetryPull: () => void
  selectedId: string | null
  onSelect: (p: PulledPaper) => void
  /** The paste box and what it found (the existing finder). */
  paste: React.ReactNode
}) {
  const unclaimed = pull?.unclaimed ?? 0
  return (
    <div className="space-y-6" data-area="record">
      <ChoiceGroup label="How to choose the paper" className="lg:grid-cols-2">
        <ChoiceTile
          icon={CloudDownload}
          area="record"
          checked={method === "pull"}
          onSelect={() => onMethod("pull")}
          recommended
          className="min-h-[200px] max-sm:min-h-[140px]"
          title={
            <span className="flex flex-col">
              Pull from my Scopus record
            </span>
          }
          description={
            <span className="flex items-end justify-between gap-4">
              <span>
                {pullLoading
                  ? "Reading your record…"
                  : unclaimed > 0
                    ? `Pick one of your ${unclaimed} unclaimed paper${unclaimed === 1 ? "" : "s"}. Journal, authors and quartile fill themselves.`
                    : "No unclaimed papers on your record. Check Scopus for new ones, or paste a DOI."}
              </span>
              <Illustration name="scopus-pull" className="w-[120px] shrink-0 p-2 max-sm:hidden" />
            </span>
          }
        />
        <ChoiceTile
          icon={ClipboardPaste}
          area="record"
          checked={method === "paste"}
          onSelect={() => onMethod("paste")}
          className="min-h-[200px] max-sm:min-h-[140px]"
          title="Paste a DOI or link"
          description="For a paper that isn't on your record yet."
        />
      </ChoiceGroup>

      {method === "pull" ? (
        <Picker
          pull={pull}
          loading={pullLoading}
          error={pullError}
          onRetry={onRetryPull}
          selectedId={selectedId}
          onSelect={onSelect}
          onPaste={() => onMethod("paste")}
        />
      ) : (
        <div className="space-y-4">{paste}</div>
      )}
    </div>
  )
}

function Picker({
  pull,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  onPaste,
}: {
  pull: ScopusPull | undefined
  loading: boolean
  error: boolean
  onRetry: () => void
  selectedId: string | null
  onSelect: (p: PulledPaper) => void
  onPaste: () => void
}) {
  const [q, setQ] = useState("")
  const papers = pull?.papers ?? []
  const match = (p: PulledPaper) => {
    const needle = q.trim().toLowerCase()
    return !needle || `${p.title} ${p.venue ?? ""} ${p.doi ?? ""} ${p.year ?? ""}`.toLowerCase().includes(needle)
  }
  const open = useMemo(() => papers.filter((p) => !p.already_claimed), [papers])
  const claimed = useMemo(() => papers.filter((p) => p.already_claimed), [papers])

  if (loading) return <SkeletonText lines={5} />

  return (
    <section className="space-y-3" aria-labelledby="pick-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="pick-heading" className="text-lg font-semibold">
          Your papers
        </h2>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-72">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              aria-label="Filter your papers"
              placeholder="Filter your papers…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button kind="default" size="sm" type="button" onClick={onRetry}>
            <RefreshCw aria-hidden />
            Check Scopus for new papers
          </Button>
        </div>
      </div>

      {error && (
        <Callout tone="caution" title="Couldn't reach Scopus just now">
          Your record from the last check is shown.{" "}
          <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
            Try again
          </button>
        </Callout>
      )}

      {!error && papers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl p-6 text-center shadow-[inset_0_0_0_1px_var(--color-line)]">
          <Illustration name="empty-papers" />
          <p className="text-base font-medium">Nothing to pick yet — your record hasn't been matched to Scopus.</p>
          <Button kind="primary" type="button" onClick={onPaste}>
            <ClipboardPaste aria-hidden />
            Paste a DOI instead
          </Button>
        </div>
      ) : (
        <>
          <ul role="radiogroup" aria-label="Pick the paper to file" className="panel divide-y divide-line overflow-hidden">
            {open.filter(match).map((p) => {
              const on = p.publication_id === selectedId
              return (
                <li key={p.publication_id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onSelect(p)}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-[var(--dur-1)] hover:bg-hover focus-visible:outline-(--area-line)",
                      on && "bg-(--area-wash)"
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1 grid size-5 shrink-0 place-items-center rounded-full ring-2 ring-inset",
                        on ? "ring-(--area)" : "ring-field"
                      )}
                    >
                      {on && <span className="size-2.5 rounded-full bg-(--area)" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-base font-medium text-fg">{p.title}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
                        {[p.venue, p.year].filter(Boolean).join(" · ")}
                        {p.author_position && p.total_authors && (
                          <span>
                            · author {p.author_position} of {p.total_authors}
                          </span>
                        )}
                        {p.eid && <Chip tone="positive">Scopus ✓</Chip>}
                        {p.doi ? <Chip>DOI</Chip> : <Chip tone="caution">No DOI</Chip>}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
            {open.filter(match).length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-fg-muted">
                {open.length === 0
                  ? "Every paper on your record already has a claim."
                  : "No paper matches that filter."}
              </li>
            )}
          </ul>

          {claimed.length > 0 && (
            <details className="panel p-3">
              <summary className="cursor-pointer text-sm font-medium text-fg-muted">
                Already claimed ({claimed.length})
              </summary>
              <ul className="mt-2 divide-y divide-line">
                {claimed.filter(match).map((p) => (
                  <li key={p.publication_id} className="flex items-start gap-3 py-2 opacity-70">
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-1 text-sm">{p.title}</span>
                      <span className="text-xs text-fg-muted">{[p.venue, p.year].filter(Boolean).join(" · ")}</span>
                    </span>
                    {p.claim_id && (
                      <Link to={`/papers/${p.claim_id}`} className="shrink-0 text-sm font-medium text-accent hover:underline">
                        View claim
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  )
}

/** Continue under Step 1; sticky on a phone. */
export function ChooseFooter({
  disabled,
  onContinue,
  note,
}: {
  disabled: boolean
  onContinue: () => void
  note?: React.ReactNode
}) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
      {note && <span className="mr-auto text-sm text-fg-muted">{note}</span>}
      <Button kind="primary" size="lg" type="button" onClick={onContinue} disabled={disabled}>
        Continue
        <ArrowRight aria-hidden />
      </Button>
    </div>
  )
}
