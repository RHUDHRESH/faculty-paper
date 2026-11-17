import { Link, useParams } from "react-router-dom"
import { ExternalLink, FilePlusCorner } from "lucide-react"

import { useCrumbLabel } from "@/app/crumbs"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { ClaimNo } from "@/ui/claim-number"
import { money } from "@/ui/paper"
import { PageHeader } from "@/ui/page-header"
import { Avatar, initialsOf } from "@/ui/person"
import { Section } from "@/ui/section"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import {
  fileClaimPath,
  papersWord,
  studentsWord,
  type TeamArticle,
  type TeamClaimHistory,
  type TeamDetail,
} from "@/pages/teams-types"

/**
 * One team: who is on it, the papers it has written, the claim on it, and for
 * its mentor the one thing to do next, which is to file the claim.
 *
 * The button is the server's call (`can_file`): the viewer is the mentor and
 * nothing holds the team. Everybody else, the office and a head included, can
 * read the page and cannot file for the mentor from here.
 */
export function TeamDetailPage() {
  const { code = "" } = useParams()
  const q = useApi<TeamDetail>(["teams", "detail", code], `/api/teams/${encodeURIComponent(code)}`)
  useCrumbLabel(q.data ? `Team ${q.data.code}` : undefined)

  if (q.isLoading) {
    return (
      <div className="page space-y-6">
        <SkeletonRows rows={6} rowHeight={48} />
      </div>
    )
  }
  if (q.isError || !q.data) {
    const missing = q.error?.status === 404
    return (
      <div className="page space-y-6">
        <ErrorState
          title={missing ? "No such team" : "Could not load this team"}
          message={
            missing
              ? "There is no team with this number that you may see. Check the number, or go back to the list."
              : "The server did not answer. Nothing has been lost."
          }
          onRetry={missing ? undefined : () => q.refetch()}
        />
        <Button kind="default" asChild>
          <Link to="/teams">Back to the teams</Link>
        </Button>
      </div>
    )
  }
  return <Team t={q.data} />
}

function Team({ t }: { t: TeamDetail }) {
  const held = t.claim
  return (
    <div className="page space-y-10">
      <PageHeader
        title={`Team ${t.code}`}
        sub={t.project_title || "No project title on the roster."}
        action={
          t.can_file ? (
            <Button kind="primary" asChild>
              <Link to={fileClaimPath(t.code)}>
                <FilePlusCorner aria-hidden />
                File the student-project claim
              </Link>
            </Button>
          ) : undefined
        }
      />

      {t.mine && !t.can_file && t.cannot_file_because && <p className="-mt-6 text-sm text-fg-muted">{t.cannot_file_because}</p>}

      <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Mentor">
          {t.mentor ? (
            <span className="flex min-w-0 items-center gap-2">
              <Avatar
                person={{
                  name: t.mentor.name ?? "",
                  initials: t.mentor.initials ?? initialsOf(t.mentor.name ?? ""),
                  photo_url: t.mentor.photo_url ?? null,
                }}
                size="sm"
              />
              <span className="min-w-0">
                <span className="block truncate">{t.mentor.name}</span>
                {t.mentor.staff_id && <Meta className="block">{t.mentor.staff_id}</Meta>}
              </span>
            </span>
          ) : (
            <span className="text-fg-muted">No mentor on the roster</span>
          )}
        </Fact>
        <Fact label="Department">{t.department || <span className="text-fg-muted">Not recorded</span>}</Fact>
        <Fact label="Academic year">{t.academic_year || <span className="text-fg-muted">Not recorded</span>}</Fact>
        <Fact label="Claim">
          {held ? (
            <span className="flex flex-wrap items-center gap-2">
              <Link to={held.url} className="hover:underline">
                <ClaimNo value={held.ticket_number} copy={false} />
              </Link>
              <Chip tone="neutral">{held.stage}</Chip>
            </span>
          ) : (
            <span className="text-fg-muted">Not claimed</span>
          )}
        </Fact>
      </dl>

      <Section title={`Students (${t.students.length})`}>
        {t.students.length === 0 ? (
          <p className="text-sm text-caution">No students are listed on this team.</p>
        ) : (
          <Table<TeamDetail["students"][number]>
            caption="Students on this team"
            rows={t.students}
            columns={STUDENT_COLUMNS}
            getKey={(s) => `${s.reg_no ?? ""}-${s.name}`}
            stack
            minWidth="28rem"
          />
        )}
      </Section>

      <Section title={`Papers (${t.publications.length})`}>
        {t.publications.length === 0 ? (
          <p className="text-sm text-fg-muted">The roster lists no paper for this team yet.</p>
        ) : (
          <Table<TeamArticle>
            caption={`Papers of team ${t.code}`}
            rows={t.publications}
            columns={PAPER_COLUMNS}
            getKey={(p) => `${p.doi ?? p.scopus_eid ?? p.article_title ?? ""}`}
            stack
            minWidth="44rem"
          />
        )}
      </Section>

      <Section title="Claims on this team">
        {t.claims.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No claim has been filed on this team.
            {t.can_file ? " You can file it now." : ""}
          </p>
        ) : (
          <Table<TeamClaimHistory>
            caption={`Claims on team ${t.code}`}
            rows={t.claims}
            columns={claimColumns(t.claims.some((c) => c.amount != null))}
            getKey={(c) => c.id}
            stack
            minWidth="40rem"
          />
        )}
        <Meta className="mt-2 block">
          {studentsWord(t.student_count)}, {papersWord(t.publications_count)}. A team is claimed once: a claim holds it until
          it is withdrawn or rejected.
        </Meta>
      </Section>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words">{children}</dd>
    </div>
  )
}

