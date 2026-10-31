import { useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { api, type ApiError } from "@/lib/api"
import { unshout } from "@/lib/names"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { DetailLink } from "@/ui/detail-sheet"
import { Table, type Column } from "@/ui/table"
import { toast } from "@/ui/toast"

/**
 * Two questions the research office needs answered on My papers:
 *
 *   1. "Is this your Scopus profile?" -- asked once, while the account has a
 *      Scopus author ID that nobody has confirmed or disputed yet.
 *   2. "Papers we are not sure about" -- papers that were on the list because
 *      the name matched, but that Scopus does not show under this person's
 *      profile. The person says which are theirs.
 */

export type ScopusProfileState = {
  scopus_author_id: string | null
  url: string | null
  papers_in_scopus: number
  papers_on_record: number
  status: "" | "confirmed" | "wrong" | "no_id"
  checked_at: string | null
}

export type PaperCandidate = {
  id: string
  reason: string
  source: string
  publication: {
    id: string
    title: string
    year: number | null
    venue: string | null
    doi: string | null
    authors: string[]
    author_count: number
  }
}

type CandidatesPayload = { pending: number; results: PaperCandidate[] }

const PROFILE_KEY = ["me-scopus-profile"] as const
const CANDIDATES_KEY = ["me-paper-candidates"] as const

export function ScopusProfileQuestion() {
  const qc = useQueryClient()
  const profile = useApi<ScopusProfileState>(PROFILE_KEY, "/api/me/scopus-profile")
  const answer = useApiMutation<{ answer: "yes" | "no" }, ScopusProfileState>("/api/me/scopus-profile")
  // The answer given during this visit. It stays on screen after the profile
  // is confirmed or disputed, so the thank-you is not lost on the refetch.
  const [answered, setAnswered] = useState<"yes" | "no" | null>(null)

  if (answered) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        {answered === "yes"
          ? "Thank you. Your Scopus profile is confirmed."
          : "Thank you. The research office will correct your profile."}
      </p>
    )
  }

  const s = profile.data
  if (!s) return null

  if (s.status === "no_id") {
    return (
      <p className="text-base text-fg-muted">
        You have no Scopus ID on your account. Add it in{" "}
        <Link to="/profile" className="text-fg underline-offset-4 hover:underline">
          your profile
        </Link>{" "}
        so your papers can be found.
      </p>
    )
  }

  if (s.status !== "" || !s.scopus_author_id) return null

  async function send(choice: "yes" | "no") {
    try {
      const next = await answer.mutateAsync({ answer: choice })
      qc.setQueryData(PROFILE_KEY, next)
      setAnswered(choice)
    } catch (e) {
      toast.fail(e)
    }
  }

  return (
    <section aria-labelledby="scopus-question" className="rounded-panel p-4 ring-1 ring-inset ring-edge">
      <h2 id="scopus-question" className="text-base font-medium text-fg">
        Is this your Scopus profile?
      </h2>
      <p className="mt-1 text-base text-fg-muted">
        Scopus has {s.papers_in_scopus} papers under author number {s.scopus_author_id} (
        <a
          href={s.url ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="text-fg underline-offset-4 hover:underline"
        >
          open it
        </a>
        )
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button kind="default" className="max-sm:h-10" disabled={answer.isPending} onClick={() => void send("yes")}>
          Yes, this is me
        </Button>
        <Button kind="quiet" className="max-sm:h-10" disabled={answer.isPending} onClick={() => void send("no")}>
          No, this is wrong
        </Button>
      </div>
    </section>
  )
}

/** "Dr Ravi Kumar" -> "Ravi": the first name that is not a title. */
const TITLE = /^(dr|prof|mr|mrs|ms|miss)\.?$/i
function firstName(name: string): string {
  return name.trim().split(/\s+/).find((w) => !TITLE.test(w)) ?? name.trim()
}

