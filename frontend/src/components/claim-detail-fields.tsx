import { AttachmentGallery, type GalleryFile } from "@/components/attachment-gallery"
import { InsetList, InsetRow, Section } from "@/components/layout/page"
import { Money } from "@/components/ticket-ui"
import type { Claim } from "@/lib/api"

/** Mirrors CATEGORY_LABELS in core/services/remuneration.py. */
const CATEGORY_LABELS: Record<string, string> = {
  I: "Category I — Scopus indexed, with SNIP",
  II: "Category II — Scopus journal without SNIP",
  III: "Category III — Scopus conference or book chapter without SNIP",
  IV: "Category IV — Web of Science (SCIE/ESCI), not in Scopus",
  "—": "Not eligible for remuneration",
}

const SOURCE_LABELS: Record<string, string> = {
  SCOPUS: "Verified · Scopus",
  SNIP_DUMP: "Verified · SNIP dataset",
  SCIMAGO: "Verified · Scimago",
  MANUAL: "Verified · research cell",
}

/** Where a money-determining value came from — or that it is only a declaration. */
function SourceBadge({ source, selfReported }: { source?: string | null; selfReported?: boolean }) {
  if (source) {
    return (
      <span className="ml-2 rounded bg-primary/12 px-1.5 py-0.5 text-xs text-primary">
        {SOURCE_LABELS[source] || "Verified"}
      </span>
    )
  }
  if (selfReported) {
    return (
      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
        Self-reported — not used for payment
      </span>
    )
  }
  return null
}

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

/** Files of one kind, falling back to the legacy single-URL column. */
function filesOf(
  claim: Claim,
  kind: "PUBLISHED_PAPER" | "SEC_REFERENCE",
  fallbackUrl?: string | null
): GalleryFile[] {
  const files = (claim.attachments || []).filter((a) => a.kind === kind)
  if (files.length) {
    return files.map((a) => ({
      url: a.url,
      filename: a.filename,
      size_bytes: a.size_bytes,
    }))
  }
  // Claims filed before the attachments table only have the one column.
  return fallbackUrl
    ? [{ url: fallbackUrl, filename: fallbackUrl.split("/").pop() || "Document" }]
    : []
}

