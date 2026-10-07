import type { Role } from "@/app/auth"
import { REVIEWERS } from "@/app/nav"

/**
 * What `/api/track` sends, and the few rules both the Track page and the
 * homes share. Kept out of the page so a home does not pull the page's whole
 * table and filters into its own code.
 */

export type Ageing = { week: number; fortnight: number; month: number; older: number }

export type TrackStage = {
  key: string
  label: string
  caption: string
  count: number
  amount?: number
  flagged?: number
  oldest_days: number | null
  average_days: number | null
  ageing: Ageing | null
}

export type TrackRowData = {
  id: string
  ticket_number: string | null
  owner_id: string
  owner_name: string
  owner_initials?: string
  owner_photo_url?: string | null
  owner_department: string | null
  paper_title: string | null
  journal_title: string | null
  quartile: string | null
  publication_year: number | null
  stage: string
  stage_label: string
  days_in_stage: number | null
  since: string | null
  is_mine: boolean
  amount?: number | null
  /** Said in place of a blank amount: "Not recorded", "None, counted only". */
  amount_note?: string
  /** One short line under it: "counted only, no incentive", "in the old ERP". */
  amount_reason?: string | null
  /** Paid claims: the day, or the first of the month when only the month is known. */
  paid_on?: string | null
  paid_month_only?: boolean
  /** The office only: what is missing from an old-ERP claim. */
  fixes?: string[]
  open_flags?: number
  duplicate?: boolean
}

export type TrackPayload = {
  scope: "college" | "department"
  department: string | null
  sees_money: boolean
  sees_flags: boolean
  stages: TrackStage[]
  total_claims: number
  total: number
  departments: string[]
  months: string[]
  results: TrackRowData[]
}

/** The main path in order, then the side stages, as the server names them.
 *  A head's four stages (review, approved, completed, sent back) are in the
 *  same lists: the server sends only the ones that role has. */
export const MAIN_STAGES = ["submitted", "checked", "approved", "authorised", "paid", "review", "completed"]
export const SIDE_STAGES = ["sent_back", "on_hold", "not_accepted", "closed_old"]

export function days(n: number | null | undefined): string {
  if (n == null) return ""
  if (n <= 0) return "Today"
  return n === 1 ? "1 day" : `${n} days`
}

/**
 * Where a row goes. A reviewer opens the full review page; a head opens the
 * department's paper (no money); the Director and Finance open the claim
 * itself. Your own claim is always the claim page: nobody reviews their own.
 */
/** Placeholders the old ERP left where a cell was empty ("-", "- - -", "NA"). */
const JUNK = /^[-–—.?\s]*$|^(n\/?a|nil|null|none|tbd|not found)$/i

/** The text, or null when it is only a placeholder. */
export function clean(text: string | null | undefined): string | null {
  const t = (text || "").trim()
  return !t || JUNK.test(t) ? null : t
}

/** "Paid 24 Sep" for a claim paid here; "Paid Sep 2026" where only the month is known. */
export function paidLabel(on: string | null | undefined, monthOnly: boolean | undefined): string {
  if (!on) return "Paid"
  const d = new Date(`${on.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(d.getTime())) return "Paid"
  // Spelled out here: the browser's short month is "Sept" in en-IN.
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]
  return monthOnly ? `Paid ${mon} ${d.getFullYear()}` : `Paid ${d.getDate()} ${mon}`
}

/** A claim number that came from the old ERP rather than from this system. */
export const isErpNumber = (n: string | null | undefined): boolean => !!n && n.startsWith("ERP-")

export function claimHref(role: Role | undefined, row: { id: string; is_mine: boolean }): string {
  if (row.is_mine) return `/papers/${row.id}`
  if (role === "HOD") return `/department/papers/${row.id}`
  if (role && REVIEWERS.includes(role)) return `/review/${row.id}`
  return `/papers/${row.id}`
}