export function PaperCandidates() {
  const qc = useQueryClient()
  const list = useApi<CandidatesPayload>(CANDIDATES_KEY, "/api/me/paper-candidates")
  const confirm = useMutation<{ pending: number }, ApiError, string>({
    mutationFn: (id) => api(`/api/me/paper-candidates/${id}/confirm`, { method: "POST" }),
  })
  const reject = useMutation<{ pending: number }, ApiError, string>({
    mutationFn: (id) => api(`/api/me/paper-candidates/${id}/reject`, { method: "POST" }),
  })
  // Which button is running, as "id:yes" or "id:no", so only that one disables.
  const [busy, setBusy] = useState<string | null>(null)

  async function decide(c: PaperCandidate, choice: "yes" | "no") {
    setBusy(`${c.id}:${choice}`)
    try {
      const res = choice === "yes" ? await confirm.mutateAsync(c.id) : await reject.mutateAsync(c.id)
      qc.setQueryData<CandidatesPayload>(CANDIDATES_KEY, (old) =>
        old ? { pending: res.pending, results: old.results.filter((r) => r.id !== c.id) } : old
      )
      if (choice === "yes") {
        void qc.invalidateQueries({ queryKey: ["me-publications"] })
        toast.ok("Added to your papers")
      } else {
        toast.ok("Removed from your list")
      }
    } catch (e) {
      toast.fail(e)
    } finally {
      setBusy(null)
    }
  }

  const data = list.data
  if (!data || data.pending === 0 || data.results.length === 0) return null

  const columns: Column<PaperCandidate>[] = [
    {
      key: "paper",
      header: "Paper",
      exportValue: (c) => c.publication.title,
      exportKind: "text",
      cell: (c) => (
        <div className="min-w-0">
          <p className="font-medium text-fg">
            <DetailLink kind="paper" id={c.publication.id}>
              {unshout(c.publication.title)}
            </DetailLink>
          </p>
          <p className="text-sm text-fg-muted">
            {[c.publication.venue, c.publication.year].filter(Boolean).join(", ") || "Venue not recorded"}
          </p>
        </div>
      ),
    },
    {
      key: "authors",
      header: "Authors",
      exportValue: (c) => c.publication.authors.join("; "),
      exportKind: "text",
      cell: (c) => {
        const names = c.publication.authors
        const shown = names.slice(0, 2)
        const more = (c.publication.author_count || names.length) - shown.length
        return (
          <span className="text-sm text-fg">
            {shown.map(firstName).join(", ")}
            {more > 0 && `, +${more} more`}
          </span>
        )
      },
    },
    {
      key: "answer",
      header: "Your answer",
      label: "Your answer",
      cell: (c) => (
        <div className="flex flex-wrap gap-2">
          <Button
            kind="default"
            size="sm"
            className="max-sm:h-10"
            disabled={busy !== null}
            aria-busy={busy === `${c.id}:yes` || undefined}
            onClick={() => void decide(c, "yes")}
          >
            This is mine
          </Button>
          <Button
            kind="quiet"
            size="sm"
            className="max-sm:h-10"
            disabled={busy !== null}
            aria-busy={busy === `${c.id}:no` || undefined}
            onClick={() => void decide(c, "no")}
          >
            Not mine
          </Button>
        </div>
      ),
    },
  ]

  return (
    <section aria-labelledby="unsure-papers" className="space-y-3">
      <div className="space-y-1">
        <h2 id="unsure-papers" className="text-base font-medium text-fg">
          Papers we are not sure about
        </h2>
        <p className="text-base text-fg-muted">
          These papers were once on your list because the name matched, but Scopus does not show them under your
          profile. Tell us which are yours.
        </p>
      </div>
      <p className="text-sm text-fg-muted">{data.pending} left</p>
      <Table<PaperCandidate>
        caption="Papers to confirm"
        rows={data.results}
        columns={columns}
        getKey={(c) => c.id}
        maxHeight="none"
        tools={{ id: "paper-candidates", title: "Papers to confirm" }}
      />
    </section>
  )
}
