"use client"

import { ExternalLink } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A link to the paper that actually reaches the paper.
 *
 * Every "Open in Scopus" on these screens pointed at
 * `scopus.com/inward/record.uri?...`, which is a correct Scopus address and,
 * without an institutional Scopus subscription, bounces the reader to Scopus's
 * own landing page. The link worked; it just did not work for the person
 * clicking it, and landing somewhere unrelated reads as the system being
 * broken rather than as a paywall.
 *
 * The DOI goes to the publisher's record of the paper and resolves for
 * anybody, so it leads. 2,975 of the college's 3,226 publications carry one,
 * and every one of the rest carries a Scopus link — which is still offered,
 * labelled with what it needs.
 */
export function PaperLink({
  doi,
  scopusUrl,
  className,
  compact = false,
}: {
  doi?: string | null
  scopusUrl?: string | null
  className?: string
  /** Just the one best link, for a table cell. */
  compact?: boolean
}) {
  const cleanDoi = (doi || "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
  const doiHref = cleanDoi ? `https://doi.org/${cleanDoi}` : null
  const scopus = (scopusUrl || "").trim() || null

  if (!doiHref && !scopus) {
    return <span className={cn("text-muted-foreground", className)}>—</span>
  }

  const link = (href: string, label: string, title?: string) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={title}
      className="interactive inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
    >
      {label}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  )

  if (compact || !doiHref || !scopus) {
    const best = doiHref || (scopus as string)
    return (
      <span className={cn("text-xs", className)}>
        {doiHref
          ? link(best, "Open the paper", `doi.org/${cleanDoi}`)
          : link(best, "Open in Scopus", "Needs an institutional Scopus subscription")}
      </span>
    )
  }

  return (
    <span className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", className)}>
      {link(doiHref, "Open the paper", `doi.org/${cleanDoi}`)}
      <span className="text-muted-foreground">
        {link(scopus, "Scopus record", "Needs an institutional Scopus subscription")}
        <span className="ml-1 opacity-70">(needs a subscription)</span>
      </span>
    </span>
  )
}
