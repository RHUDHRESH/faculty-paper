import { useState } from "react"
import { RefreshCw, UserCheck, Users } from "lucide-react"

import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Combobox } from "@/ui/combobox"
import { ConfirmDialog } from "@/ui/dialog"
import { Input } from "@/ui/field"
import { HeroBand } from "@/ui/hero"
import { Pagination } from "@/ui/pagination"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The office's review of college authors the matcher could not place, and of
 * accounts that are one person twice. Backed by core/api/author_review.py:
 * "This is <user>" links every row now and keeps an alias so later harvests
 * match on their own; "Not on our roster" hides the name; "Ambiguous" parks
 * it. No amounts appear anywhere on this page.
 */

type Suggestion = { id: string; name: string; department: string | null; email: string; score: number }
type Group = { key: string; names: string[]; papers: number; authorships: number; suggestions: Suggestion[] }
type MatchesPayload = {
  total: number
  items: Group[]
  counts: { open: number; ambiguous: number; hidden: number }
}
type Account = {
  id: string
  name: string
  email: string
  department: string | null
  role: string
  employee_id: string | null
  staff_id: string | null
  biometric_id: string | null
  orcid_id: string | null
  scopus_author_id: string | null
  claims: number
  papers: number
  last_login: string | null
}
type DupGroup = { key: string; accounts: Account[]; conflicts: string[] }
type MergeResult = { ok: boolean; needs_confirm?: boolean; conflicts?: string[] }
type PersonRow = { id: string; name: string; department: string | null; email: string }

const PAGE = 25
type Tab = "open" | "ambiguous" | "hidden" | "duplicates"
const TABS: { id: Tab; label: string }[] = [
  { id: "open", label: "To review" },
  { id: "ambiguous", label: "Ambiguous" },
  { id: "hidden", label: "Not on roster" },
  { id: "duplicates", label: "Duplicate accounts" },
]
const KEYS = [["author-matches"], ["duplicate-accounts"]]

export function AuthorMatches() {
  const [tab, setTab] = useState<Tab>("open")
  const counts = useApi<MatchesPayload>(["author-matches", "open", "", 0], "/api/admin/author-matches?limit=1")
  const rerun = useApiMutation<Record<string, never>, { job_id: string }>("/api/admin/author-matches/rerun")

  return (
    <div className="space-y-6">
      <HeroBand
        area="people"
        eyebrow="Set up"
        title="Author matches"
        figure={
          counts.data
            ? { value: counts.data.counts.open, label: "names nobody has placed", countKey: "author-matches" }
            : undefined
        }
        sentence="College authors from the OpenAlex harvest that match nobody on the roster. Say who each one is once and every future harvest follows."
        actions={
          <Button
            kind="default"
            disabled={rerun.isPending}
            onClick={() =>
              rerun.mutate(
                {},
                {
                  onSuccess: () => toast.ok("Matching queued. It runs in the background; refresh in a few minutes."),
                  onError: (e) => toast.fail(e),
                }
              )
            }
          >
            <RefreshCw className={rerun.isPending ? "animate-spin" : undefined} />
            Re-run matching
          </Button>
        }
      />

      <div role="tablist" aria-label="Review" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={
              "-mb-px border-b-2 px-3 py-2 text-sm " +
              (tab === t.id ? "border-(--color-accent) font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg")
            }
          >
            {t.label}
            {t.id !== "duplicates" && counts.data ? (
              <span className="ml-1.5 text-xs text-fg-muted tabular-nums">{counts.data.counts[t.id]}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "duplicates" ? <Duplicates /> : <Names status={tab} />}
    </div>
  )
}

/* ------------------------------------------------------------------------ */

function Names({ status }: { status: "open" | "ambiguous" | "hidden" }) {
  const [q, setQ] = useState("")
  const [page, setPage] = useState(0)
  const params = new URLSearchParams({ status, q, limit: String(PAGE), offset: String(page * PAGE) })
  const { data, isLoading, isError, refetch } = useApi<MatchesPayload>(
    ["author-matches", status, q, page],
    `/api/admin/author-matches?${params}`,
    { placeholderData: (prev) => prev }
  )

  return (
    <section className="space-y-3">
      <Input
        aria-label="Search names"
        placeholder="Search a name…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setPage(0)
        }}
        className="max-w-sm"
      />
      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <SkeletonRows rows={6} />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title={q ? "No name matches that search" : "Nothing here"}
          message={status === "open" ? "Every college author name has been placed or decided." : "No names in this list."}
        />
      ) : (
        <>
          <ul className="divide-y divide-line rounded-md border border-line">
            {data.items.map((g) => (
              <NameRow key={g.key} group={g} status={status} />
            ))}
          </ul>
          <Pagination page={page} pageSize={PAGE} total={data.total} onChange={setPage} />
        </>
      )}
    </section>
  )
}

