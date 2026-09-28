import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight, ClipboardPaste, CloudDownload, RefreshCw, Search, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { Illustration } from "@/ui/illustration"
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
  /** Paid through the ledger (often before this app), with or without a claim. */
  on_paid_ledger?: boolean
  paid_month?: string | null
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
  onFile,
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
  /** Pick this paper and go straight on to the conditions. */
  onFile?: (p: PulledPaper) => void
  /** The paste box and what it found (the existing finder). */
  paste: React.ReactNode
}) {
  const count = pull?.count ?? 0
  const unclaimed = pull?.unclaimed ?? 0
  const pullHint = pullLoading
    ? "Reading your record…"
    : pullError
      ? "Couldn't read your record just now."
      : count === 0
        ? "Your record hasn't been matched to Scopus yet."
        : unclaimed > 0
          ? `${unclaimed} of ${count} papers on your record not yet filed.`
          : `All ${count} papers on your record are already filed.`
  return (
    <div className="space-y-5" data-area="record">
      <OptionGroup label="How to choose the paper">
        <OptionRow
          icon={CloudDownload}
          checked={method === "pull"}
          onSelect={() => onMethod("pull")}
          title="Pull from my Scopus record"
          hint={pullHint}
        />
        <OptionRow
          icon={ClipboardPaste}
          checked={method === "paste"}
          onSelect={() => onMethod("paste")}
          title="Paste a DOI or link"
          hint="For a paper that isn't on your record yet."
        />
      </OptionGroup>

      {method === "pull" ? (
        <Picker
          pull={pull}
          loading={pullLoading}
          error={pullError}
          onRetry={onRetryPull}
          selectedId={selectedId}
          onSelect={onSelect}
          onFile={onFile}
          onPaste={() => onMethod("paste")}
        />
      ) : (
        <div className="space-y-4">{paste}</div>
      )}
    </div>
  )
}

/** Two slim radio rows in one hairline frame (the claude.ai choice style). */
function OptionGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"]
    if (!keys.includes(e.key)) return
    const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(':scope > [role="radio"]'))
    const i = radios.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    const next = radios[(i + (keys.indexOf(e.key) < 2 ? 1 : -1) + radios.length) % radios.length]
    next.focus()
    next.click()
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="grid gap-2 sm:grid-cols-2">
      {children}
    </div>
  )
}

function OptionRow({
  icon: Icon,
  checked,
  onSelect,
  title,
  hint,
}: {
  icon: LucideIcon
  checked: boolean
  onSelect: () => void
  title: string
  hint: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "flex min-h-[72px] w-full items-center gap-3 rounded-xl border bg-surface px-3.5 py-3 text-left",
        "transition-colors duration-[var(--dur-1)] hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent",
        checked ? "border-accent/55 bg-accent-wash/45 hover:bg-accent-wash/60" : "border-line"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full",
          checked ? "bg-accent-wash text-accent" : "bg-sunken text-fg-muted"
        )}
      >
        <Icon className="size-[18px]" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg">{title}</span>
        <span className="block text-[13px] leading-5 text-fg-muted">{hint}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full border",
          checked ? "border-accent" : "border-edge"
        )}
      >
        {checked && <span className="size-2 rounded-full bg-accent" />}
      </span>
    </button>
  )
}

