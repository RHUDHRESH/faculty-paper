import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { queryClient, useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { Answer } from "@/ui/answer"
import { PageHeader } from "@/ui/page-header"
import { Avatar } from "@/ui/person"
import { Details } from "@/ui/section"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * Record quality (super admin): papers recorded twice on somebody's record,
 * roster names their own papers spell differently, and records that cannot
 * be right. Every merge is audit-logged and can be undone here; roster names
 * change only when a person accepts a suggestion.
 */

type Side = {
  id: string
  title: string
  year: number | null
  doi: string | null
  venue: string
  citations: number
  source: string
  authors: number
  claims: number
  preprint: boolean
}
type PersonRef = { user_id: string; name: string; initials?: string; photo_url?: string | null }
type Pair = {
  key: string
  reason: string
  reason_label: string
  keep: Side
  drop: Side
  people: PersonRef[]
}
type Duplicates = {
  summary: { pairs: number; by_reason: Record<string, number>; people_affected: number }
  reasons: Record<string, string>
  pairs: Pair[]
}
type Merge = {
  id: string
  title: string
  year: number | null
  doi: string | null
  reason: string
  by: string
  at: string
  undone_at: string | null
}
type Suggestion = {
  user_id: string
  name: string
  initials?: string
  photo_url?: string | null
  department: string | null
  suggested: string
  word: string
  spelt: string
  papers: number
  unmatched_papers: number
  roster_spelling_papers: number
  samples: string[]
}
type AnomalyRow = { id: string; title: string; year: number | null; venue: string; doi: string | null }
type Anomalies = { anomalies: Record<string, { count: number; rows: AnomalyRow[] }> }

const DUP_KEY = ["admin", "record", "duplicates"]
const MERGE_KEY = ["admin", "record", "merges"]
const NAME_KEY = ["admin", "record", "roster-names"]
const ANOMALY_KEY = ["admin", "record", "anomalies"]

const ANOMALY_LABEL: Record<string, string> = {
  placeholder_title: "Titled \"-\", \"NA\" or nothing",
  impossible_year: "Dated before 1950 or in the future",
  no_authors: "No authors at all",
  venue_is_url: "A web address where the journal name belongs",
}

const TABS = [
  { key: "duplicates", label: "Recorded twice" },
  { key: "names", label: "Roster names" },
  { key: "anomalies", label: "Odd records" },
] as const
type Tab = (typeof TABS)[number]["key"]

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })

export function RecordQuality() {
  const [params, setParams] = useSearchParams()
  const asked = params.get("tab")
  const tab: Tab = TABS.some((t) => t.key === asked) ? (asked as Tab) : "duplicates"
  const setTab = (t: Tab) => setParams(t === "duplicates" ? {} : { tab: t })

  // The three lists are read here as well as in their tabs (same keys, so
  // each is fetched once): the counts are the answer, and belong above them.
  const dups = useApi<Duplicates>(DUP_KEY, "/api/admin/record/duplicates")
  const names = useApi<{ suggestions: Suggestion[] }>(NAME_KEY, "/api/admin/record/roster-names")
  const odd = useApi<Anomalies>(ANOMALY_KEY, "/api/admin/record/anomalies")
  const merges = useApi<{ merges: Merge[] }>(MERGE_KEY, "/api/admin/record/merges")
  const oddCount = odd.data ? Object.values(odd.data.anomalies).reduce((n, a) => n + a.count, 0) : null

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Record quality"
        sub="Nothing changes until you choose."
        spot="spot-audit"
        action={
          <Button asChild size="md" kind="default">
            <Link to="/data/health">Open data health</Link>
          </Button>
        }
      />
      <Answer
        items={[
          { value: dups.data ? dups.data.summary.pairs : null, label: "Papers recorded twice", to: "?", tone: "caution", zero: "No paper is recorded twice" },
          { value: names.data ? names.data.suggestions.length : null, label: "Roster names to check", to: "?tab=names", tone: "caution", zero: "Every name agrees" },
          { value: oddCount, label: "Odd records", to: "?tab=anomalies", tone: "caution", zero: "No record looks wrong" },
          { value: merges.data ? merges.data.merges.filter((m) => !m.undone_at).length : null, label: "Merges done", zero: "None yet" },
        ]}
      />
      <div role="tablist" aria-label="Record quality" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "inline-flex h-8 items-center rounded-control px-3 text-sm",
              tab === t.key ? "bg-selected font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "duplicates" && <DuplicatesTab />}
      {tab === "names" && <NamesTab />}
      {tab === "anomalies" && <AnomaliesTab />}
    </div>
  )
}

