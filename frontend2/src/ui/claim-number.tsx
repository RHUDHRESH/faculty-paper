import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { CopyButton } from "@/ui/copy"
import { Meta } from "@/ui/text"

/**
 * Claim numbers, as people type and say them.
 *
 * `FP-2026-000123` for a claim filed here, `ERP-PROCESSED-120` for one brought
 * over from the old ERP. The server matches the exact number and any start of
 * one (`GET /api/search/claim-number`); this file is the client's half: what
 * counts as a claim number, how a typed number is compared with the ones on
 * screen, and the small "found it" line that jumps to a claim outside the
 * list you are looking at.
 */

/** "fp 2026 123" and "FP-2026-000123" are the same number. */
export function compactNo(text: string | null | undefined): string {
  return (text || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** True for "FP-2026-0001", "fp 2026", "ERP-PROC" and other starts of a claim number. */
export function looksLikeClaimNo(text: string | null | undefined): boolean {
  return /^(FP|ERP)([-\s_\d]|$)/i.test((text || "").trim()) && (text || "").trim().length >= 4
}

/**
 * Whether a typed search matches a claim number.
 *
 * A number typed in full matches with or without its zeros, so `fp 2026 123`
 * finds `FP-2026-000123`. Anything shorter is a prefix, so `ERP-PROC` finds
 * every imported claim. Text that is not a number never matches here: the
 * caller falls back to its own title and name matching.
 */
export function matchesClaimNo(ticket: string | null | undefined, typed: string): boolean {
  if (!ticket || !looksLikeClaimNo(typed)) return false
  const have = compactNo(ticket)
  const want = compactNo(typed)
  if (have.startsWith(want)) return true
  const fp = /^FP(\d{4})(\d{1,6})$/.exec(want)
  return !!fp && have === `FP${fp[1]}${fp[2].padStart(6, "0")}`
}

/** The number, mono-spaced, with a one-press copy beside it. Safe inside a
 *  clickable row: pressing copy does not open the row. */
export function ClaimNo({
  value,
  className,
  copy = true,
}: {
  value: string | null | undefined
  className?: string
  copy?: boolean
}) {
  if (!value) return <span className={cn("text-sm text-fg-subtle", className)}>No claim no. yet</span>
  return (
    <span className={cn("inline-flex items-center gap-0.5 whitespace-nowrap", className)}>
      <span className="tabular text-sm">{value}</span>
      {copy && (
        <span onClick={(e) => e.stopPropagation()} className="inline-flex">
          <CopyButton value={value} label={`claim no. ${value}`} className="size-5" />
        </span>
      )}
    </span>
  )
}

export type ClaimNoHit = {
  id: string
  title: string
  subtitle: string
  url: string
  stage?: string
  review_url?: string | null
  meta: { ticket_number: string | null }
}

type ClaimNoSearch = { q: string; exact: ClaimNoHit | null; results: ClaimNoHit[] }

/** The server's exact and prefix answer for a typed claim number. Nothing is
 *  asked until the text looks like one, and not on every keystroke. */
export function useClaimNoSearch(term: string, enabled = true) {
  const [settled, setSettled] = useState("")
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(term.trim()), 200)
    return () => window.clearTimeout(t)
  }, [term])
  const on = enabled && looksLikeClaimNo(settled)
  return useApi<ClaimNoSearch>(
    ["claim-number", settled],
    `/api/search/claim-number?q=${encodeURIComponent(settled)}`,
    { enabled: on, staleTime: 15_000 }
  )
}

/**
 * "Found FP-2026-000123: Open it". For a claim that is not in the list on
 * screen (already cleared, or at another desk), so a typed number always
 * lands somewhere.
 */
export function ClaimNoJump({
  term,
  skip,
  className,
}: {
  term: string
  /** Claim ids already on screen, which need no jump. */
  skip?: ReadonlySet<string>
  className?: string
}) {
  const { data } = useClaimNoSearch(term)
  const hits = (data?.exact ? [data.exact] : data?.results ?? []).filter((h) => !skip?.has(h.id))
  if (hits.length === 0) return null
  const hit = hits[0]
  return (
    <p className={cn("text-sm", className)} role="status">
      <span className="tabular font-medium">{hit.meta.ticket_number}</span>
      <Meta>
        {hit.stage ? ` is ${hit.stage.toLowerCase()}` : ""}
        {hit.title ? `. ${hit.title}` : ""}
        {hits.length > 1 ? ` (and ${hits.length - 1} more like it)` : ""}
      </Meta>{" "}
      <Link to={hit.review_url || hit.url} className="text-accent underline underline-offset-2">
        Open it
      </Link>
    </p>
  )
}