function Picker({
  pull,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  onFile,
  onPaste,
}: {
  pull: ScopusPull | undefined
  loading: boolean
  error: boolean
  onRetry: () => void
  selectedId: string | null
  onSelect: (p: PulledPaper) => void
  onFile?: (p: PulledPaper) => void
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

  if (error && papers.length === 0) {
    return (
      <div className="rounded-xl border border-line px-4 py-5 text-sm">
        <p className="font-medium text-fg">Couldn't read your record just now.</p>
        <p className="mt-1 text-fg-muted">Nothing is lost. Try again, or paste the DOI instead.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button kind="default" size="sm" type="button" onClick={onRetry}>
            <RefreshCw aria-hidden />
            Try again
          </Button>
          <Button kind="quiet" size="sm" type="button" onClick={onPaste}>
            Paste a DOI instead
          </Button>
        </div>
      </div>
    )
  }

  if (papers.length === 0) {
    return (
      <div className="flex items-center gap-4 rounded-xl border border-line px-4 py-5">
        <Illustration name="empty-no-papers" width={72} className="max-sm:hidden" />
        <div className="min-w-0 text-sm">
          <p className="font-medium text-fg">Nothing to pick yet — your record hasn't been matched to Scopus.</p>
          <button type="button" onClick={onPaste} className="mt-1 font-medium text-accent hover:underline">
            Paste a DOI instead
          </button>
        </div>
      </div>
    )
  }

  const shown = open.filter(match)
  return (
    <section className="space-y-3" aria-labelledby="pick-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pick-heading" className="text-sm font-medium text-fg">
          Your papers <span className="font-normal text-fg-muted">· {open.length} not yet filed</span>
        </h2>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-60">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              aria-label="Filter your papers"
              placeholder="Filter…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <Button kind="quiet" size="sm" type="button" onClick={onRetry} title="Check Scopus for new papers">
            <RefreshCw aria-hidden />
            <span className="max-sm:sr-only">Check Scopus for new papers</span>
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

      {open.length === 0 ? (
        <p className="rounded-xl border border-line px-4 py-4 text-sm text-fg-muted">
          All {papers.length} papers on your record are already filed.{" "}
          <Link to="/papers" className="font-medium text-accent hover:underline">
            See My papers
          </Link>
          , or paste a DOI for one the record hasn't caught.
        </p>
      ) : (
        <ul role="radiogroup" aria-label="Pick the paper to file" className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {shown.map((p) => {
            const on = p.publication_id === selectedId
            return (
              <li key={p.publication_id} className={cn("flex items-center gap-2 pr-3", on && "bg-accent-wash/45")}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onSelect(p)}
                  className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-3.5 text-left transition-colors duration-[var(--dur-1)] hover:bg-hover/60 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                      on ? "border-accent" : "border-edge"
                    )}
                  >
                    {on && <span className="size-2 rounded-full bg-accent" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm font-medium text-fg">{p.title}</span>
                    <span className="mt-0.5 block text-[13px] text-fg-muted">
                      {[
                        p.venue,
                        p.year,
                        p.citations != null ? `${p.citations} citation${p.citations === 1 ? "" : "s"}` : null,
                        p.author_position && p.total_authors ? `author ${p.author_position} of ${p.total_authors}` : null,
                        p.doi ? null : "no DOI",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
                {onFile && (
                  <Button
                    kind={on ? "primary" : "quiet"}
                    size="sm"
                    type="button"
                    onClick={() => onFile(p)}
                    aria-label={`File this: ${p.title}`}
                    className="shrink-0"
                  >
                    File this
                  </Button>
                )}
              </li>
            )
          })}
          {shown.length === 0 && <li className="px-4 py-5 text-center text-sm text-fg-muted">No paper matches that filter.</li>}
        </ul>
      )}

      {claimed.length > 0 && (
        <details className="rounded-xl border border-line px-3.5 py-2.5">
          <summary className="cursor-pointer text-sm text-fg-muted">Already claimed ({claimed.length})</summary>
          <ul className="mt-2 divide-y divide-line">
            {claimed.filter(match).map((p) => (
              <li key={p.publication_id} className="flex items-start gap-3 py-2">
                <span className="min-w-0 flex-1 text-fg-muted">
                  <span className="line-clamp-1 text-sm">{p.title}</span>
                  <span className="text-xs">{[p.venue, p.year].filter(Boolean).join(" · ")}</span>
                </span>
                {p.on_paid_ledger && !p.claim_id && (
                  <span className="shrink-0 text-xs text-fg-muted">
                    Paid{p.paid_month ? ` ${p.paid_month}` : ""} · on the ledger
                  </span>
                )}
                {p.claim_id ? (
                  <Link to={`/papers/${p.claim_id}`} className="shrink-0 text-sm font-medium text-accent hover:underline">
                    View claim
                  </Link>
                ) : (
                  <span className="shrink-0 text-xs text-fg-subtle">Filed</span>
                )}
              </li>
            ))}
          </ul>
        </details>
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
