/**
 * What a sent-back claim asks the claimant to fix, as a list of items.
 *
 * Today the college's answer is one piece of text, the send-back reason, and
 * this splits it into the separate things it asks for. When the review
 * workspace's marks land (docs/ux/21 section B), each claimant-facing mark
 * becomes one item instead, with the page and region it sits on, and the
 * reason text stays as the reviewer's own summary. The view takes items and
 * does not care which source they came from, so marks slot in through
 * `itemsFromMarks` and `useClaimantMarks` (marks.ts) and nothing else changes.
 *
 * A claimant sees only marks meant for them, and never the author's name:
 * the mark type below has no author on purpose.
 */

/** How a claimant can put an item right. */
export type FixKind = "FILE" | "FIELD" | "REFERENCE"

/** The checklist keys a mark can carry (docs/ux/21 B). */
export type ChecklistKey =
  | "affiliation"
  | "author_position"
  | "sec_refs"
  | "indexing"
  | "quartile"
  | "duplicate"
  | "other"

/** Where on a page, as fractions of the page (0 to 1). */
export type Rect = { x: number; y: number; w: number; h: number }

/**
 * A reviewer's mark meant for the claimant, as the marks API will give it to
 * them. Mirrors `ReviewMark` minus everything staff-only.
 */
export type ClaimantMark = {
  id: string
  kind: "ISSUE" | "OK" | "NOTE"
  audience: "CLAIMANT" | "STAFF"
  /** The attachment it is on, when it is on one. */
  upload_id?: string | null
  upload_url?: string | null
  upload_name?: string | null
  /** 1-based page. */
  page?: number | null
  rect?: Rect | null
  quoted_text?: string | null
  checklist_key?: ChecklistKey | null
  body: string
  resolved_in_resubmission?: boolean
}

export type FixItem = {
  id: string
  /** What is asked, in the reviewer's words. */
  body: string
  source: "mark" | "reason"
  /** Which way of fixing it to offer first. */
  suggest: FixKind
  checklistKey?: ChecklistKey | null
  fileUrl?: string | null
  fileName?: string | null
  page?: number | null
  rect?: Rect | null
  quotedText?: string | null
}

/** A short stable id for a piece of text, so "done" survives a reload. */
export function hashOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const BULLET = /^\s*(?:[-*•●]|\(?\d{1,2}[.)])\s+/

/** The send-back reason, one item per line or list entry. */
export function itemsFromReason(reason: string | null | undefined): FixItem[] {
  const lines = (reason ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(BULLET, "").trim())
    .filter(Boolean)
  const seen = new Map<string, number>()
  return lines.map((body) => {
    const n = (seen.get(body) ?? 0) + 1
    seen.set(body, n)
    return {
      id: `r-${hashOf(body)}${n > 1 ? `-${n}` : ""}`,
      body,
      source: "reason" as const,
      suggest: suggestFix(body, null),
    }
  })
}

/** What a mark asks, even when the reviewer only drew a box or ticked a checklist item. */
function markBody(m: ClaimantMark): string {
  const said = (m.body ?? "").trim()
  if (said) return said
  if (m.quoted_text) return "Look at the highlighted passage and put it right."
  return "Look at the marked part of the page and put it right."
}

/** Claimant-facing marks that ask for something. An OK mark is good news, not a task. */
export function itemsFromMarks(marks: ClaimantMark[] | null | undefined): FixItem[] {
  return (marks ?? [])
    .filter((m) => m.audience === "CLAIMANT" && m.kind !== "OK" && !m.resolved_in_resubmission)
    .map((m) => ({
      id: `m-${m.id}`,
      body: markBody(m),
      source: "mark" as const,
      suggest: suggestFix(m.body, m.checklist_key ?? null),
      checklistKey: m.checklist_key ?? null,
      fileUrl: m.upload_url ?? null,
      fileName: m.upload_name ?? null,
      page: m.page ?? null,
      rect: m.rect ?? null,
      quotedText: m.quoted_text ?? null,
    }))
}

/**
 * The list to show. Marks, when there are any, are the precise version of
 * the reason, so they win; otherwise the reason's own lines are the list.
 */
export function fixItemsFor(reason: string | null | undefined, marks: ClaimantMark[] | null | undefined): FixItem[] {
  const fromMarks = itemsFromMarks(marks)
  return fromMarks.length > 0 ? fromMarks : itemsFromReason(reason)
}

/** Which fix to offer first: a hint, never a limit. The claimant can always choose another. */
export function suggestFix(text: string, key: ChecklistKey | null): FixKind {
  // A reference that is there but has no number is a correction, whatever the checklist item says.
  if (suggestField(text) === "ref_number" && !/\b(another|third|extra|more)\b/i.test(text)) return "FIELD"
  if (key === "affiliation") return "FILE"
  if (key === "sec_refs") return "REFERENCE"
  if (key === "author_position" || key === "indexing" || key === "quartile" || key === "duplicate") return "FIELD"
  const t = text.toLowerCase()
  // A reference that exists but has no number is a correction, not a new reference.
  if (/\b(reference|references)\b[^.]*\b(no number|number|numbered|unnumbered)\b/.test(t) && !/\b(another|third|extra|more)\b/.test(t)) {
    return "FIELD"
  }
  if (/\b(add|attach|another|third|extra|more|missing)\b[^.]*\b(reference|references|sec)\b/.test(t)) return "REFERENCE"
  if (/\b(affiliation|pdf|scan|scanned|unreadable|blurred|wrong file|replace|re-?upload|version of the (paper|article)|attach)\b/.test(t)) {
    return "FILE"
  }
  if (/\b(reference|references|sec)\b/.test(t)) return "REFERENCE"
  return "FIELD"
}

/** Which claim field an item is most likely about, for the "Correct a field" form to open on. */
export function suggestField(text: string):
  | "ref_number"
  | "author_position"
  | "total_authors"
  | "paper_title"
  | "journal_title"
  | "doi"
  | "issn"
  | "publication_year"
  | null {
  const t = text.toLowerCase()
  if (/\b(reference|references)\b[^.]*\b(number|numbered)\b|\bno number\b/.test(t)) return "ref_number"
  if (/\bposition\b/.test(t)) return "author_position"
  if (/\b(number of authors|total authors|authors? count)\b/.test(t)) return "total_authors"
  if (/\bdoi\b/.test(t)) return "doi"
  if (/\bissn\b/.test(t)) return "issn"
  if (/\bjournal (name|title)\b/.test(t)) return "journal_title"
  if (/\b(year|published in)\b/.test(t)) return "publication_year"
  if (/\btitle\b/.test(t)) return "paper_title"
  return null
}
