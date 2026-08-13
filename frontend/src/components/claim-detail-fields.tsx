import { InsetList, InsetRow, Section } from "@/components/layout/page"
import { Money } from "@/components/ticket-ui"
import type { Claim } from "@/lib/api"

/** Older claims stored this inside authors_json, before it had its own column. */
function parseReferenceArticles(claim: Claim): string {
  if (claim.reference_articles) return claim.reference_articles
  const authorsJson = claim.authors_json
  if (!authorsJson) return ""
  try {
    const parsed = JSON.parse(authorsJson)
    if (typeof parsed === "string") return parsed
    if (parsed?.reference_articles) return String(parsed.reference_articles)
  } catch {
    return authorsJson
  }
  return ""
}

function DocLink({ url, label }: { url?: string | null; label: string }) {
  if (!url) return <span className="text-muted-foreground">—</span>
  return (
    <a
      className="text-sm text-primary underline-offset-4 hover:underline"
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      {label}
    </a>
  )
}

/** Every uploaded PDF of a kind, falling back to the legacy single-URL column. */
function DocLinks({
  claim,
  kind,
  fallbackUrl,
  label,
}: {
  claim: Claim
  kind: "PUBLISHED_PAPER" | "SEC_REFERENCE"
  fallbackUrl?: string | null
  label: string
}) {
  const files = (claim.attachments || []).filter((a) => a.kind === kind)
  if (!files.length) return <DocLink url={fallbackUrl} label={label} />
  return (
    <span className="flex flex-wrap justify-end gap-x-3 gap-y-1">
      {files.map((f, i) => (
        <a
          key={f.id}
          className="text-sm text-primary underline-offset-4 hover:underline"
          href={f.url}
          target="_blank"
          rel="noreferrer"
        >
          {f.filename || `${label} ${i + 1}`}
        </a>
      ))}
    </span>
  )
}

export function ClaimDetailFields({ claim, showOwner = false }: { claim: Claim; showOwner?: boolean }) {
  const referenceArticles = parseReferenceArticles(claim)
  const countOnly = claim.claim_reason === "COUNT_ONLY"

  return (
    <div className="space-y-4">
      {showOwner ? (
        <Section title="Faculty identity">
          <InsetList>
            <InsetRow label="Email">{claim.owner_email || "—"}</InsetRow>
            <InsetRow label="Name">{claim.owner_name || "—"}</InsetRow>
            <InsetRow label="Department">{claim.owner_department || "—"}</InsetRow>
            <InsetRow label="Staff ID">{claim.staff_id || "—"}</InsetRow>
            <InsetRow label="Biometric ID">{claim.biometric_id || "—"}</InsetRow>
            <InsetRow label="Designation">{claim.designation || "—"}</InsetRow>
            <InsetRow label="Scopus author link">
              {claim.scopus_author_url ?
                <a
                  className="text-sm text-primary underline-offset-4 hover:underline"
                  href={claim.scopus_author_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open profile
                </a>
              : "—"}
            </InsetRow>
          </InsetList>
        </Section>
      ) : null}

      <Section title="Publication">
        <InsetList>
          <InsetRow label="Paper title">{claim.paper_title || "—"}</InsetRow>
          <InsetRow label="Journal">{claim.journal_title || "—"}</InsetRow>
          <InsetRow label="Quartile">{claim.quartile || claim.self_reported_quartile || "—"}</InsetRow>
          <InsetRow label="ISSN">{claim.issn || "—"}</InsetRow>
          <InsetRow label="Yukthi ID">{claim.yukthi_id || "—"}</InsetRow>
          <InsetRow label="Publication date">{claim.publication_date || "—"}</InsetRow>
          <InsetRow label="Year">{claim.publication_year ?? "—"}</InsetRow>
          <InsetRow label="Type">{claim.publication_type || claim.aggregation_type || "—"}</InsetRow>
          <InsetRow label="Indexing level">{claim.indexing_level || "—"}</InsetRow>
          <InsetRow label="AU / UGC ref">{claim.indexing_ref || "—"}</InsetRow>
          <InsetRow label="DOI">{claim.doi || "—"}</InsetRow>
          <InsetRow label="Subject">{claim.subject_category || "—"}</InsetRow>
        </InsetList>
      </Section>

      <Section title="Authors & metrics">
        <InsetList>
          <InsetRow label="Claim reason">
            {countOnly ? "Option B — publication count only" : "Option A — incentive claim"}
          </InsetRow>
          <InsetRow label="Total authors">{claim.total_authors ?? "—"}</InsetRow>
          <InsetRow label="Author position">{claim.author_position ?? "—"}</InsetRow>
          <InsetRow label="SNIP">{claim.snip ?? "—"}</InsetRow>
          <InsetRow label="Impact factor">{claim.impact_factor || "—"}</InsetRow>
          <InsetRow label="Student publication">{claim.is_student_publication ? "Yes" : "No"}</InsetRow>
          <InsetRow label="Affiliation confirmed">{claim.affiliation_ok !== false ? "Yes" : "No"}</InsetRow>
          <InsetRow label="Estimated amount">
            <Money value={claim.remuneration} />
          </InsetRow>
        </InsetList>
      </Section>

      <Section title="Documents & references">
        <InsetList>
          <InsetRow label="Published paper">
            <DocLinks
              claim={claim}
              kind="PUBLISHED_PAPER"
              fallbackUrl={claim.proof_url}
              label="View proof"
            />
          </InsetRow>
          <InsetRow label="SEC reference numbers">{claim.sec_refs || "—"}</InsetRow>
          <InsetRow label="Reference articles">
            <span className="whitespace-pre-line">{referenceArticles || "—"}</span>
          </InsetRow>
          <InsetRow label="SEC reference PDFs">
            <DocLinks
              claim={claim}
              kind="SEC_REFERENCE"
              fallbackUrl={claim.sec_proof_url}
              label="Reference"
            />
          </InsetRow>
        </InsetList>
      </Section>
    </div>
  )
}
