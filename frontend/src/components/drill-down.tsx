"use client"

import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowUpRight, Download } from "lucide-react"

import { JournalLink } from "@/components/journal-link"
import { Money, StatusChip, TicketProgress, formatMoney } from "@/components/ticket-ui"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { API_BASE, type Claim } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"

/**
 * A figure, opened where you are standing.
 *
 * Clicking "Associate Professor · 797" used to navigate to the query screen
 * with a filter pre-set. That answers the question, but it costs the reader
 * the page they were reading: the report they had scrolled to is gone, the
 * other twenty figures they were comparing it against are gone, and getting
 * back means the browser's back button and finding their place again. For a
 * number you wanted to glance behind, that is a heavy price.
 *
 * The rows come to the reader instead. Escape closes it and the report is
 * exactly where it was. The query screen is still one click away for anyone
 * who wants to keep narrowing — that is what it is for — but it is no longer
 * the toll for looking at a number.
 */

export type Drill = {
  /** What the reader clicked, in their words. */
  label: string
  /** Which figure it came from, for the subtitle. */
  dimension?: string
  /** Query-string fragment for /api/reports/search. */
  filter: string
}

type Results = {
  total: number
  total_amount: number
  results: Claim[]
}

const PAGE = 25

export function DrillDown({
  drill,
  onClose,
  portal,
  showMoney = true,
}: {
  drill: Drill | null
  onClose: () => void
  /** "/admin" — records open inside the reader's own portal. */
  portal: string
  showMoney?: boolean
}) {
  const [limit, setLimit] = useState(PAGE)

  // A fresh figure starts at the top, not wherever the last one was read to.
  useEffect(() => setLimit(PAGE), [drill?.filter])

  const { data, isLoading, isError } = useApiQuery<Results>(
    ["drill", drill?.filter || "", limit],
    `/api/reports/search?${drill?.filter || ""}&limit=${limit}&sort=amount`,
    { enabled: !!drill }
  )

  if (!drill) return null

  const shown = data?.results?.length || 0
  const more = (data?.total || 0) - shown

  return (
    <Sheet open onOpenChange={(v) => (v ? null : onClose())}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-2xl"
        aria-describedby={undefined}
      >
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="pr-8 text-left leading-snug">{drill.label}</SheetTitle>
          <SheetDescription className="text-left">
            {drill.dimension ? `${drill.dimension} · ` : ""}
            {isLoading
              ? "Counting…"
              : `${(data?.total || 0).toLocaleString()} publication${
                  data?.total === 1 ? "" : "s"
                }`}
            {showMoney && data?.total_amount ? ` · ${formatMoney(data.total_amount)}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : isError ? (
            <p className="p-5 text-sm text-muted-foreground">
              Could not load these rows — nothing was lost. Close and try again.
            </p>
          ) : !shown ? (
            <p className="p-5 text-sm text-muted-foreground">
              Nothing matches. The figure counts something this filter cannot reach — worth
              telling the research cell about.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data?.results.map((c) => (
                <li key={c.id} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="line-clamp-2 text-sm font-medium leading-snug">
                        {c.paper_title || "Untitled"}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {c.owner_name}
                        {c.owner_department ? ` · ${c.owner_department}` : ""}
                        {c.publication_year ? ` · ${c.publication_year}` : ""}
                      </p>
                      <div className="mt-1 text-xs">
                        <JournalLink title={c.journal_title} portal={portal} />
                      </div>
                    </div>
                    <div className="shrink-0 space-y-1 text-right">
                      {showMoney ? (
                        <p className="text-sm font-semibold tabular-nums">
                          <Money value={c.remuneration} />
                        </p>
                      ) : null}
                      <StatusChip status={c.status} />
                      <TicketProgress status={c.status} className="w-28" />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {more > 0 ? (
            <div className="px-5 py-4">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setLimit((l) => l + 50)}
              >
                Show 50 more — {more.toLocaleString()} still below
              </Button>
            </div>
          ) : null}
        </div>

        {/* The escape hatches: keep narrowing, or take it away as a file. The
            query screen is a choice now rather than the toll for looking. */}
        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <Button asChild variant="ghost" size="sm">
            <Link to={`${portal}/query?${drill.filter}`}>
              Open in Query
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
          {showMoney ? (
            <Button asChild variant="ghost" size="sm">
              <a href={`${API_BASE}/api/reports/search/export?${drill.filter}&fmt=xlsx`}>
                <Download className="size-3.5" />
                Excel
              </a>
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