function NameRow({ group, status }: { group: Group; status: string }) {
  const [picking, setPicking] = useState(false)
  const [other, setOther] = useState<string | null>(null)
  const [search, setSearch] = useState(group.names[0] ?? "")
  const decide = useApiMutation<{ key: string; status: string; user_id?: string }, { linked: number }>(
    "/api/admin/author-matches/decide",
    { invalidates: KEYS }
  )
  const undo = useApiMutation<{ key: string }>("/api/admin/author-matches/undo", { invalidates: KEYS })
  const people = useApi<{ results: PersonRow[] }>(
    ["people", "pick", search],
    `/api/admin/users?${new URLSearchParams({ q: search, limit: "20" })}`,
    { enabled: picking }
  )

  function send(s: string, user?: Suggestion | PersonRow) {
    decide.mutate(
      { key: group.key, status: s, user_id: user?.id },
      {
        onSuccess: (r) =>
          toast.ok(
            user
              ? `Linked to ${user.name}: ${r.linked} paper${r.linked === 1 ? "" : "s"}. Future harvests will match too.`
              : s === "NOT_ROSTER"
                ? `${group.names[0]} hidden`
                : `${group.names[0]} marked ambiguous`
          ),
        onError: (e) => toast.fail(e),
      }
    )
  }

  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{group.names[0]}</p>
          {group.names.length > 1 && <Meta>Also written {group.names.slice(1).join(", ")}</Meta>}
        </div>
        <Meta className="tabular-nums">
          {group.papers} paper{group.papers === 1 ? "" : "s"}
        </Meta>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {group.suggestions.map((s) => (
          <Button key={s.id} size="sm" kind="default" disabled={decide.isPending} onClick={() => send("MATCHED", s)}>
            This is {s.name}
            {s.department ? <span className="text-fg-muted">· {s.department}</span> : null}
          </Button>
        ))}
        {group.suggestions.length === 0 && <Meta>No likely match on the roster.</Meta>}
        <Button size="sm" kind="quiet" onClick={() => setPicking((v) => !v)}>
          Someone else…
        </Button>
        {status !== "hidden" && (
          <Button size="sm" kind="quiet" disabled={decide.isPending} onClick={() => send("NOT_ROSTER")}>
            Not on our roster
          </Button>
        )}
        {status === "open" && (
          <Button size="sm" kind="quiet" disabled={decide.isPending} onClick={() => send("AMBIGUOUS")}>
            Ambiguous
          </Button>
        )}
        {status !== "open" && (
          <Button size="sm" kind="quiet" disabled={undo.isPending} onClick={() => undo.mutate({ key: group.key })}>
            Back to review
          </Button>
        )}
      </div>
      {picking && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Find a person"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <Combobox
            aria-label="Person"
            value={other}
            onChange={setOther}
            options={(people.data?.results ?? []).map((p) => ({
              value: p.id,
              label: p.name,
              hint: p.department ?? p.email,
            }))}
            placeholder="Pick a person"
          />
          <Button
            size="sm"
            kind="primary"
            disabled={!other || decide.isPending}
            onClick={() => {
              const p = people.data?.results.find((x) => x.id === other)
              if (p) send("MATCHED", p)
            }}
          >
            Link
          </Button>
        </div>
      )}
    </li>
  )
}

/* ------------------------------------------------------------------------ */

const FIELD_LABEL: Record<string, string> = {
  employee_id: "Employee ID",
  staff_id: "Staff ID",
  biometric_id: "Biometric ID",
  orcid_id: "ORCID",
  scopus_author_id: "Scopus ID",
}

