import type { Role } from "@/app/auth"
import type { ClaimReview } from "@/pages/claim-review"
import type { DeskFields } from "@/pages/clearing-desk"
import type { Attachment } from "@/ui/attachments"

/** One line of a claim's history, as `GET /api/claims/{id}` sends it. */
export type ClaimAction = {
  id: string
  action: string
  from_status: string | null
  to_status: string
  note: string | null
  actor_name: string
  created_at: string
}

export type Confirmation = {
  id: string
  text: string
  ticked_at: string
  user_name: string | null
}

/** The claim as the workspace reads it: `claim_to_dict()` plus the history
 *  and the three confirmations. Only the fields this page uses are named. */
export type WorkspaceClaim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  doi: string | null
  eid?: string | null
  scopus_url?: string | null
  issn: string | null
  publication_year: number | null
  /** Absent on the reviewer's own claim, which comes back as the claimant's
   *  view: a claimant is never shown which desk holds a claim. */
  status?: string
  status_note?: string | null
  owner_id?: string
  owner_name: string
  owner_email: string
  owner_department: string | null
  owner_photo_url?: string | null
  on_hold?: boolean | null
  hold_reason?: string | null
  remuneration: number | null
  remuneration_is_estimate: boolean
  remuneration_category: string | null
  remuneration_note: string | null
  calc_error: string | null
  qf_amount: number | null
  base_amount: number | null
  snip: number | null
  snip_source: "SCOPUS" | "SNIP_DUMP" | "MANUAL" | null
  self_reported_snip: number | null
  quartile: string | null
  quartile_source: "SCIMAGO" | "MANUAL" | null
  self_reported_quartile: string | null
  scimago_sjr: number | null
  scimago_dataset_year: number | null
  scimago_verified?: boolean | null
  author_position: number | null
  total_authors: number | null
  record_author_position?: number | null
  record_total_authors?: number | null
  record_has_authors?: boolean
  affiliation_ok?: boolean | null
  indexing_level?: string | null
  indexing_status?: string | null
  verification_ok: boolean | null
  verification_snapshot_json: string | null
  duplicate_warning: boolean
  duplicate_matches_json: string | null
  override_duplicate: boolean | null
  override_reason: string | null
  override_by_name: string | null
  needs_second_approval?: boolean
  cleared_by_name?: string | null
  contest_forward?: boolean | null
  attachments: Attachment[]
  actions?: ClaimAction[]
  confirmations?: Confirmation[]
  waiting_days: number | null
  submitted_at?: string | null
} & Omit<
  DeskFields,
  "publication_year" | "verification_ok" | "duplicate_warning" | "calc_error" | "remuneration" | "waiting_days"
>

/** `GET /api/claims/{id}/workspace`: the whole page in one answer. */
export type WorkspaceBundle = {
  claim: WorkspaceClaim
  /** Flags and file checks; null for a seat that may not see them, and on
   *  the reviewer's own claim. */
  review: ClaimReview | null
  own: boolean
  role: Role
}

/** What a queue row carries, for the rail. */
export type RailClaim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name: string
  owner_department: string | null
  owner_photo_url?: string | null
  waiting_days: number | null
  remuneration: number | null
  duplicate_warning?: boolean
  on_hold?: boolean | null
}

export type QueueName = "clearing" | "approvals" | "authorisations"
