import { useMemo, useState } from "react"
import { stageName } from "@/ui/journey"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { ExternalLink, FileSearch, Pencil, UserRound } from "lucide-react"

import { useCrumbLabel } from "@/app/crumbs"
import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input } from "@/ui/field"
import { money } from "@/ui/paper"
import { Avatar } from "@/ui/person"
import { ScopusProfileCard } from "@/ui/scopus"
import { Callout, EmptyState, ErrorState, SkeletonRows, SkeletonText } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import {
  MISSING_WORDS,
  count,
  monthLabel,
  paperDate,
  type FacultyRecordPayload,
  type RecordClaim,
  type RecordPaper,
} from "@/pages/faculty-types"

/**
 * One faculty member, everything held on them: identifiers, every paper on
 * the record with where its claim stands, every claim, the payments (for
 * those who may see money), their research and their details.
 *
 * The office opens anybody; a head opens their own department; a faculty
 * member opens their own (`/faculty/me`) and sees it just the same. The
 * server shapes the payload for the reader, so a section that is not theirs
 * (`payments`) is simply null and its tab is not drawn.
 */

type TabId = "papers" | "claims" | "payments" | "research" | "details"

export function FacultyRecord() {
  const { id = "me" } = useParams()
  const [params, setParams] = useSearchParams()
  const q = useApi<FacultyRecordPayload>(["faculty-record", id], `/api/directory/faculty/${id}`)
  // The breadcrumb reads "Faculty / Dr A Athiraja", not "Faculty record".
  useCrumbLabel(q.data?.person.name)

  if (q.isLoading) {
    return (
      <div className="page space-y-6" aria-busy="true">
        <SkeletonText lines={2} />
        <SkeletonRows rows={6} rowHeight={56} />
      </div>
    )
  }
  if (q.isError || !q.data) {
    const denied = q.error?.status === 403
    return (
      <div className="page">
        <ErrorState
          title={denied ? "This record is not open to you" : q.error?.status === 404 ? "No such person" : "Could not load this record"}
          message={
            denied
              ? "You can open your own record, and your department's if you head one."
              : q.error?.status === 404
                ? "This link does not lead to anybody on the roster."
                : "The server did not answer. Nothing has been lost."
          }
          onRetry={denied ? false : () => q.refetch()}
        />
      </div>
    )
  }

  const d = q.data
  const self = d.viewer.is_self
  // The person opening their own record already has My papers, My research and
  // Your profile for those three things. Repeating the paper list, the topics
  // and the details here made four places to read the same 145 papers.
  const tabs: { id: TabId; label: string }[] = self
    ? [
        { id: "claims", label: `Claims (${count(d.claims.length)})` },
        ...(d.payments ? [{ id: "payments" as TabId, label: "Payments" }] : []),
      ]
    : [
        { id: "papers", label: `Papers (${count(d.papers.length)})` },
        { id: "claims", label: `Claims (${count(d.claims.length)})` },
        ...(d.payments ? [{ id: "payments" as TabId, label: "Payments" }] : []),
        { id: "research", label: "Research" },
        { id: "details", label: "Details" },
      ]
  const wanted = params.get("tab") as TabId | null
  const tab: TabId = tabs.some((t) => t.id === wanted) ? (wanted as TabId) : tabs[0].id

  return (
    <div className="page space-y-6">
      <Header d={d} />

      {d.viewer.may_edit && d.person.missing.length > 0 && (
        <Callout tone="caution" title="This record is missing something">
          {d.person.missing.map((m) => MISSING_WORDS[m].toLowerCase()).join(", ")}.
          {d.person.missing.includes("photo") && " Only they can add a photo."}
          <div className="mt-2">
            <Button kind="default" size="sm" asChild>
              <Link to={`/people/${d.person.id}`}>Open the account to fix it</Link>
            </Button>
          </div>
        </Callout>
      )}

      <Figures d={d} tabs={tabs.map((t) => t.id)} />

      <div role="tablist" aria-label="Faculty record" className="flex gap-1 overflow-x-auto border-b border-line" data-area="research">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() =>
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev)
                  if (t.id === "papers") next.delete("tab")
                  else next.set("tab", t.id)
                  return next
                },
                { replace: true }
              )
            }
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm",
              tab === t.id ? "border-(--area) font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "papers" && <PapersTab d={d} />}
        {tab === "claims" && <ClaimsTab d={d} />}
        {tab === "payments" && d.payments && <PaymentsTab d={d} />}
        {tab === "research" && <ResearchTab d={d} />}
        {tab === "details" && <DetailsTab d={d} />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Header and figures                                                       */
/* ------------------------------------------------------------------------ */

function Ext({ href, children, label }: { href: string; children: React.ReactNode; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      className="inline-flex items-center gap-1 text-fg underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5 text-fg-subtle" />
    </a>
  )
}

function Header({ d }: { d: FacultyRecordPayload }) {
  const p = d.person
  const editor = d.viewer.may_edit
  const threshold = p.threshold_set
    ? p.threshold != null
      ? `Threshold ${p.threshold} papers a year`
      : "Threshold set"
    : "Threshold not set"
  return (
    <header className="space-y-5 border-b border-line pb-6">
      <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
        <Avatar person={p} size="xl" />
        <div className="min-w-0 flex-1 basis-64">
          <PageTitle>{p.name}</PageTitle>
          <Sub className="mt-1">
            {[p.designation, p.department].filter(Boolean).join(" · ") || "No designation or department on record"}
          </Sub>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Chip tone={p.faculty_type === "RESEARCH" ? "area" : "neutral"} area={p.faculty_type === "RESEARCH" ? "research" : undefined}>
              {p.faculty_type === "RESEARCH" ? "Research faculty" : "Regular faculty"}
            </Chip>
            {p.faculty_type === "RESEARCH" && (
              <Meta className={cn(!p.threshold_set && "text-caution")}>
                {threshold}
              </Meta>
            )}
            {p.faculty_type === "RESEARCH" && editor && (
              <Button kind="quiet" size="sm" asChild>
                <Link to={`/people/${p.id}`}>{p.threshold_set ? "Change threshold" : "Set threshold"}</Link>
              </Button>
            )}
            {p.role === "HOD" && <Chip>Head of department</Chip>}
            {!p.active && <Chip tone="caution">No longer at the college</Chip>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editor && (
            <Button asChild kind="primary" size="md">
              <Link to={`/people/${p.id}`}>
                <Pencil />
                Edit account
              </Link>
            </Button>
          )}
          {d.viewer.is_self && (
            <Button asChild kind={editor ? "default" : "primary"} size="md">
              <Link to="/me">
                <Pencil />
                Edit your profile
              </Link>
            </Button>
          )}
          <Button asChild kind="quiet" size="md">
            <Link to={`/u/${p.id}`}>
              <UserRound />
              Public profile
            </Link>
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:gap-x-8 lg:grid-cols-4">
        <Ident label="Staff ID">{p.staff_id ? <span className="tabular">{p.staff_id}</span> : <Missing />}</Ident>
        <Ident label="Scopus ID">
          {p.scopus_author_id ? (
            <Ext href={p.scopus_url ?? "#"} label={`Scopus author page for ${p.name}`}>
              <span className="tabular">{p.scopus_author_id}</span>
            </Ext>
          ) : (
            <Missing>
              {editor ? (
                <Button kind="quiet" size="sm" asChild>
                  <Link to={`/people/${p.id}`}>Add Scopus ID</Link>
                </Button>
              ) : null}
            </Missing>
          )}
        </Ident>
        <Ident label="ORCID">
          {p.orcid_id ? (
            <Ext href={p.orcid_url ?? "#"} label={`ORCID page for ${p.name}`}>
              <span className="tabular">{p.orcid_id}</span>
            </Ext>
          ) : (
            <Missing />
          )}
        </Ident>
        <Ident label="Department">{p.department || <Missing />}</Ident>
        {p.email && (
          <Ident label="Email" wide>
            <a href={`mailto:${p.email}`} className="break-all underline-offset-2 hover:underline">
              {p.email}
            </a>
          </Ident>
        )}
        {(d.viewer.may_edit || d.viewer.is_self) && (
          <Ident label="Phone">{p.phone || <Missing />}</Ident>
        )}
        {p.employee_id && (
          <Ident label="Employee ID">
            <span className="tabular">{p.employee_id}</span>
          </Ident>
        )}
      </dl>
    </header>
  )
}

function Ident({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2 sm:col-span-1")}>
      <dt>
        <ColumnLabel>{label}</ColumnLabel>
      </dt>
      <dd className="mt-0.5 min-w-0 text-base">{children}</dd>
    </div>
  )
}

function Missing({ children }: { children?: React.ReactNode }) {
  return (
    <span className="text-fg-muted">
      Not on record{children ? <> · {children}</> : null}
    </span>
  )
}

function Figures({ d, tabs }: { d: FacultyRecordPayload; tabs: string[] }) {
  const year = d.viewer.year
  const filed = d.claims.filter((c) => c.filed_on?.startsWith(String(year))).length
  const at = (tab: string) => (tabs.includes(tab) ? `/faculty/${d.person.id}?tab=${tab}` : undefined)
  const self = d.viewer.is_self
  // The same rule as My papers "Not claimed": eligible, with no live claim.
  const ready = d.papers.filter((p) => !p.claim && p.eligible).length
  return (
    <Answer
      items={[
        {
          value: d.metrics.total_publications,
          label: `Papers on record, ${count(d.metrics.papers_this_year)} in ${year}`,
          to: self ? "/papers" : `/faculty/${d.person.id}`,
        },
        { value: d.metrics.total_citations, label: `Citations, h-index ${count(d.metrics.h_index)}`, to: self ? "/research" : at("research") },
        self
          ? {
              value: ready,
              label: ready === 1 ? "paper ready to claim" : "papers ready to claim",
              zero: "Every paper is claimed",
              to: "/papers?tab=unclaimed",
            }
          : {
              value: filed,
              label: `Claims filed in ${year}, ${count(d.claims.length)} in all`,
              zero: `No claim filed in ${year}`,
              to: at("claims"),
            },
        ...(d.payments
          ? [
              {
                value: money(d.payments.this_year.amount),
                label: `Incentives paid in ${d.payments.year}, ${money(d.payments.total_amount)} in all`,
                to: at("payments"),
              },
            ]
          : []),
      ]}
    />
  )
}
/* ------------------------------------------------------------------------ */
/* Papers                                                                   */
/* ------------------------------------------------------------------------ */

const STEP = 40

const QUARTILE_OPTIONS: ComboboxOption[] = [
  { value: "", label: "Any quartile" },
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
  { value: "none", label: "Quartile not recorded" },
]

const CLAIM_OPTIONS: ComboboxOption[] = [
  { value: "", label: "With or without a claim" },
  { value: "claimed", label: "Claimed" },
  { value: "not", label: "No claim filed" },
]

function PapersTab({ d }: { d: FacultyRecordPayload }) {
  const [text, setText] = useState("")
  const [quartile, setQuartile] = useState("")
  const [claimed, setClaimed] = useState("")
  const [shown, setShown] = useState(STEP)

  const rows = useMemo(() => {
    const t = text.trim().toLowerCase()
    return d.papers.filter((p) => {
      if (t && !`${p.title} ${p.venue ?? ""}`.toLowerCase().includes(t)) return false
      if (quartile === "none" ? p.quartile : quartile && p.quartile?.toUpperCase() !== quartile) return false
      if (claimed === "claimed" && !p.claim) return false
      if (claimed === "not" && p.claim) return false
      return true
    })
  }, [d.papers, text, quartile, claimed])

  if (d.papers.length === 0) {
    return (
      <EmptyState
        illustration="empty-no-papers"
        title="No papers on record"
        message="Nothing has been matched to this person yet."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 max-sm:[&>*]:w-full max-sm:[&>*]:max-w-none">
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setShown(STEP)
          }}
          placeholder="Search title or journal"
          aria-label="Search this person's papers"
          className="w-full max-w-xs"
        />
        <Combobox value={quartile} onChange={(v) => { setQuartile(v); setShown(STEP) }} options={QUARTILE_OPTIONS} aria-label="Filter by quartile" className="w-48" />
        <Combobox value={claimed} onChange={(v) => { setClaimed(v); setShown(STEP) }} options={CLAIM_OPTIONS} aria-label="Filter by claim" className="w-44" />
      </div>
      <Meta className="block" aria-live="polite">
        Showing {count(Math.min(shown, rows.length))} of {count(rows.length)}
        {rows.length !== d.papers.length ? ` matching papers, ${count(d.papers.length)} on record` : " papers on record"}.
      </Meta>
      {rows.length === 0 ? (
        <EmptyState illustration="empty-no-results" title="No paper matches" message="Try a shorter search, or clear the filters." />
      ) : (
        <ul aria-label="Papers" className="divide-y divide-line border-y border-line">
          {rows.slice(0, shown).map((p) => (
            <PaperRow key={p.id} p={p} />
          ))}
        </ul>
      )}
      {shown < rows.length && (
        <Button kind="default" size="md" onClick={() => setShown((s) => s + STEP)}>
          Show {Math.min(STEP, rows.length - shown)} more
        </Button>
      )}
    </div>
  )
}