/* ------------------------------------------------------------ duplicates */

function DuplicatesTab() {
  const { data, isLoading, error, refetch } = useApi<Duplicates>(DUP_KEY, "/api/admin/record/duplicates")
  const merges = useApi<{ merges: Merge[] }>(MERGE_KEY, "/api/admin/record/merges")
  const [asking, setAsking] = useState<{ pair: Pair; swap: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [shown, setShown] = useState(10)

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: DUP_KEY }),
      queryClient.invalidateQueries({ queryKey: MERGE_KEY }),
    ])
  }

  async function merge(pair: Pair, swap: boolean) {
    const keep = swap ? pair.drop : pair.keep
    const drop = swap ? pair.keep : pair.drop
    setBusy(pair.key)
    try {
      await api("/api/admin/record/duplicates/merge", {
        method: "POST",
        json: { keep_id: keep.id, drop_id: drop.id, reason: pair.reason },
      })
      toast.ok("Merged. Undo it under recent merges.")
      await refresh()
    } catch (e) {
      toast.fail(e, "The merge did not go through")
    } finally {
      setBusy(null)
    }
  }

  async function dismiss(pair: Pair) {
    setBusy(pair.key)
    try {
      await api("/api/admin/record/duplicates/dismiss", { method: "POST", json: { a: pair.keep.id, b: pair.drop.id } })
      toast.ok("Marked as two different papers")
      await refresh()
    } catch (e) {
      toast.fail(e, "Could not save that")
    } finally {
      setBusy(null)
    }
  }

  async function undo(m: Merge) {
    setBusy(m.id)
    try {
      await api(`/api/admin/record/merges/${m.id}/undo`, { method: "POST" })
      toast.ok("Merge undone. Both records are back.")
      await refresh()
    } catch (e) {
      toast.fail(e, "The merge could not be undone")
    } finally {
      setBusy(null)
    }
  }

  if (isLoading) return <SkeletonRows rows={6} />
  if (error || !data) return <ErrorState onRetry={() => void refetch()} />

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(o) => !o && setAsking(null)}
        title="Merge these two records?"
        description={
          asking
            ? `${(asking.swap ? asking.pair.keep : asking.pair.drop).authors} authors, ${(asking.swap ? asking.pair.keep : asking.pair.drop).claims} filed ${(asking.swap ? asking.pair.keep : asking.pair.drop).claims === 1 ? "claim" : "claims"} and ${(asking.swap ? asking.pair.keep : asking.pair.drop).citations} citations move to the record you keep, and the paper count drops by one for each of ${asking.pair.people.length} ${asking.pair.people.length === 1 ? "person" : "people"}. You can undo it from this page.`
            : ""
        }
        confirmLabel="Merge"
        onConfirm={async () => {
          if (asking) await merge(asking.pair, asking.swap)
        }}
      />
      {data.pairs.length === 0 ? (
        <EmptyState
          illustration="empty-nothing-to-review"
          title="Nothing recorded twice"
          message="The nightly check looks again."
        />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {data.pairs.slice(0, shown).map((p) => (
              <PairRow
                key={p.key}
                pair={p}
                busy={busy === p.key}
                onMerge={(swap) => setAsking({ pair: p, swap })}
                onDismiss={() => void dismiss(p)}
              />
            ))}
          </ul>
          {data.pairs.length > shown && (
            <Button kind="default" onClick={() => setShown((n) => n + 10)}>
              Show {Math.min(10, data.pairs.length - shown)} more ({(data.pairs.length - shown).toLocaleString("en-IN")} left)
            </Button>
          )}
        </>
      )}

      <Details label="recent merges" count={(merges.data?.merges ?? []).length}>
        {(merges.data?.merges ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">No merges yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {merges.data!.merges.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{m.title || "Untitled"}</p>
                  <Meta>
                    {m.by}, {when(m.at)}
                    {m.undone_at ? `. Undone ${when(m.undone_at)}` : ""}
                  </Meta>
                </div>
                {!m.undone_at && (
                  <Button size="sm" onClick={() => void undo(m)} disabled={busy === m.id}>
                    {busy === m.id ? "Undoing" : "Undo"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Details>
    </div>
  )
}

function PairRow({
  pair,
  busy,
  onMerge,
  onDismiss,
}: {
  pair: Pair
  busy: boolean
  onMerge: (swap: boolean) => void
  onDismiss: () => void
}) {
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-sm bg-sunken px-1.5 text-xs font-medium text-fg-muted">{pair.reason_label}</span>
        {pair.people.map((u) => (
          <Link key={u.user_id} to={`/people/${u.user_id}`} className="flex items-center gap-1.5 text-sm hover:underline">
            <Avatar person={{ name: u.name, initials: u.initials ?? "", photo_url: u.photo_url ?? null }} size="xs" />
            {u.name}
          </Link>
        ))}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
        <SideCard side={pair.keep} label="Keep (the fuller record)" />
        <SideCard side={pair.drop} label="Fold in" muted />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onMerge(false)} disabled={busy}>
          Merge into the fuller record
        </Button>
        <Button size="sm" onClick={() => onMerge(true)} disabled={busy}>
          Keep the other one
        </Button>
        <Button size="sm" kind="quiet" onClick={onDismiss} disabled={busy}>
          Different papers
        </Button>
      </div>
    </li>
  )
}

function SideCard({ side, label, muted }: { side: Side; label: string; muted?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-control border border-line px-3 py-2.5", muted && "bg-sunken/40")}>
      <Meta>{label}</Meta>
      <p className="mt-0.5 text-sm font-medium [overflow-wrap:anywhere]">{side.title || "Untitled"}</p>
      <p className="mt-1 text-sm text-fg-muted [overflow-wrap:anywhere]">
        {[side.year ?? "No year", side.venue || "Journal not recorded", side.preprint ? "Preprint" : null]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p className="mt-0.5 text-sm text-fg-muted [overflow-wrap:anywhere]">
        {side.doi ? (
          <a className="underline-offset-2 hover:underline" href={`https://doi.org/${side.doi}`} target="_blank" rel="noreferrer">
            {side.doi}
          </a>
        ) : (
          "No DOI"
        )}
      </p>
      <Meta>
        {side.authors} author{side.authors === 1 ? "" : "s"} · {side.citations} citation{side.citations === 1 ? "" : "s"}
        {side.claims ? ` · ${side.claims} filed claim${side.claims === 1 ? "" : "s"}` : ""}
      </Meta>
    </div>
  )
}

/* ----------------------------------------------------------- roster names */

function NamesTab() {
  const { data, isLoading, error, refetch } = useApi<{ suggestions: Suggestion[] }>(NAME_KEY, "/api/admin/record/roster-names")
  const [asking, setAsking] = useState<Suggestion | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function act(s: Suggestion, what: "apply" | "dismiss") {
    setBusy(s.user_id)
    try {
      await api(`/api/admin/record/roster-names/${what}`, { method: "POST", json: { user_id: s.user_id, name: s.suggested } })
      toast.ok(what === "apply" ? `Renamed to ${s.suggested}` : "Suggestion dismissed")
      await queryClient.invalidateQueries({ queryKey: NAME_KEY })
    } catch (e) {
      toast.fail(e, "That did not save")
    } finally {
      setBusy(null)
    }
  }

  if (isLoading) return <SkeletonRows rows={5} />
  if (error || !data) return <ErrorState onRetry={() => void refetch()} />
  if (data.suggestions.length === 0)
    return (
      <EmptyState
        illustration="empty-nothing-to-review"
        title="Every roster name agrees with its papers"
        message="When a paper spells somebody's name a letter differently from the roster, it shows here."
      />
    )
  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(o) => !o && setAsking(null)}
        title={asking ? `Rename ${asking.name}?` : ""}
        description={
          asking
            ? `The roster will read "${asking.suggested}". Run author matching afterwards so the ${asking.unmatched_papers} unlinked papers join their record. Written to the audit log.`
            : ""
        }
        confirmLabel="Rename"
        onConfirm={async () => {
          if (asking) await act(asking, "apply")
        }}
      />
      <ul className="divide-y divide-line">
        {data.suggestions.map((s) => (
          <li key={s.user_id} className="flex flex-wrap items-start gap-3 py-4">
            <Avatar person={{ name: s.name, initials: s.initials ?? "", photo_url: s.photo_url ?? null }} />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm">
                <Link to={`/people/${s.user_id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>
                {s.department ? <Meta className="ml-1.5">{s.department}</Meta> : null}
              </p>
              <p className="text-sm">
                Papers say <span className="font-medium">{s.suggested}</span>
              </p>
              <Meta className="block">
                {s.papers} paper{s.papers === 1 ? "" : "s"}, {s.unmatched_papers} not yet on their record
              </Meta>
              <Details label="the spellings">
                <Meta className="block">
                  {s.papers} paper{s.papers === 1 ? "" : "s"} spell it "{s.spelt}", {s.roster_spelling_papers} spell
                  it "{s.word}". Seen as {s.samples.join(", ")}.
                </Meta>
              </Details>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setAsking(s)} disabled={busy === s.user_id}>
                Use this spelling
              </Button>
              <Button size="sm" kind="quiet" onClick={() => void act(s, "dismiss")} disabled={busy === s.user_id}>
                Roster is right
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* -------------------------------------------------------------- anomalies */

function AnomaliesTab() {
  const { data, isLoading, error, refetch } = useApi<Anomalies>(ANOMALY_KEY, "/api/admin/record/anomalies")
  if (isLoading) return <SkeletonRows rows={5} />
  if (error || !data) return <ErrorState onRetry={() => void refetch()} />
  return (
    <div className="space-y-6">
      {Object.entries(data.anomalies).map(([key, a]) => (
        <section key={key} className="space-y-2">
          <SectionTitle>
            {ANOMALY_LABEL[key] ?? key} <span className="tabular-nums text-fg-muted">({a.count})</span>
          </SectionTitle>
          {key === "venue_is_url" && a.count > 0 && (
            <Button size="sm" asChild>
              <Link to="/data/health">Clear web addresses in Data health</Link>
            </Button>
          )}
          {a.count === 0 ? (
            <p className="text-sm text-fg-muted">None.</p>
          ) : (
            <ul className="divide-y divide-line">
              {a.rows.map((r) => (
                <li key={r.id} className="py-2 text-sm">
                  <p className="[overflow-wrap:anywhere]">{r.title.trim() && r.title.trim() !== "-" ? r.title : "Untitled"}</p>
                  <Meta className="block [overflow-wrap:anywhere]">
                    {[r.year ?? "No year", r.venue || null, r.doi].filter(Boolean).join(" · ")}
                  </Meta>
                </li>
              ))}
              {a.count > a.rows.length && <li className="py-2"><Meta>and {a.count - a.rows.length} more</Meta></li>}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}
