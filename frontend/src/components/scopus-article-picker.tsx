import { useEffect, useState } from "react"
import { toast } from "sonner"
import { BadgeCheck, ExternalLink, Search, TriangleAlert } from "lucide-react"

import { Callout } from "@/components/form/fields"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { isLikelyDoi, normalizeDoiInput } from "@/lib/claim-fields"
import { cn } from "@/lib/utils"

export type ScopusCandidate = {
  title?: string | null
  doi?: string | null
  issn?: string | null
  eid?: string | null
  journal_title?: string | null
  publication_year?: number | null
  cover_date?: string | null
  aggregation_type?: string | null
  author_count?: number | null
  scopus_url?: string | null
  /** null when we had no author ID to check against — "unknown", not "no". */
  linked_to_author?: boolean | null
  /** You already have a live ticket for this article. */
  already_claimed?: boolean
}

type CandidateResponse = {
  ok: boolean
  code: string
  message?: string | null
  author_id?: string | null
  by_author?: boolean
  candidates: ScopusCandidate[]
}

type Mode = "author" | "search"

/**
 * "Find my article" — search Scopus and let the claimant pick the right record.
 *
 * The quiet autofill on blur takes Scopus's first hit, which is right most of
 * the time and wrong in exactly the cases that matter: errata, translations, and
 * same-titled papers by other groups. Choosing from the list is how a claimant
 * confirms the DOI on the ticket is really theirs.
 */