function PaperRow({ p }: { p: RecordPaper }) {
  const title = paperTitle(p.title)
  const meta = [
    paperDate(p.date, p.year),
    p.venue,
    p.author_position ? `Author ${p.author_position}${p.total_authors ? ` of ${p.total_authors}` : ""}` : null,
    p.corresponding ? "Corresponding author" : null,
    p.citations != null ? `Cited ${count(p.citations)}` : null,
  ].filter(Boolean)
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-72">
        <p className="text-base font-medium leading-snug">
          {p.doi ? (
            <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              {title}
            </a>
          ) : (
            title
          )}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
          {p.quartile && <Chip tone={p.quartile.toUpperCase() === "Q1" ? "positive" : "neutral"}>{p.quartile.toUpperCase()}</Chip>}
          <span className="min-w-0 break-words">{meta.join(" · ")}</span>
        </div>
      </div>
      <ClaimState p={p} />
    </li>
  )
}

/** A number imported from the old ERP says so; "ERP-RAW-3" means nothing to a reader. */
export function claimNoLabel(no: string): string {
  return no.startsWith("ERP-") ? `Old ERP, ${no.replace(/^ERP-/, "")}` : no
}

function ClaimState({ p }: { p: RecordPaper }) {
  if (p.claim) {
    const paid = p.claim.stage === "Paid" || p.claim.stage === "Completed"
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:justify-end sm:text-right">
        <Chip tone={paid ? "positive" : "neutral"}>{p.claim.stage}</Chip>
        {p.claim.amount != null &&
          (p.claim.amount > 0 ? (<span className="tabular text-sm">{money(p.claim.amount)}</span>) : (<Meta>No incentive payable</Meta>))}
        {p.claim.claim_no &&
          (p.claim.review_path ? (
            <Link to={p.claim.review_path} className="text-sm underline underline-offset-2">
              {claimNoLabel(p.claim.claim_no)}
            </Link>
          ) : (
            <Meta>{claimNoLabel(p.claim.claim_no)}</Meta>
          ))}
      </div>
    )
  }
  if (!p.eligible) return <Chip tone="caution">Too many authors to claim</Chip>
  return <Meta>No claim filed</Meta>
}

