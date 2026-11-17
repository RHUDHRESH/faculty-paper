import { money } from "@/ui/paper"

/**
 * What the Data conflicts screen says about one difference and what can be
 * done about it. The server decides which actions a row allows (`actions`);
 * this file only words them and the change each one would make, so the
 * dialog can name the exact change before anybody confirms it.
 */

export type Action =
  | "use_list"
  | "keep_app"
  | "pause_account"
  | "reactivate"
  | "update_ledger"
  | "keep_ledger"
  | "confirmed"
  | "mark_error"

export type Payment = { month: string; amount: number }

export type ConflictRow = {
  id: string
  kind: "faculty" | "amount" | "double_payment"
  status: "open" | "resolved" | "dismissed"
  source_file: string
  detected_at: string
  staff_id: string
  name: string
  user_id: string | null
  photo_url?: string | null
  initials?: string
  field: string | null
  field_label: string | null
  current: string | null
  incoming: string | null
  title: string | null
  month: string | null
  ledger_amount: number | null
  file_amount: number | null
  /** A paper paid more than once: each payment, and what they come to. */
  payments?: Payment[] | null
  total?: number | null
  resolution: string
  resolution_note: string
  resolved_by: string | null
  resolved_at: string | null
  paused: boolean
  account_active: boolean | null
  actions: Action[]
  locked: string | null
}

export type ConflictList = {
  counts: {
    open: number
    open_faculty: number
    open_amount: number
    open_double_payment?: number
    to_recover?: number
    resolved_week: number
  }
  total: number
  truncated: boolean
  may_resolve: boolean
  rows: ConflictRow[]
}

export type ResolveResult = { ok: boolean; changed: boolean; id: string; status: string; message: string; warning?: string }

/** The button's words. The dialog's title and the confirm button say the same verb (docs/ux/19). */
export const LABEL: Record<Action, string> = {
  use_list: "Use the file's value",
  keep_app: "Keep the app's value",
  pause_account: "Pause the account",
  reactivate: "Reactivate the account",
  update_ledger: "Update ledger",
  keep_ledger: "Keep the ledger amount",
  confirmed: "Confirmed: both payments were right",
  mark_error: "Mark as an error to recover",
}

/** What was done, for a row already settled. */
export const DONE: Record<string, string> = {
  use_list: "Used the file's value",
  keep_app: "Kept the app's value",
  update_ledger: "Updated the ledger",
  keep_ledger: "Kept the ledger amount",
  confirmed: "Confirmed: both payments were right",
  mark_error: "Marked as an error to recover",
}

const QUESTION: Record<Action, string> = {
  use_list: "Use the file's value?",
  keep_app: "Keep the app's value?",
  pause_account: "Pause this account?",
  reactivate: "Reactivate this account?",
  update_ledger: "Update the ledger?",
  keep_ledger: "Keep the ledger amount?",
  confirmed: "Confirm that both payments were right?",
  mark_error: "Mark this as an error to recover?",
}

export const question = (a: Action) => QUESTION[a]

const WORD: Record<string, string> = { email: "email", scopus_author_id: "Scopus author ID", staff_id: "Staff ID" }

const show = (v: string | null | undefined) => (v && v.trim() ? v : "empty")

/** The exact change an action would make, as one or two plain sentences. */
export function changeText(row: ConflictRow, action: Action): string {
  const who = row.name || row.staff_id
  const word = WORD[row.field ?? ""] ?? "value"
  switch (action) {
    case "use_list": {
      const base = `Change ${who}'s ${word} from ${show(row.current)} to ${show(row.incoming)}.`
      if (row.field === "scopus_author_id") return `${base} Their papers will need syncing from Scopus again.`
      if (row.field === "staff_id") return `${base} Payments already on the ledger stay under the old Staff ID.`
      if (row.field === "email") return `${base} They sign in with the new email from now on.`
      return base
    }
    case "keep_app":
      return `Keep ${show(row.current)} as ${who}'s ${word}. The file's ${show(row.incoming)} is ignored. Nothing is changed.`
    case "pause_account":
      return `${who} cannot sign in until you reactivate the account. Nothing else is changed.`
    case "reactivate":
      return `${who} can sign in again.`
    case "update_ledger":
      return `Change the ledger amount for “${row.title ?? "this paper"}” (${who}) from ${money(row.ledger_amount)} to ${money(row.file_amount)}. The old amount is kept in the row's history.`
    case "confirmed":
      return `Record that both payments for “${row.title ?? "this paper"}” (${who}) were right. No amount is changed.`
    case "mark_error":
      return `Record that “${row.title ?? "this paper"}” (${who}) should not have been paid more than once, so the extra money is to be recovered. Both payments stay on the ledger and no amount is changed.`
    case "keep_ledger":
      return `Keep ${money(row.ledger_amount)} on the ledger for “${row.title ?? "this paper"}” (${who}). The file's ${money(row.file_amount)} is ignored. Nothing is changed.`
  }
}

/** The one button a row leads with; everything else goes in its menu. */
export function primaryOf(row: ConflictRow): Action | null {
  const order: Action[] = ["use_list", "update_ledger", "reactivate", "confirmed"]
  return order.find((a) => row.actions.includes(a)) ?? null
}

export const menuOf = (row: ConflictRow): Action[] => {
  const lead = primaryOf(row)
  return row.actions.filter((a) => a !== lead)
}

/** What differs, in a few words, for the column and the search. */
export function whatDiffers(row: ConflictRow): string {
  if (row.kind === "double_payment") return `${row.title ?? "A paper"} paid more than once`
  return row.kind === "faculty" ? (row.field_label ?? "A value") : (row.title ?? "An amount")
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const monthOf = (iso: string) => {
  const m = /^(\d{4})-(\d{2})/.exec(iso)
  return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso
}

/** "Aug 2026 ₹500, Sep 2026 ₹500" */
export const paymentsText = (row: ConflictRow) => (row.payments ?? []).map((p) => `${monthOf(p.month)} ${money(p.amount)}`).join(", ")

export function inTheApp(row: ConflictRow): string {
  if (row.kind === "double_payment") return `${(row.payments ?? []).length} payments, ${money(row.total ?? 0)}`
  return row.kind === "faculty" ? (row.current ?? "") : money(row.ledger_amount)
}

export function inTheFile(row: ConflictRow): string {
  if (row.kind === "double_payment") return paymentsText(row)
  return row.kind === "faculty" ? (row.incoming ?? "") : money(row.file_amount)
}

/** Search matches the person, the Staff ID, what differs and both values. */
export function matches(row: ConflictRow, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [row.name, row.staff_id, whatDiffers(row), inTheApp(row), inTheFile(row), row.source_file]
    .some((t) => (t ?? "").toLowerCase().includes(needle))
}
