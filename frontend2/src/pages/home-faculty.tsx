import { Link } from "react-router-dom"
import { motion } from "motion/react"
import { ArrowUpRight, Plus } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { money, Stage, stageOf } from "@/ui/paper"
import { cn } from "@/lib/cn"

/**
 * What a claimant opens the app to find out.
 *
 * 499 of the 525 accounts are faculty, and the question every one of them
 * arrives with is some version of "where is my money". So the first thing on
 * the page is the answer to that, in three numbers, and the second thing is
 * the list of their papers with each one's stage.
 *
 * Anything that needs them comes before anything that does not: a draft they
 * never filed and a ticket sent back for changes are the only two things on
 * this page that are somebody's homework, so they are called out above the
 * list rather than left to be found in it.
 */

type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  status: string
  remuneration: number | null
  publication_year: number | null
  updated_at: string | null
}

type Payload = { results: Claim[]; total: number }

export function FacultyHome() {
  const { me } = useAuth()
  const { data, isLoading } = useApi<Payload>(["my-claims"], "/api/claims?limit=200")

  const claims = data?.results || []
  const paid = claims.filter((c) => c.status === "PAID")
  const owed = claims.filter((c) =>
    [
      "CLEARED",
      "PRINCIPAL_APPROVED",
      "DIRECTOR_APPROVED",
      "FINANCE_APPROVED",
      "RESEARCH_APPROVED",
    ].includes(c.status)
  )
  const needsYou = claims.filter((c) => c.status === "DRAFT" || c.status === "REJECTED")
  // Whatever is not already called out above. Newest first, because a
  // settled paper from two years ago is not what somebody came to look at.
  const needsIds = new Set(needsYou.map((c) => c.id))
  const rest = claims
    .filter((c) => !needsIds.has(c.id))
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
  const received = paid.reduce((s, c) => s + (c.remuneration || 0), 0)
  const coming = owed.reduce((s, c) => s + (c.remuneration || 0), 0)

  const firstName = (me?.name || "").replace(/^(Dr|Mr|Ms|Mrs|Prof)\.?\s*/i, "").split(" ")[0]

  return (
    <div className="page space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>{firstName ? `Hello, ${firstName}` : "Your papers"}</PageTitle>
          <Sub className="mt-1">
            {isLoading
              ? "Loading your record…"
              : `${claims.length} paper${claims.length === 1 ? "" : "s"} on record`}
          </Sub>
        </div>
        <Button kind="primary" asChild>
          <Link to="/papers/new">
            <Plus />
            File a paper
          </Link>
        </Button>
      </header>

      {/* The money question, answered before anything else is shown. */}
      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
        <Figure label="Received to date" value={money(received)} muted={!received} />
        <Figure
          label="On the way"
          value={money(coming)}
          hint={owed.length ? `${owed.length} approved, not yet paid` : "Nothing in the chain"}
          muted={!coming}
        />
        <Figure
          label="Needs you"
          value={String(needsYou.length)}
          hint={needsYou.length ? "Drafts and sent-back papers" : "Nothing waiting on you"}
          muted={!needsYou.length}
        />
      </section>

      {needsYou.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-2"
        >
          <SectionTitle>Waiting on you</SectionTitle>
          <ul className="divide-y divide-line border-y border-line">
            {needsYou.map((c) => (
              <PaperRow key={c.id} claim={c} />
            ))}
          </ul>
        </motion.section>
      )}

      {/* The rest. When everything you have is already called out above,
          this repeats the list under a second heading and says nothing —
          so it is not drawn. */}
      <section className={cn("space-y-2", !rest.length && "hidden")}>
        <div className="flex items-baseline justify-between gap-3">
          <SectionTitle>{needsYou.length ? "Everything else" : "Your papers"}</SectionTitle>
          {rest.length > 12 && (
            <Link
              to="/papers"
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              See all {claims.length}
            </Link>
          )}
        </div>

        {isLoading ? (
          <ul className="divide-y divide-line border-y border-line">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="h-[3.25rem] animate-pulse bg-sunken" />
            ))}
          </ul>
        ) : rest.length === 0 ? (
          <div className="border-y border-line py-14 text-center">
            <p className="text-base">Nothing filed yet.</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-fg-muted">
              File a paper and it goes to the research cell to be checked, then to the
              Principal, then to Finance.
            </p>
            <Button kind="primary" asChild className="mt-4">
              <Link to="/papers/new">
                <Plus />
                File your first paper
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {rest.slice(0, 12).map((c) => (
              <PaperRow key={c.id} claim={c} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** A number that is an answer, not a tile. No box, no border — the label and
 *  the weight do the work a card was doing. */
function Figure({
  label,
  value,
  hint,
  muted,
}: {
  label: string
  value: string
  hint?: string
  muted?: boolean
}) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-2xl font-semibold tabular",
          muted && "text-fg-subtle"
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}

function PaperRow({ claim }: { claim: Claim }) {
  const stage = stageOf(claim.status)
  return (
    <li className="row">
      <Link
        to={`/papers/${claim.id}`}
        className="flex items-center gap-4 px-1 py-2.5 sm:px-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base">{claim.paper_title || "Untitled"}</span>
          <Meta className="block truncate">
            {[claim.journal_title, claim.publication_year, claim.ticket_number]
              .filter(Boolean)
              .join(" · ")}
          </Meta>
        </span>
        <span className="hidden w-24 shrink-0 text-right text-base tabular sm:block">
          {claim.remuneration ? money(claim.remuneration) : ""}
        </span>
        <Stage stage={stage} className="w-[7.5rem] shrink-0" />
        <ArrowUpRight className="reveal size-4 shrink-0 text-fg-subtle" aria-hidden />
      </Link>
    </li>
  )
}