/* ------------------------------------------------------------------------ */
/* Claims                                                                   */
/* ------------------------------------------------------------------------ */

function ClaimsTab({ d }: { d: FacultyRecordPayload }) {
  if (d.claims.length === 0) {
    return (
      <EmptyState
        illustration="empty-no-papers"
        title="No claims filed"
        message={
          d.payments && d.payments.count > 0
            ? "Nothing was filed through this system. Payments made earlier are listed under Payments."
            : d.viewer.is_self
              ? "When you file a claim for a paper it is listed here with where it stands."
              : "This person has not filed a claim yet."
        }
      />
    )
  }
  const earlier = d.viewer.is_self && d.payments && d.payments.count > d.claims.length
  return (
    <div className="space-y-3">
      {earlier && (
        <p className="text-sm text-fg-muted">
          These are the claims filed in this system. Payments made before it are listed under{" "}
          <Link to="/faculty/me?tab=payments" className="underline underline-offset-2">
            Payments
          </Link>
          .
        </p>
      )}
      <ul aria-label="Claims" className="divide-y divide-line border-y border-line">
        {d.claims.map((c) => (
          <ClaimRow key={c.id} c={c} self={d.viewer.is_self} />
        ))}
      </ul>
    </div>
  )
}

/**
 * One claim on the record. A paid claim is a quiet word, not a chip: eight
 * green chips down a column say "paid" eight times. When the person is reading
 * their own record the stage is in the college's words ("Being checked"), an
 * old-workbook number is not shown as if it were a claim number they know, and
 * a zero on a paid claim (the workbook did not record the amount) is left
 * unsaid; the statement holds what was actually paid.
 */