function Duplicates() {
  const { data, isLoading, isError, refetch } = useApi<{ groups: DupGroup[] }>(
    ["duplicate-accounts"],
    "/api/admin/duplicate-accounts"
  )
  if (isError) return <ErrorState onRetry={() => void refetch()} />
  if (isLoading || !data) return <SkeletonRows rows={4} />
  if (data.groups.length === 0)
    return <EmptyState icon={Users} title="No duplicate accounts" message="No two active accounts share a name." />
  return (
    <section className="space-y-4">
      <Sub>
        Accounts whose names normalise to the same person. Merging moves claims, papers, follows and name links onto
        the account you keep, fills its blank IDs from the other, and switches the other off. It is written to the
        audit log.
      </Sub>
      {data.groups.map((g) => (
        <DupCard key={g.key + g.accounts.map((a) => a.id).join()} group={g} />
      ))}
    </section>
  )
}

function DupCard({ group }: { group: DupGroup }) {
  const [keep, setKeep] = useState(group.accounts[0].id)
  const [drop, setDrop] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const merge = useApiMutation<{ keep_id: string; drop_id: string; confirm?: boolean }, MergeResult>(
    "/api/admin/duplicate-accounts/merge",
    { invalidates: [...KEYS, ["people"]] }
  )
  const keepName = group.accounts.find((a) => a.id === keep)?.name

  function run(dropId: string, confirmed = false) {
    merge.mutate(
      { keep_id: keep, drop_id: dropId, confirm: confirmed },
      {
        onSuccess: (r) => {
          if (r.needs_confirm) {
            setDrop(dropId)
            setConfirm(r.conflicts ?? [])
          } else {
            setConfirm(null)
            toast.ok(`Merged into ${keepName}`)
          }
        },
        onError: (e) => toast.fail(e),
      }
    )
  }

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle>{group.accounts[0].name}</SectionTitle>
        {group.conflicts.length > 0 && (
          <Chip tone="caution">Different {group.conflicts.map((f) => FIELD_LABEL[f] ?? f).join(", ")}</Chip>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-fg-muted">
            <tr>
              <th className="py-1 pr-3 font-normal">Keep</th>
              <th className="py-1 pr-3 font-normal">Account</th>
              <th className="py-1 pr-3 font-normal">IDs</th>
              <th className="py-1 pr-3 font-normal">Claims</th>
              <th className="py-1 pr-3 font-normal">Papers</th>
              <th className="py-1 font-normal" />
            </tr>
          </thead>
          <tbody>
            {group.accounts.map((a) => (
              <tr key={a.id} className="border-t border-line align-top">
                <td className="py-2 pr-3">
                  <input
                    type="radio"
                    name={`keep-${group.key}`}
                    aria-label={`Keep ${a.email}`}
                    checked={keep === a.id}
                    onChange={() => setKeep(a.id)}
                  />
                </td>
                <td className="py-2 pr-3">
                  <div>{a.email}</div>
                  <Meta>
                    {[a.department, a.role, a.last_login ? "has signed in" : "never signed in"].filter(Boolean).join(" · ")}
                  </Meta>
                </td>
                <td className="py-2 pr-3">
                  <Meta>
                    {Object.keys(FIELD_LABEL)
                      .filter((f) => a[f as keyof Account])
                      .map((f) => `${FIELD_LABEL[f]} ${a[f as keyof Account]}`)
                      .join(" · ") || "none"}
                  </Meta>
                </td>
                <td className="py-2 pr-3 tabular-nums">{a.claims}</td>
                <td className="py-2 pr-3 tabular-nums">{a.papers}</td>
                <td className="py-2 text-right">
                  {a.id !== keep && (
                    <Button size="sm" kind="default" disabled={merge.isPending} onClick={() => run(a.id)}>
                      Merge into kept
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirm && drop && (
        <Callout tone="caution" title="These accounts disagree">
          They carry different {confirm.map((f) => FIELD_LABEL[f] ?? f).join(", ")}. Check they really are one person.
        </Callout>
      )}
      <ConfirmDialog
        open={!!confirm && !!drop}
        onOpenChange={(o) => {
          if (!o) setConfirm(null)
        }}
        title="Merge accounts with different IDs?"
        description={`They carry different ${(confirm ?? []).map((f) => FIELD_LABEL[f] ?? f).join(", ")}. The kept account's IDs stay; payment rows under the other staff or biometric ID are re-pointed to the kept one.`}
        confirmLabel="Merge anyway"
        danger
        onConfirm={() => {
          if (drop) run(drop, true)
        }}
      />
    </div>
  )
}
