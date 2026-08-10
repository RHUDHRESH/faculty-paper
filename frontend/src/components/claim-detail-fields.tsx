import { InsetList, InsetRow, Section } from "@/components/layout/page"
import { Money } from "@/components/ticket-ui"
import type { Claim } from "@/lib/api"

function parseReferenceArticles(authorsJson?: string | null): string {
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

export function ClaimDetailFields({ claim, showOwner = false }: { claim: Claim; showOwner?: boolean }) {
  const referenceArticles = parseReferenceArticles(claim.authors_json)

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
          <InsetRow label="Proof PDF">
            <DocLink url={claim.proof_url} label="View proof" />
          </InsetRow>
          <InsetRow label="SEC reference numbers">{claim.sec_refs || "—"}</InsetRow>
          <InsetRow label="Reference articles">{referenceArticles || "—"}</InsetRow>
          <InsetRow label="SEC reference PDF">
            <DocLink url={claim.sec_proof_url} label="View references" />
          </InsetRow>
        </InsetList>
      </Section>
    </div>
  )
}
