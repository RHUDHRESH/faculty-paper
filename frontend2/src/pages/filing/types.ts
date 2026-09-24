/**
 * The filing form's shapes: the faculty-writable slice of a claim in editor
 * form, and the server answers the form reads. Read out of the backend, not
 * guessed -- each type names the endpoint it mirrors.
 */
import type { StoredAuthor } from "./lookup"

export type AttachmentRow = {
  kind: "PUBLISHED_PAPER" | "SEC_REFERENCE"
  url: string
  filename: string
  size_bytes: number | null
  ref_number?: string | null
  ref_title?: string | null
  content_hash?: string | null
  /** Kept on the row rather than only announced in a toast: "you have already
   *  attached this file to another paper" is worth seeing while looking at
   *  the file, not for four seconds while looking somewhere else. */
  duplicateOf?: {
    ticket_number: string | null
    owner_name: string
    same_owner: boolean
  } | null
}

/** What the server currently holds in proof_url / sec_proof_url / sec_refs,
 *  trimmed, as the form tracks them between saves. They are read because
 *  the submission gate and the payout formula disagree about them. */
export type CarriedEvidence = {
  proofUrl: string
  secProofUrl: string
  secRefs: string
}

export const NO_CARRIED_EVIDENCE: CarriedEvidence = { proofUrl: "", secProofUrl: "", secRefs: "" }

export type FormState = {
  paperTitle: string
  doi: string
  publicationType: string
  publicationDate: string
  journalTitle: string
  issn: string
  indexing: string[]
  auAnnexureRef: string
  ugcCareRef: string
  yukthiId: string
  subjectCategory: string
  selfReportedQuartile: string | null
  selfReportedSnip: string
  impactFactor: string
  scopusAuthorUrl: string
  designation: string
  authorPosition: number
  totalAuthors: number
  /** The author list the lookup found, in order. Saved as `authors_json` so
   *  a reopened draft still shows it. Empty when the paper was typed in. */
  authors: StoredAuthor[]
  affiliationOk: boolean
  claimReason: "INCENTIVE" | "COUNT_ONLY" | "STUDENT_PROJECT"
  /** The team code on a student project claim. Empty otherwise. */
  teamCode: string
  attachments: AttachmentRow[]
}

export function emptyForm(): FormState {
  return {
    teamCode: "",
    paperTitle: "",
    doi: "",
    publicationType: "",
    publicationDate: "",
    journalTitle: "",
    issn: "",
    indexing: [],
    auAnnexureRef: "",
    ugcCareRef: "",
    yukthiId: "",
    subjectCategory: "",
    selfReportedQuartile: null,
    selfReportedSnip: "",
    impactFactor: "",
    scopusAuthorUrl: "",
    designation: "",
    authorPosition: 1,
    totalAuthors: 1,
    authors: [],
    affiliationOk: false,
    claimReason: "INCENTIVE",
    attachments: [],
  }
}

export type PatchForm = (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void

/**
 * The eligibility rules, from `/api/meta/filing-rules`, which reads the
 * active policy. A hard-coded 2 in the client is a rule that silently stops
 * matching the one the money is calculated from.
 */
export type FilingRules = {
  max_authors: number
  min_sec_references: number
  attachment_limits: { PUBLISHED_PAPER: number; SEC_REFERENCE: number }
  max_upload_bytes: number
  why: { max_authors: string; min_sec_references: string }
  policy_version: number | null
}

/** Used only until the real rules arrive, and matching the server's own
 *  fallbacks so the two never briefly disagree on screen. */
export const RULE_FALLBACK: FilingRules = {
  max_authors: 9,
  min_sec_references: 2,
  attachment_limits: { PUBLISHED_PAPER: 10, SEC_REFERENCE: 50 },
  max_upload_bytes: 10 * 1024 * 1024,
  why: {
    max_authors: "A paper with more than 9 authors carries no remuneration.",
    min_sec_references:
      "The policy requires 2 cited references that carry the college's affiliation.",
  },
  policy_version: null,
}

export type CalcResult = {
  base: number | null
  point: number | null
  remuneration: number | null
  qf: number | null
  error: string | null
  note: string | null
  category_label?: string | null
}

export type DuplicateMatch = {
  source?: string | null
  reference?: string | null
  who?: string | null
  when?: string | null
  amount?: number | null
  /** The matched paper's own title: a reference and a month name a row in
   *  somebody's ledger; the title is what a claimant recognises. */
  title?: string | null
}

export type PriorCheckResult = {
  warning: boolean
  matches: DuplicateMatch[]
}

/**
 * `POST /api/lookup/verify` -- the facts the claim rules turn on, from the
 * same sources the server checks with when the ticket is filed.
 * `scopus_status` says why Scopus did not confirm anything: not connected
 * here, or connected and down.
 */
export type VerifyResult = {
  ok: boolean
  scopus: { indexed: boolean; linked: boolean; message?: string | null }
  scimago: {
    found: boolean
    quartile?: string | null
    sjr?: number | null
    official_url?: string | null
    message?: string | null
  }
  paid: PriorCheckResult
  snip?: number | null
  engineering_class?: string | null
  standing?: {
    checked: boolean
    issues: string[]
    notes?: string[]
    message?: string | null
  } | null
  scopus_status?: "ok" | "not_configured" | "unavailable"
}

/** `POST /api/lookup/file-check` -- whether an attached file shows the paper
 *  the form describes. A courtesy before filing, never a verdict. */
export type FileCheck = {
  outcome: "MATCHED" | "MISMATCH" | "NO_TEXT" | "UNREADABLE" | "NOT_READ"
  summary: string
  found: string[]
  missing: string[]
  pages: number
}