function ClaimRow({ c, self }: { c: RecordClaim; self?: boolean }) {
  const paid = c.stage === "Paid" || c.stage === "Completed"
  const stage = self ? stageName(c.stage) : c.stage
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-72">
        <p className="text-base font-medium leading-snug">{paperTitle(c.title)}</p>
        <Meta className="mt-1 block break-words">
          {[c.journal, c.year, c.quartile, c.filed_on ? `Filed ${paperDate(c.filed_on, null)}` : null]
            .filter(Boolean)
            .join(" · ")}
        </Meta>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:justify-end">
        {c.claim_no &&
          (c.review_path ? (
            <Link to={c.review_path} className="inline-flex items-center gap-1 text-sm underline underline-offset-2">
              <FileSearch aria-hidden className="size-3.5" />
              {claimNoLabel(c.claim_no)}
            </Link>
          ) : (
            <span className="tabular text-sm text-fg-muted">{claimNoLabel(c.claim_no)}</span>
          ))}
        {paid && self ? (
          <span className="text-sm text-fg-muted">Paid</span>
        ) : (
          <Chip tone={paid ? "positive" : "neutral"}>{stage}</Chip>
        )}
        {c.amount != null && !(self && paid && c.amount === 0) && (
          <span className="tabular text-sm font-medium">{money(c.amount)}</span>
        )}
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Payments                                                                 */
/* ------------------------------------------------------------------------ */

function PaymentsTab({ d }: { d: FacultyRecordPayload }) {
  const pay = d.payments!
  if (pay.rows.length === 0) {
    return (
      <EmptyState
        illustration="empty-no-payouts"
        title="No incentives paid yet"
        message="Payments appear here once a claim has been paid."
      />
    )
  }
  return (
    <div className="space-y-4">
      <p className="text-base">
        <span className="tabular font-semibold">{money(pay.total_amount)}</span> paid in {count(pay.count)} payments,{" "}
        <span className="tabular font-semibold">{money(pay.this_year.amount)}</span> of it in {pay.year}.
        {d.viewer.is_self && (
          <>
            {" "}
            <Button kind="default" size="sm" asChild>
              <Link to="/papers/statement">Open the statement by financial year</Link>
            </Button>
          </>
        )}
      </p>
      <ul aria-label="Payments" className="divide-y divide-line border-y border-line">
        {pay.rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 py-3">
            <div className="min-w-0 flex-1 basis-72">
              <p className="text-base leading-snug">{paperTitle(r.title)}</p>
              <Meta className="mt-0.5 block break-words">
                {[monthLabel(r.month), r.journal, r.voucher ? `Voucher ${r.voucher}` : null].filter(Boolean).join(" · ")}
              </Meta>
            </div>
            <span className="tabular text-base font-medium">{money(r.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Research                                                                 */
/* ------------------------------------------------------------------------ */

function ResearchTab({ d }: { d: FacultyRecordPayload }) {
  const r = d.research
  const peak = Math.max(1, ...r.by_year.map((y) => y.papers))
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 lg:grid-cols-2">
      <section className="space-y-3">
        <SectionTitle>Papers by year</SectionTitle>
        {r.by_year.length === 0 ? (
          <Meta>No dated papers yet.</Meta>
        ) : (
          <ol className="space-y-1.5" aria-label="Papers by year">
            {[...r.by_year].reverse().map((y) => (
              <li key={y.year} className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-3 text-sm">
                <span className="tabular text-fg-muted">{y.year}</span>
                <span className="h-2 rounded-full bg-hover">
                  <span
                    className="block h-2 rounded-full bg-(--area)"
                    style={{ width: `${Math.max(4, (y.papers / peak) * 100)}%` }}
                  />
                </span>
                <span className="tabular text-right text-fg-muted">
                  {y.papers} {y.papers === 1 ? "paper" : "papers"}, {count(y.citations)} cited
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="space-y-6">
        <div className="space-y-2">
          <SectionTitle>Quartiles</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {r.quartiles.map((qz) => (
              <Chip key={qz.name} tone={qz.name === "Q1" ? "positive" : "neutral"}>
                {qz.name} · {qz.papers}
              </Chip>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <SectionTitle>Topics</SectionTitle>
          {r.topics.length === 0 ? (
            <Meta>No topics recorded for these papers.</Meta>
          ) : (
            <div className="flex flex-wrap gap-2">
              {r.topics.map((t) => (
                <Chip key={t.name}>
                  {t.name} · {t.papers}
                </Chip>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-2">
          <SectionTitle>Scopus profile</SectionTitle>
          <ScopusProfileCard profile={r.scopus_profile} emptyMessage="No Scopus profile has been imported for this person yet." />
        </div>
      </section>

      <section className="space-y-3 lg:col-span-2">
        <SectionTitle>Writes with</SectionTitle>
        {r.coauthors_inside.length === 0 && r.coauthors_outside.length === 0 ? (
          <Meta>No co-authors on the record yet.</Meta>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-6 lg:grid-cols-2">
            <ul aria-label="Co-authors at the college" className="space-y-1">
              {r.coauthors_inside.map((c) => (
                <li key={c.user_id ?? c.name} className="flex min-w-0 items-center gap-3 py-1.5">
                  <Avatar person={{ name: c.name, initials: c.initials ?? "", photo_url: c.photo_url ?? null }} size="md" />
                  <span className="min-w-0 flex-1">
                    {c.user_id ? (
                      <Link to={`/u/${c.user_id}`} className="block truncate text-base font-medium hover:underline">
                        {c.name}
                      </Link>
                    ) : (
                      <span className="block truncate text-base font-medium">{c.name}</span>
                    )}
                    <Meta className="block truncate">
                      {[c.department, `${c.papers_together} ${c.papers_together === 1 ? "paper" : "papers"} together`]
                        .filter(Boolean)
                        .join(" · ")}
                    </Meta>
                  </span>
                </li>
              ))}
            </ul>
            {r.coauthors_outside.length > 0 && (
              <ul aria-label="Co-authors outside the college" className="space-y-1">
                {r.coauthors_outside.map((c) => (
                  <li key={c.key} className="min-w-0 py-1.5">
                    <span className="block truncate text-base">{c.name}</span>
                    <Meta className="block break-words">
                      {[c.institutions[0], `${c.papers_together} ${c.papers_together === 1 ? "paper" : "papers"} together`]
                        .filter(Boolean)
                        .join(" · ")}
                    </Meta>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Details                                                                  */
/* ------------------------------------------------------------------------ */

function DetailsTab({ d }: { d: FacultyRecordPayload }) {
  const det = d.details
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <SectionTitle>About</SectionTitle>
        {det.bio ? <p className="max-w-prose text-pretty text-base">{det.bio}</p> : <Meta>No bio written yet.</Meta>}
      </section>
      <section className="space-y-2">
        <SectionTitle>Research areas</SectionTitle>
        {det.interests.length === 0 ? (
          <Meta>None chosen yet.</Meta>
        ) : (
          <div className="flex flex-wrap gap-2">
            {det.interests.map((i) => (
              <Chip key={i}>{i}</Chip>
            ))}
          </div>
        )}
        {det.skills.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {det.skills.map((s) => (
              <Chip key={s}>{s}</Chip>
            ))}
          </div>
        )}
      </section>
      <section className="space-y-2">
        <SectionTitle>Profile changes</SectionTitle>
        {!det.changes_visible ? (
          <Meta>The history of changes to this profile is visible to the research office and to the person.</Meta>
        ) : det.changes.length === 0 ? (
          <Meta>No changes have been asked for on this profile.</Meta>
        ) : (
          <ul aria-label="Profile changes" className="divide-y divide-line border-y border-line">
            {det.changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 py-3">
                <div className="min-w-0 flex-1 basis-72">
                  <p className="text-base">
                    {c.field}: <span className="text-fg-muted">{c.from || "empty"}</span> to{" "}
                    <span className="font-medium">{c.to}</span>
                  </p>
                  {(c.note || c.decision_note) && <Meta className="mt-0.5 block">{c.decision_note || c.note}</Meta>}
                </div>
                <div className="flex items-center gap-3 text-sm text-fg-muted">
                  <Chip tone={c.state === "Applied" ? "positive" : c.state === "Declined" ? "caution" : "neutral"}>{c.state}</Chip>
                  <span>Asked {paperDate(c.asked_on, null)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {det.joined && <Meta className="block">On the roster since {paperDate(det.joined, null)}.</Meta>}
    </div>
  )
}
