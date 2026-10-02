import { useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { ArrowRight, RefreshCw, UserCheck, Users } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Combobox } from "@/ui/combobox"
import { ConfirmDialog } from "@/ui/dialog"
import { Input } from "@/ui/field"
import { formatCount } from "@/lib/count"
import { Answer } from "@/ui/answer"
import { PageHeader } from "@/ui/page-header"
import { Pagination } from "@/ui/pagination"
import { Avatar } from "@/ui/person"
import { Details } from "@/ui/section"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The office's review of college authors the matcher could not place, and of
 * accounts that are one person twice. Backed by core/api/author_review.py:
 * "Accept" links every row now and keeps an alias so later harvests match on
 * their own; "Reject" hides the name as not on our roster; "Ambiguous" parks
 * it. No amounts appear anywhere on this page.
 */

type Suggestion = {
  id: string
  name: string
  department: string | null
  email: string
  score: number
  photo_url?: string | null
  initials?: string
}
type Group = { key: string; names: string[]; papers: number; authorships: number; suggestions: Suggestion[] }
type MatchesPayload = {
  total: number
  items: Group[]
  counts: { open: number; ambiguous: number; hidden: number; open_suggested?: number; open_unsuggested?: number }
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
  photo_url?: string | null
  initials?: string
}
type DupGroup = { key: string; accounts: Account[]; conflicts: string[] }
type MergeResult = { ok: boolean; needs_confirm?: boolean; conflicts?: string[] }
type PersonRow = { id: string; name: string; department: string | null; email: string }

const PAGE = 25
type Tab = "open" | "ambiguous" | "hidden" | "duplicates"
const TABS: { id: Tab; label: string }[] = [
  { id: "open", label: "To review" },
  { id: "ambiguous", label: "Ambiguous" },
  { id: "hidden", label: "Not on our roster" },
  { id: "duplicates", label: "Duplicate accounts" },
]
const KEYS = [["author-matches"], ["duplicate-accounts"]]

