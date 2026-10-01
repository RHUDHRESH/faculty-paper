import { money } from "@/ui/paper"

/**
 * What `/api/calculator/*` answers (docs/ux/23). The server does every sum;
 * these types only describe what comes back, and nothing in the calculator's
 * three tabs works out an amount for itself.
 */

export type PolicyInfo = {
  id: string | null
  name: string
  version: number | null
  label: string
  in_force: boolean
  effective_from: string | null
  min_sec_references?: number
  max_authors?: number
}

export type Options = {
  policies: PolicyInfo[]
  in_force: PolicyInfo | null
  publication_types: string[]
  quartiles: string[]
  limits: { max_authors: number; min_sec_references: number; student_project_amount: number }
}

export type WorkLine = { key: string; label: string; text: string; amount: number | null }

export type ThresholdBlock = {
  applies: boolean
  person: string
  absorbed: number
  payable: number | null
  text: string
  year?: string
  threshold?: number | null
}

export type PriceResult = {
  ok: boolean
  policy: PolicyInfo
  amount: number | null
  full: number | null
  paper_value: number | null
  category: string | null
  category_label: string | null
  problem: string | null
  sentence: string
  zero_reason: string | null
  working: WorkLine[]
  authors: { position: number; point: number | null; incentive: number | null; problem: string | null }[]
  college_total: number | null
  threshold: ThresholdBlock | null
  cautions: string[]
}

export type PrefillInputs = {
  publication_type: string | null
  indexing_level: string | null
  quartile: string | null
  snip: number | null
  engineering_class: string | null
  total_authors: number
  author_position: number
  student_project: boolean
  counted_only: boolean
}

export type Prefill = {
  kind: "claim" | "doi_claim" | "doi" | "none"
  message: string
  inputs: PrefillInputs | null
}

export type PersonHit = {
  user_id: string
  name: string
  department: string | null
  research: boolean
  initials?: string
  photo_url?: string | null
}

export type SideBlock = {
  policy: string
  in_force: boolean
  amount: number | null
  paper_value: number | null
  category: string | null
  note: string | null
  problem: string | null
  payable?: number | null
}

export type Difference = {
  key: string
  cause: string
  cause_label: string
  expected: boolean
  compare: string
  delta: number | null
  text: string
}

export type ClaimCheck = {
  claim: {
    id: string
    ticket_number: string | null
    imported: boolean
    title: string | null
    journal: string | null
    status: string
    month: string | null
    user_id: string
    name: string
    department: string | null
    initials?: string
    photo_url?: string | null
  }
  inputs: PrefillInputs & { sec_references: number; priced_category: string | null }
  recorded: { amount: number | null; absorbed: number; policy_amount: number; note: string | null }
  under_snapshot: SideBlock | null
  under_today: SideBlock
  ledger: { total: number; rows: { month: string | null; voucher: string | null; amount: number }[] }
  differences: Difference[]
  agrees: boolean
  headline: string
  delta: number | null
}

export type ManyRow = {
  id: string
  ticket_number: string | null
  imported: boolean
  user_id: string
  name: string
  department: string | null
  title: string | null
  status: string
  month: string | null
  recorded: number | null
  policy_amount: number
  formula: number | null
  difference: number
  policy: string
  cause: string
  cause_label: string
  cause_text: string | null
  fix: "data" | "claim"
  initials?: string
  photo_url?: string | null
}

export type Many = {
  stages: string[]
  policy: string
  totals: {
    checked: number
    agree: number
    differ: number
    over: number
    under: number
    net: number
    left_out: number
    threshold_claims: number
    threshold_total: number
    policy_moved: number
    ledger_differs: number
  }
  causes: { cause: string; label: string; count: number; over: number; under: number }[]
  rows: ManyRow[]
  row_total: number
  listed: { count: number; recorded: number; formula: number; difference: number }
  departments: string[]
  months: string[]
  limit: number
  offset: number
}

/** A rupee amount with its sign in front of the symbol (₹-3,000 reads as a typo). */
export function rs(n: number | null | undefined): string {
  if (n == null) return "Not recorded"
  return n < 0 ? `-${money(-n)}` : money(n)
}

/** "₹3,000 more" or "₹1,200 less": the direction in words, never colour alone. */
export function moreOrLess(n: number): string {
  if (Math.abs(n) < 0.005) return "No difference"
  return `${money(Math.abs(n))} ${n > 0 ? "more" : "less"}`
}

/** "2026-09" as "Sep 2026". */
export function monthWord(ym: string | null | undefined): string {
  if (!ym) return "No month"
  const [y, m] = ym.split("-").map(Number)
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m || 1) - 1]
  return `${mon} ${y}`
}

/** The claim's inputs as the form's indexing choice. Only Scopus and Web of
 *  Science are priced; anything else reads as "not stated", as the engine does. */
export function indexingChoice(raw: string | null | undefined): string {
  const t = (raw || "").toLowerCase()
  const scopus = /\bscopus\b/.test(t)
  const wos = /\b(sci|scie|esci|wos|web of science)\b/.test(t)
  if (scopus && wos) return "Scopus, SCIE"
  if (scopus) return "Scopus"
  if (wos) return "SCIE"
  return ""
}
