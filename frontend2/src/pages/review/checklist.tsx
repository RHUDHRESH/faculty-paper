import { useCallback, useEffect, useState } from "react"

import { cn } from "@/lib/cn"
import type { ChecklistKey, ChecklistState } from "@/ui/review-marks"

/**
 * The reviewer's own checklist for one claim: the things the research cell
 * checks (docs/jtbd/research-cell.md), each marked OK, Issue or Needs info,
 * with a note. It is what the send-back reason is written from, so a claim
 * with two marked issues does not make the reviewer retype them.
 *
 * It is kept for the length of the tab (session storage), per claim: leaving
 * a claim to look at another and coming back must not cost the ticks.
 */

export const CHECKLIST_ITEMS: { key: ChecklistKey; label: string; ask: string }[] = [
  { key: "affiliation", label: "Affiliation", ask: "Does the byline name the college?" },
  { key: "author_position", label: "Author position", ask: "Is the claimant where they say in the list?" },
  { key: "sec_refs", label: "SEC references", ask: "Are the cited references there, and numbered?" },
  { key: "indexing", label: "Indexing", ask: "Is the journal indexed for the year of the paper?" },
  { key: "quartile", label: "Quartile", ask: "Is it the quartile the record gives?" },
  { key: "duplicate", label: "Duplicate", ask: "Has this paper been paid or claimed before?" },
  { key: "other", label: "Anything else", ask: "Something that does not fit above." },
]

type Status = "ok" | "issue" | "needs_info"

const STATUS_LABEL: Record<Status, string> = { ok: "OK", issue: "Issue", needs_info: "Needs info" }

const storageKey = (claimId: string) => `review.checklist.${claimId}`

function read(claimId: string): ChecklistState {
  try {
    const raw = sessionStorage.getItem(storageKey(claimId))
    return raw ? (JSON.parse(raw) as ChecklistState) : {}
  } catch {
    return {}
  }
}

/** The checklist for one claim, and how to change it. */
export function useChecklist(claimId: string) {
  const [state, setState] = useState<ChecklistState>(() => read(claimId))

  useEffect(() => {
    setState(read(claimId))
  }, [claimId])

  const update = useCallback(
    (key: ChecklistKey, change: { status?: Status | null; note?: string }) => {
      setState((prev) => {
        const next: ChecklistState = { ...prev }
        const row = next[key]
        const status = change.status === undefined ? row?.status : change.status
        if (!status) {
          delete next[key]
        } else {
          next[key] = { status, note: change.note ?? row?.note ?? "" }
        }
        try {
          sessionStorage.setItem(storageKey(claimId), JSON.stringify(next))
        } catch {
          // Private browsing can refuse storage; the ticks still work on screen.
        }
        return next
      })
    },
    [claimId]
  )

  return [state, update] as const
}

export function Checklist({
  state,
  onChange,
  hints,
}: {
  state: ChecklistState
  onChange: (key: ChecklistKey, change: { status?: Status | null; note?: string }) => void
  /** A sentence per row, from the record, shown under a row that needs a look. */
  hints: Partial<Record<ChecklistKey, string>>
}) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {CHECKLIST_ITEMS.map((item) => {
        const row = state[item.key]
        const status = row?.status ?? null
        const hint = hints[item.key]
        return (
          <li key={item.key} className="space-y-1.5 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block text-xs text-fg-muted">{item.ask}</span>
              </span>
              <div role="group" aria-label={`${item.label}: your finding`} className="flex shrink-0 gap-1">
                {(["ok", "issue", "needs_info"] as Status[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={status === s}
                    onClick={() => onChange(item.key, { status: status === s ? null : s })}
                    className={cn(
                      "h-7 rounded-md px-2 text-xs font-medium ring-1 ring-inset max-sm:h-9 max-sm:px-3",
                      status === s
                        ? s === "ok"
                          ? "bg-positive-wash text-positive ring-positive/30"
                          : s === "issue"
                            ? "bg-critical-wash text-critical ring-critical/30"
                            : "bg-caution-wash text-caution ring-caution/30"
                        : "bg-surface text-fg-muted ring-line hover:bg-hover hover:text-fg"
                    )}
                  >
                    {STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
            {hint && status !== "ok" && <p className="text-xs text-critical">{hint}</p>}
            {status && status !== "ok" && (
              <div>
                <label className="sr-only" htmlFor={`note-${item.key}`}>
                  Note for {item.label}
                </label>
                <input
                  id={`note-${item.key}`}
                  value={row?.note ?? ""}
                  onChange={(e) => onChange(item.key, { note: e.target.value })}
                  placeholder={status === "issue" ? "What is wrong, in a sentence the claimant can act on" : "What do you need to know?"}
                  className="h-8 w-full rounded-md bg-surface px-2.5 text-sm shadow-well ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent max-sm:h-10"
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