const STUDENT_COLUMNS: Column<TeamDetail["students"][number]>[] = [
  {
    key: "reg_no",
    header: "Register number",
    empty: "No register number",
    exportValue: (s) => s.reg_no,
    cell: (s) => <span className="tabular">{s.reg_no}</span>,
  },
  { key: "name", header: "Name", exportValue: (s) => s.name, cell: (s) => s.name },
]

function dateOf(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

const doiUrl = (p: TeamArticle) => (p.doi ? `https://doi.org/${p.doi}` : null)

const PAPER_COLUMNS: Column<TeamArticle>[] = [
  {
    key: "title",
    header: "Paper",
    empty: "No title",
    cell: (p) =>
      p.article_link ? (
        <a href={p.article_link} target="_blank" rel="noreferrer" className="hover:underline">
          {p.article_title}
        </a>
      ) : (
        p.article_title
      ),
  },
  { key: "journal", header: "Journal or conference", empty: "Not recorded", cell: (p) => p.source_title },
  {
    key: "doi",
    header: "DOI",
    empty: "No DOI",
    cell: (p) =>
      doiUrl(p) ? (
        <a href={doiUrl(p)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-accent hover:underline">
          {p.doi}
          <ExternalLink aria-hidden className="size-3.5 shrink-0" />
        </a>
      ) : null,
  },
  {
    key: "scopus",
    header: "Scopus",
    empty: "Not linked",
    cell: (p) =>
      p.scopus_link ? (
        <a href={p.scopus_link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
          Open in Scopus
          <ExternalLink aria-hidden className="size-3.5 shrink-0" />
        </a>
      ) : null,
  },
  {
    key: "date",
    header: "Date",
    empty: "No date",
    cell: (p) => <span className="tabular">{dateOf(p.publication_date)}</span>,
  },
]

function claimColumns(withMoney: boolean): Column<TeamClaimHistory>[] {
  const cols: Column<TeamClaimHistory>[] = [
    {
      key: "number",
      header: "Claim",
      cell: (c) => (
        <Link to={c.url} className="hover:underline">
          <ClaimNo value={c.ticket_number} copy={false} />
        </Link>
      ),
    },
    {
      key: "stage",
      header: "Stage",
      cell: (c) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Chip tone="neutral">{c.stage}</Chip>
          {c.holds_team && <Meta>Holds the team</Meta>}
        </span>
      ),
    },
    { key: "owner", header: "Filed by", empty: "Not recorded", cell: (c) => c.owner_name },
    { key: "paper", header: "Paper", truncate: true, empty: "No title yet", cell: (c) => c.paper_title },
    { key: "filed", header: "Filed on", empty: "Not filed", cell: (c) => <span className="tabular">{dateOf(c.submitted_at)}</span> },
  ]
  if (withMoney) {
    cols.push({
      key: "amount",
      header: "Amount",
      align: "right",
      empty: "Not worked out",
      cell: (c) => (c.amount != null ? <span className="tabular">{money(c.amount)}</span> : null),
    })
  }
  return cols
}