export function ScopusArticlePicker({
  open,
  onOpenChange,
  initialQuery,
  scopusAuthorUrl,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialQuery?: string
  scopusAuthorUrl?: string | null
  onPick: (candidate: ScopusCandidate) => void
}) {
  const [query, setQuery] = useState(initialQuery || "")
  const [results, setResults] = useState<ScopusCandidate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [checkedLinkage, setCheckedLinkage] = useState(false)
  const hasAuthor = !!(scopusAuthorUrl || "").trim()
  const [mode, setMode] = useState<Mode>(hasAuthor ? "author" : "search")

  async function load(next: Mode, q?: string) {
    setBusy(true)
    setMessage(null)
    try {
      const raw = (q ?? query).trim()
      const doi = normalizeDoiInput(raw)
      const res = await api<CandidateResponse>("/api/lookup/candidates", {
        method: "POST",
        json:
          next === "author"
            ? { scopus_author_url: scopusAuthorUrl || null, limit: 25 }
            : {
                doi: isLikelyDoi(doi) ? doi : null,
                title: isLikelyDoi(doi) ? null : raw,
                scopus_author_url: scopusAuthorUrl || null,
                limit: 10,
              },
      })
      setResults(res.candidates || [])
      setCheckedLinkage(!!res.author_id)
      if (!res.candidates?.length) {
        setMessage(res.message || "No Scopus record matched")
      }
    } catch (e) {
      setResults([])
      setMessage(e instanceof Error ? e.message : "Scopus is unavailable right now")
    } finally {
      setBusy(false)
    }
  }

  // Opening straight onto the author's own papers is the shortest path to the
  // right record — no typing, and everything listed is linked by construction.
  useEffect(() => {
    if (!open) return
    setQuery(initialQuery || "")
    setResults(null)
    setMessage(null)
    const next: Mode = hasAuthor ? "author" : "search"
    setMode(next)
    if (next === "author") load("author")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function search() {
    if (query.trim().length < 4) {
      toast.error("Enter a longer title, or a DOI")
      return
    }
    setMode("search")
    await load("search")
  }

  const anyLinked = (results || []).some((c) => c.linked_to_author === true)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Find your article in Scopus</DialogTitle>
          <DialogDescription>
            Search by title or DOI, then pick the exact record. The details on the form are filled
            from whichever one you choose.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div
            role="radiogroup"
            aria-label="How to find the article"
            className="inline-flex w-full gap-1 rounded-xl border border-border bg-muted/60 p-1"
          >
            {(
              [
                { value: "author", label: "My Scopus papers" },
                { value: "search", label: "Search by title or DOI" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={mode === opt.value}
                disabled={opt.value === "author" && !hasAuthor}
                onClick={() => {
                  setMode(opt.value)
                  if (opt.value === "author") load("author")
                }}
                className={cn(
                  "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-all outline-none",
                  "focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50",
                  mode === opt.value
                    ? "bg-card text-foreground shadow-sm ring-1 ring-primary/25"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {mode === "author" ? (
            !hasAuthor ? (
              <Callout tone="warning" title="No Scopus author link on your profile">
                Add your Scopus author profile link on the Identity step, then this list will show
                everything indexed against it.
              </Callout>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Everything indexed on your Scopus author profile, newest first.
                </p>
                <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => load("author")}>
                  {busy ? "Loading…" : "Refresh"}
                </Button>
              </div>
            )
          ) : (
            <div className="space-y-2">
              <Label htmlFor="scopus-search">Title or DOI</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id="scopus-search"
                    className="h-9 pl-9"
                    placeholder="Paper title, or 10.1000/xyz123"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        search()
                      }
                    }}
                  />
                </div>
                <Button type="button" disabled={busy} onClick={search}>
                  {busy ? "Searching…" : "Search"}
                </Button>
              </div>
            </div>
          )}
        </div>

        {busy ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : results === null ? null : results.length === 0 ? (
          <Callout tone="warning" title="Nothing found">
            {message || "No Scopus record matched that search."} If the article was published very
            recently it may not be indexed yet — a claim filed before indexing cannot be processed.
          </Callout>
        ) : (
          <div className="space-y-3">
            {checkedLinkage && !anyLinked && mode === "search" ? (
              <Callout tone="warning" title="None of these are linked to your Scopus profile">
                The article must sit on your own author profile. Use the Author Feedback Wizard to
                merge or link it before you submit, or correct the Scopus link in your profile.
              </Callout>
            ) : null}

            <ul className="space-y-2">
              {results.map((c, i) => (
                <li key={c.eid || c.doi || i}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(c)
                      onOpenChange(false)
                    }}
                    className={cn(
                      "w-full rounded-xl border p-3.5 text-left transition-colors outline-none",
                      "focus-visible:ring-3 focus-visible:ring-ring/30",
                      c.already_claimed
                        ? "border-destructive/40 bg-surface-danger/30 hover:border-destructive/60"
                        : c.linked_to_author
                          ? "border-success/40 bg-surface-success/40 hover:border-success/60"
                          : "border-border bg-card hover:border-primary/40 hover:bg-muted/50"
                    )}
                  >
                    <p className="text-sm font-medium leading-snug text-foreground">
                      {c.title || "Untitled record"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[
                        c.journal_title,
                        c.publication_year ? String(c.publication_year) : null,
                        c.aggregation_type,
                        c.author_count ? `${c.author_count} authors` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {c.already_claimed ? (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-destructive/15 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                          <TriangleAlert className="size-3" aria-hidden />
                          You already have a ticket for this article
                        </span>
                      ) : null}
                      {c.doi ? (
                        <span className="rounded-lg bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {c.doi}
                        </span>
                      ) : null}
                      {c.issn ? (
                        <span className="rounded-lg bg-muted px-2 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                          ISSN {c.issn}
                        </span>
                      ) : null}
                      {c.linked_to_author === true ? (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">
                          <BadgeCheck className="size-3" aria-hidden />
                          On your Scopus profile
                        </span>
                      ) : c.linked_to_author === false ? (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-warning/20 px-2 py-0.5 text-[11px] font-semibold text-warning-foreground">
                          <TriangleAlert className="size-3" aria-hidden />
                          Not linked to your profile
                        </span>
                      ) : null}
                      {c.scopus_url ? (
                        // Nested anchors are invalid inside a button, so this is a
                        // span that opens the record without triggering the pick.
                        <span
                          role="link"
                          tabIndex={0}
                          className="inline-flex items-center gap-1 text-[11px] text-primary underline underline-offset-2"
                          onClick={(e) => {
                            e.stopPropagation()
                            window.open(c.scopus_url as string, "_blank", "noopener,noreferrer")
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              e.stopPropagation()
                              window.open(c.scopus_url as string, "_blank", "noopener,noreferrer")
                            }
                          }}
                        >
                          Open in Scopus
                          <ExternalLink className="size-3" aria-hidden />
                        </span>
                      ) : null}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {results.length} match{results.length === 1 ? "" : "es"}. Picking one fills the title,
              journal, ISSN, DOI, date, SNIP, and quartile.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