export function AuthorMatches() {
  const [params, setParams] = useSearchParams()
  const asked = params.get("tab") as Tab | null
  const tab: Tab = TABS.some((t) => t.id === asked) ? (asked as Tab) : "open"
  const filter = params.get("suggested")
  function setParam(changes: Record<string, string | null>) {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(changes)) {
          if (v) p.set(k, v)
          else p.delete(k)
        }
        return p
      },
      { replace: true }
    )
  }
  const setTab = (next: Tab) => setParam({ tab: next === "open" ? null : next, suggested: null })
  const counts = useApi<MatchesPayload>(["author-matches", "open", "", 0, ""], "/api/admin/author-matches?limit=1")
  const c = counts.data?.counts
  const rerun = useApiMutation<Record<string, never>, { job_id: string }>("/api/admin/author-matches/rerun")

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Author matches"
        sub="Say who each name is once. Later harvests follow."
        spot="spot-search"
        action={
          <Button
            kind="default"
            disabled={rerun.isPending}
            onClick={() =>
              rerun.mutate(
                {},
                {
                  onSuccess: () => toast.ok("Matching queued. Refresh in a few minutes."),
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

      <Answer
        items={[
          {
            value: c?.open,
            label: "Names to place",
            zero: "Every name is placed",
            to: "/people/matches",
          },
        ]}
      />

      <div role="tablist" aria-label="Review" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={
              "-mb-px border-b-2 px-3 py-2 text-sm max-sm:min-h-10 " +
              (tab === t.id ? "border-(--color-accent) font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg")
            }
          >
            {t.label}
            {t.id !== "duplicates" && c ? (
              <span className="ml-1.5 text-xs text-fg-muted tabular">{formatCount(c[t.id])}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "duplicates" ? (
        <Duplicates />
      ) : (
        <Names
          key={tab}
          status={tab}
          filter={filter === "yes" || filter === "no" ? filter : null}
          onFilter={(f) => setParam({ suggested: f })}
          counts={c}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */

function Names({
  status,
  filter,
  onFilter,
  counts,
}: {
  status: "open" | "ambiguous" | "hidden"
  filter: "yes" | "no" | null
  onFilter: (f: "yes" | "no") => void
  counts: MatchesPayload["counts"] | undefined
}) {
  const [q, setQ] = useState("")
  const [page, setPage] = useState(0)
  const [bulk, setBulk] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  // The few names with a likely person are one click each, so they come first;
  // when there are none, the rest is what is left to do.
  const shown: "yes" | "no" | "" =
    status !== "open" ? "" : (filter ?? ((counts?.open_suggested ?? 0) > 0 ? "yes" : "no"))
  const params = new URLSearchParams({ status, q, limit: String(PAGE), offset: String(page * PAGE) })
  if (shown) params.set("suggested", shown)
  const { data, isLoading, isError, refetch } = useApi<MatchesPayload>(
    ["author-matches", status, q, page, shown],
    `/api/admin/author-matches?${params}`,
    { placeholderData: (prev) => prev }
  )
  const hideAll = useApiMutation<Record<string, never>, { count: number }>("/api/admin/author-matches/hide-unsuggested", {
    invalidates: KEYS,
  })
  const restoreAll = useApiMutation<{ status: string }, { count: number }>("/api/admin/author-matches/restore-all", {
    invalidates: KEYS,
  })
  const waiting = counts?.open_unsuggested ?? 0
  const inList = status === "hidden" ? (counts?.hidden ?? 0) : (counts?.ambiguous ?? 0)

  /** j/k or the arrow keys walk the rows; the row itself takes the rest. */
  function onListKey(e: React.KeyboardEvent) {
    if (!["j", "k", "ArrowDown", "ArrowUp"].includes(e.key)) return
    const target = e.target as HTMLElement
    if (target.closest("input, [role=combobox], [role=listbox]")) return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])
    const at = rows.findIndex((r) => r.contains(document.activeElement))
    const next = e.key === "j" || e.key === "ArrowDown" ? at + 1 : at - 1
    const row = rows[Math.max(0, Math.min(rows.length - 1, next))]
    if (row) {
      e.preventDefault()
      row.focus()
    }
  }

  return (
    <section className="space-y-3">
      {status === "open" && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which names">
          <Button
            kind={shown === "yes" ? "primary" : "default"}
            size="sm"
            aria-pressed={shown === "yes"}
            onClick={() => {
              setPage(0)
              onFilter("yes")
            }}
          >
            With a likely match ({formatCount(counts?.open_suggested ?? 0)})
          </Button>
          <Button
            kind={shown === "no" ? "primary" : "default"}
            size="sm"
            aria-pressed={shown === "no"}
            onClick={() => {
              setPage(0)
              onFilter("no")
            }}
          >
            Match nobody ({formatCount(waiting)})
          </Button>
          {shown === "no" && waiting > 0 && (
            <Button kind="quiet" size="sm" onClick={() => setBulk(true)}>
              Set all {formatCount(waiting)} aside…
            </Button>
          )}
        </div>
      )}
      {status !== "open" && inList > 1 && (
        <div>
          <Button kind="quiet" size="sm" onClick={() => setBulk(true)}>
            Move all {formatCount(inList)} back to review…
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={bulk}
        onOpenChange={setBulk}
        title={
          status === "open"
            ? `Set aside ${formatCount(waiting)} names?`
            : `Move ${formatCount(inList)} names back to review?`
        }
        description={
          status === "open"
            ? `These ${formatCount(waiting)} names match nobody on the roster. They are marked "not on our roster" and leave this list. No paper changes, and you can bring any name back from the "Not on our roster" tab.`
            : `All ${formatCount(inList)} names in this list return to "To review". No paper changes.`
        }
        confirmLabel={status === "open" ? `Set ${formatCount(waiting)} aside` : `Move ${formatCount(inList)} back`}
        onConfirm={async () => {
          try {
            const r =
              status === "open"
                ? await hideAll.mutateAsync({})
                : await restoreAll.mutateAsync({ status })
            toast.ok(
              status === "open"
                ? `Set aside ${formatCount(r.count)} names as not on our roster.`
                : `Moved ${formatCount(r.count)} names back to review.`
            )
          } catch (e) {
            toast.fail(e)
            throw e
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Input
          aria-label="Search names"
          placeholder="Search a name"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(0)
          }}
          className="w-full max-w-sm"
        />
      </div>
      <Details label="keyboard shortcuts" className="hidden sm:block">
        <Meta className="block">
          <kbd>j</kbd> <kbd>k</kbd> move, <kbd>a</kbd> match the first suggestion,{" "}
          {status !== "hidden" ? (
            <>
              <kbd>r</kbd> not on our roster,{" "}
            </>
          ) : null}
          <kbd>o</kbd> pick someone else
        </Meta>
      </Details>
      {isError ? (
        <ErrorState what="the names" onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <SkeletonRows rows={6} />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title={
            q
              ? "No name matches that search"
              : status === "open"
                ? shown === "yes"
                  ? "No name has a likely match"
                  : "Every name is placed"
                : "Nothing here"
          }
          message={
            q
              ? "Try part of the surname."
              : status === "open"
                ? shown === "yes"
                  ? "Look at the names that match nobody, or re-run matching after the next harvest."
                  : "Re-run matching after the next harvest."
                : "No names are in this list."
          }
        />
      ) : (
        <>
          <ul ref={listRef} onKeyDown={onListKey} className="divide-y divide-line border-y border-line">
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
  const name = group.names[0]

  function send(s: string, user?: Suggestion | PersonRow) {
    decide.mutate(
      { key: group.key, status: s, user_id: user?.id },
      {
        onSuccess: (r) =>
          toast.ok(
            user
              ? `Matched: ${name} is ${user.name}. ${r.linked} paper${r.linked === 1 ? "" : "s"} linked, and later harvests will match too.`
              : s === "NOT_ROSTER"
                ? `Set ${name} aside: not on our roster`
                : `Parked ${name} as ambiguous`
          ),
        onError: (e) => toast.fail(e),
      }
    )
  }

  function onRowKey(e: React.KeyboardEvent<HTMLLIElement>) {
    if (e.target !== e.currentTarget || decide.isPending) return
    const first = group.suggestions[0]
    if ((e.key === "a" || e.key === "Enter") && first) {
      e.preventDefault()
      send("MATCHED", first)
    } else if (e.key === "r" && status !== "hidden") {
      e.preventDefault()
      send("NOT_ROSTER")
    } else if (e.key === "o") {
      e.preventDefault()
      setPicking(true)
    }
  }

  return (
    <li
      data-row
      tabIndex={0}
      onKeyDown={onRowKey}
      aria-label={`${name}, ${group.papers} paper${group.papers === 1 ? "" : "s"}`}
      className="space-y-3 px-1 py-4 outline-none focus-visible:bg-sunken focus-visible:ring-2 focus-visible:ring-(--color-accent)"
    >
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-3 md:grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1.3fr)] md:gap-4">
        {/* The name as it is printed on the papers. */}
        <div className="flex min-w-0 items-center gap-3">
          <Avatar person={{ name, initials: "", photo_url: null }} size="md" className="bg-sunken text-fg-muted" />
          <div className="min-w-0">
            <p className="font-medium break-words">{name}</p>
            {group.names.length > 1 && <Meta className="block">Also written {group.names.slice(1).join(", ")}</Meta>}
            <Meta className="block tabular-nums">
              {group.papers} paper{group.papers === 1 ? "" : "s"}
            </Meta>
          </div>
        </div>
        <ArrowRight className="mt-3 hidden size-4 text-fg-subtle md:block" aria-hidden />
        {/* Who on the roster it might be. */}
        <div className="min-w-0">
          {group.suggestions.length === 0 ? (
            <Meta className="block py-2">No likely match on the roster.</Meta>
          ) : (
            <ul className="space-y-2">
              {group.suggestions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-3">
                  <Avatar
                    person={{ name: s.name, initials: s.initials ?? "", photo_url: s.photo_url ?? null }}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{s.name}</p>
                    <Meta className="block truncate">
                      {[s.department, `${Math.round(s.score * 100)}% name match`].filter(Boolean).join(" · ")}
                    </Meta>
                  </div>
                  <Button
                    size="sm"
                    kind="default"
                    disabled={decide.isPending}
                    aria-label={`Match ${name} to ${s.name}`}
                    onClick={() => send("MATCHED", s)}
                  >
                    Match
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 md:pl-13">
        {status !== "hidden" && (
          <Button size="sm" kind="quiet" disabled={decide.isPending} onClick={() => send("NOT_ROSTER")}>
            Not on our roster
          </Button>
        )}
        {status === "open" && (
          <Button size="sm" kind="quiet" disabled={decide.isPending} onClick={() => send("AMBIGUOUS")}>
            Cannot tell
          </Button>
        )}
        <Button size="sm" kind="quiet" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
          Pick someone else
        </Button>
        {status !== "open" && (
          <Button
            size="sm"
            kind="quiet"
            disabled={undo.isPending}
            onClick={() =>
              undo.mutate(
                { key: group.key },
                { onSuccess: () => toast.ok(`Moved ${name} back to review.`), onError: (e) => toast.fail(e) }
              )
            }
          >
            Move back to review
          </Button>
        )}
      </div>
      {picking && (
        <div className={cn("flex flex-wrap items-center gap-2 md:pl-13")}>
          <Input
            aria-label="Find a person"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-xs"
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
            Match
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
  if (isError) return <ErrorState what="the duplicate accounts" onRetry={() => void refetch()} />
  if (isLoading || !data) return <SkeletonRows rows={4} />
  if (data.groups.length === 0)
    return <EmptyState icon={Users} title="No duplicate accounts" message="Accounts that share a name are listed here." />
  return (
    <section className="space-y-4">
      <Sub>Merging moves everything onto the kept account and switches the other off.</Sub>
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
    <div className="space-y-2 border-t border-line pt-4">
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
              <th className="py-1 font-normal">
                <span className="sr-only">Merge</span>
              </th>
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
                  <div className="flex items-center gap-2">
                    <Avatar person={{ name: a.name, initials: a.initials ?? "", photo_url: a.photo_url ?? null }} size="sm" />
                    <span className="break-all">{a.email}</span>
                  </div>
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
