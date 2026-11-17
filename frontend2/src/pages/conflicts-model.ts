import { money } from "@/ui/paper"

/**
 * What the Data conflicts screen says about one difference and what can be
 * done about it. The server decides which actions a row allows (`actions`);
 * this file only words them and the change each one would make, so the
 * dialog can name the exact change before anybody confirms it.
 */

export type Action = "use_list" | "keep_app" | "pause_account" | "reactivate" | "update_ledger" | "keep_ledger"

export type ConflictRow = {
  id: string
  kind: "faculty" | "amount"
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
  counts: { open: number; open_faculty: number; open_amount: number; resolved_week: number }
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
}

/** What was done, for a row already settled. */
export const DONE: Record<string, string> = {
  use_list: "Used the file's value",
  keep_app: "Kept the app's value",
  update_ledger: "Updated the ledger",
  keep_ledger: "Kept the ledger amount",
}

const QUESTION: Record<Action, string> = {
  use_list: "Use the file's value?",
  keep_app: "Keep the app's value?",
  pause_account: "Pause this account?",
  reactivate: "Reactivate this account?",
  update_ledger: "Update the ledger?",
  keep_ledger: "Keep the ledger amount?",
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
    case "keep_ledger":
      return `Keep ${money(row.ledger_amount)} on the ledger for “${row.title ?? "this paper"}” (${who}). The file's ${money(row.file_amount)} is ignored. Nothing is changed.`
  }
}

/** The one button a row leads with; everything else goes in its menu. */
export function primaryOf(row: ConflictRow): Action | null {
  const order: Action[] = ["use_list", "update_ledger", "reactivate"]
  return order.find((a) => row.actions.includes(a)) ?? null
}

export const menuOf = (row: ConflictRow): Action[] => {
  const lead = primaryOf(row)
  return row.actions.filter((a) => a !== lead)
}

/** What differs, in a few words, for the column and the search. */
export function whatDiffers(row: ConflictRow): string {
  return row.kind === "faculty" ? (row.field_label ?? "A value") : (row.title ?? "An amount")
}

export function inTheApp(row: ConflictRow): string {
  return row.kind === "faculty" ? (row.current ?? "") : money(row.ledger_amount)
}

export function inTheFile(row: ConflictRow): string {
  return row.kind === "faculty" ? (row.incoming ?? "") : money(row.file_amount)
}

/** Search matches the person, the Staff ID, what differs and both values. */
export function matches(row: ConflictRow, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [row.name, row.staff_id, whatDiffers(row), inTheApp(row), inTheFile(row), row.source_file]
    .some((t) => (t ?? "").toLowerCase().includes(needle))
}
