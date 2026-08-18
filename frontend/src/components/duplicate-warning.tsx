"use client"

import { AlertOctagon, ShieldAlert } from "lucide-react"

import { Money, formatDateTime } from "@/components/ticket-ui"
import type { Claim } from "@/lib/api"

/**
 * What the payment history already holds for this paper.
 *
 * The check has always run at submission, and the answer went into the
 * database and stopped there: nothing on the approver's screen said the
 * college may already have paid for this. So the one fact that should stop a
 * clearance was the one fact nobody clearing could see.
 *
 * Each match is shown as the reference somebody can actually look up — a
 * ticket number or ERP claim ref, who was paid, when, and how much — because
 * "possible duplicate" with no reference is not something an approver can
 * act on, and gets waved through.
 */

type Match = {
  source: string
  id: string
  title?: string | null
  amount?: number | null
  reference?: string | null
  who?: string | null
  when?: string | null
}

function monthLabel(key?: string | null): string | null {
  if (!key) return null
  const [y, m] = key.split("-").map(Number)
  if (!y || !m) return key
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  })
}

export function DuplicateWarning({ claim }: { claim: Claim }) {
  const c = claim as unknown as Record<string, unknown>
  if (!c.duplicate_warning) return null

  let matches: Match[] = []
  try {
    const raw = c.duplicate_matches_json
    if (typeof raw === "string" && raw) matches = JSON.parse(raw)
  } catch {
    /* a malformed blob must not take the panel down with it */
  }

  const dismissed = !!c.override_duplicate
  const who = (c.override_by_name as string) || null
  const at = (c.override_at as string) || null
  const reason = (c.override_reason as string) || (c.contest_note as string) || null

  return (
    <section
      className={
        dismissed
          ? "rounded-[var(--radius)] border border-warning/50 bg-warning/10 p-4"
          : "rounded-[var(--radius)] border border-destructive/50 bg-destructive/10 p-4"
      }
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {dismissed ? (
          <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
        ) : (
          <AlertOctagon className="size-4 shrink-0 text-destructive" aria-hidden />
        )}
        {dismissed
          ? "Payment-history warning — set aside"
          : "The payment history already holds this paper"}
      </h3>

      <p className="mt-1.5 text-xs text-muted-foreground">
        {matches.length === 1
          ? "One earlier payment matches this paper."
          : `${matches.length} earlier payments match this paper.`}{" "}
        Check the reference before releasing anything.
      </p>

      {matches.length ? (
        <ul className="mt-3 space-y-2">
          {matches.slice(0, 10).map((m) => (
            <li
              key={m.id}
              className="rounded-xl border border-border bg-card px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-mono text-xs text-foreground">
                  {m.reference || (m.source === "prior" ? "ERP record" : "Ticket")}
                </span>
                <span className="font-medium">
                  <Money value={m.amount ?? null} />
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {m.title || "—"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[m.who, monthLabel(m.when), m.source === "prior" ? "imported ERP history" : "on this system"]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
          {matches.length > 10 ? (
            <li className="text-xs text-muted-foreground">
              and {matches.length - 10} more
            </li>
          ) : null}
        </ul>
      ) : null}

      {dismissed ? (
        <div className="mt-3 rounded-xl border border-border bg-card px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Set aside by <span className="font-medium text-foreground">{who || "somebody"}</span>
            {at ? ` · ${formatDateTime(at)}` : ""}
          </p>
          {reason ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{reason}</p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            That person cannot clear this ticket, and it needs a second approver before
            it can be paid.
          </p>
        </div>
      ) : null}
    </section>
  )
}