export function ClaimDetailFields({ claim, showOwner = false }: { claim: Claim; showOwner?: boolean }) {
  const referenceArticles = parseReferenceArticles(claim)
  const countOnly = claim.claim_reason === "COUNT_ONLY"
  const publishedFiles = filesOf(claim, "PUBLISHED_PAPER", claim.proof_url)
  const referenceFiles = filesOf(claim, "SEC_REFERENCE", claim.sec_proof_url)
  // Rows that know which citation they are. Older claims have none, and fall
  // back to the plain gallery plus the free-text columns above.
  const citations = (claim.attachments || []).filter(
    (a) => a.kind === "SEC_REFERENCE" && (a.ref_number || a.ref_title)
  )

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
          <InsetRow label="Quartile">
            {claim.quartile ? (
              <>
                {claim.quartile}
                <SourceBadge source={claim.quartile_source} />
              </>
            ) : claim.self_reported_quartile ? (
              <>
                {claim.self_reported_quartile}
                <SourceBadge selfReported />
              </>
            ) : (
              "—"
            )}
          </InsetRow>
          <InsetRow label="ISSN">{claim.issn || "—"}</InsetRow>
          <InsetRow label="Yukthi ID">{claim.yukthi_id || "—"}</InsetRow>
          <InsetRow label="Publication date">{claim.publication_date || "—"}</InsetRow>
          <InsetRow label="Year">{claim.publication_year ?? "—"}</InsetRow>
          <InsetRow label="Type">{claim.publication_type || claim.aggregation_type || "—"}</InsetRow>
          <InsetRow label="Indexed in">{claim.indexing_level || "—"}</InsetRow>
          {/* Separate registers, shown separately. Older claims only kept the
              one combined column, so fall back to it. */}
          {claim.au_annexure_ref || claim.ugc_care_ref ? (
            <>
              {claim.au_annexure_ref ? (
                <InsetRow label="AU Annexure ref">{claim.au_annexure_ref}</InsetRow>
              ) : null}
              {claim.ugc_care_ref ? (
                <InsetRow label="UGC Care ref">{claim.ugc_care_ref}</InsetRow>
              ) : null}
            </>
          ) : (
            <InsetRow label="AU / UGC ref">{claim.indexing_ref || "—"}</InsetRow>
          )}
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
          <InsetRow label="SNIP">
            {claim.snip != null ? (
              <>
                {claim.snip}
                <SourceBadge source={claim.snip_source} />
              </>
            ) : claim.self_reported_snip != null ? (
              <>
                {claim.self_reported_snip}
                <SourceBadge selfReported />
              </>
            ) : (
              "—"
            )}
          </InsetRow>
          <InsetRow label="Impact factor">{claim.impact_factor || "—"}</InsetRow>
          <InsetRow label="Student publication">{claim.is_student_publication ? "Yes" : "No"}</InsetRow>
          <InsetRow label="Affiliation confirmed">{claim.affiliation_ok !== false ? "Yes" : "No"}</InsetRow>
          <InsetRow label={claim.remuneration_is_estimate ? "Estimated amount" : "Amount"}>
            <Money value={claim.remuneration} />
            {claim.remuneration_is_estimate ? (
              <span className="ml-2 text-xs text-muted-foreground">
                Estimate from your own details — the payable amount comes from verification
              </span>
            ) : null}
          </InsetRow>
          {claim.manual_verification_note ? (
            <InsetRow label="Manual verification">
              <span className="whitespace-pre-line">
                {claim.manual_verification_note}
                {claim.manual_verified_by_name ? ` — ${claim.manual_verified_by_name}` : ""}
              </span>
            </InsetRow>
          ) : null}
          {/* An unexplained number is what both faculty and Finance query. */}
          {claim.remuneration_category ? (
            <InsetRow label="Remuneration category">
              {CATEGORY_LABELS[claim.remuneration_category] || claim.remuneration_category}
            </InsetRow>
          ) : null}
          {claim.remuneration_note ? (
            <InsetRow label="Why this amount">
              <span className="whitespace-pre-line">{claim.remuneration_note}</span>
            </InsetRow>
          ) : null}
        </InsetList>
      </Section>

      <Section title="Documents & references">
        <InsetList>
          <InsetRow label="SEC reference numbers">{claim.sec_refs || "—"}</InsetRow>
          <InsetRow label="Reference articles">
            <span className="whitespace-pre-line">{referenceArticles || "—"}</span>
          </InsetRow>
        </InsetList>

        {/* Full width rather than squeezed into a label/value row — this is the
            evidence the approval actually turns on. */}
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">
              Published paper
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {publishedFiles.length || "none"}
              </span>
            </p>
            <AttachmentGallery files={publishedFiles} emptyLabel="No published paper uploaded" />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">
              SEC-affiliated references
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {citations.length || "none"}
              </span>
            </p>
            {citations.length ? (
              // Each file next to the citation it proves, so an approver is not
              // matching filenames against a separate list of numbers.
              <ul className="space-y-3">
                {citations.map((c, i) => (
                  <li key={c.id || i} className="rounded-xl border border-border bg-muted/20 p-3">
                    <p className="text-sm font-medium text-foreground">
                      {c.ref_number ? (
                        <span className="mr-2 rounded bg-primary/12 px-1.5 py-0.5 font-mono text-xs text-primary">
                          Ref {c.ref_number}
                        </span>
                      ) : null}
                      {c.ref_title || "Untitled citation"}
                    </p>
                    <div className="mt-2">
                      <AttachmentGallery
                        files={[{ url: c.url, filename: c.filename, size_bytes: c.size_bytes }]}
                        className="sm:grid-cols-1"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <AttachmentGallery
                files={referenceFiles}
                emptyLabel="No reference documents uploaded"
              />
            )}
          </div>
        </div>
      </Section>
    </div>
  )
}
