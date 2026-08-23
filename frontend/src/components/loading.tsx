import { Skeleton } from "@/components/ui/skeleton"

/**
 * What a screen shows while its data is on the way.
 *
 * Six screens rendered `null` — a white void for as long as the query took,
 * which on three thousand rows is long enough to look like a broken page.
 * People pressed the link again, which started the query again.
 *
 * These are deliberately the shape of what is coming: a stat strip stays a
 * stat strip, a table stays a table with the same number of columns. A
 * spinner tells you to wait; a shape tells you what you are waiting for, and
 * stops the layout jumping when the real thing lands.
 */

export function LoadingStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-[var(--radius)] border border-border bg-card px-5 py-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-20" />
        </div>
      ))}
    </div>
  )
}

export function LoadingTable({
  rows = 8,
  columns = 6,
  caption,
}: {
  rows?: number
  columns?: number
  caption?: string
}) {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      {caption ? <p className="text-xs text-muted-foreground">{caption}</p> : null}
      <div className="overflow-hidden rounded-[var(--radius)] border border-border">
        <div className="border-b border-border bg-muted/30 px-3 py-2.5">
          <div className="flex gap-6">
            {Array.from({ length: columns }, (_, i) => (
              <Skeleton key={i} className="h-3 flex-1" />
            ))}
          </div>
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="border-b border-border/50 px-3 py-3 last:border-0">
            <div className="flex gap-6">
              {Array.from({ length: columns }, (_, c) => (
                <Skeleton
                  key={c}
                  className="h-3 flex-1"
                  // Slightly uneven, because a grid of identical bars reads as
                  // a rendering artefact rather than as content arriving.
                  style={{ opacity: 1 - r * 0.06, maxWidth: c === 1 ? "100%" : "70%" }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function LoadingCharts({ count = 2 }: { count?: number }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="surface-card p-5">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-2 h-3 w-56" />
          <Skeleton className="mt-5 h-40 w-full" />
        </div>
      ))}
    </div>
  )
}

/** The whole screen, for pages that are a header and then one thing. */
export function LoadingPage({ withStats = true }: { withStats?: boolean }) {
  return (
    <div className="space-y-6" aria-busy="true">
      <div>
        <Skeleton className="h-7 w-56" />
        <Skeleton className="mt-2 h-4 w-80" />
      </div>
      {withStats ? <LoadingStats /> : null}
      <LoadingTable />
    </div>
  )
}
