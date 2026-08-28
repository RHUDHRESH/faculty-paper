/**
 * The requests the filing form makes, made from the same browser as the form.
 *
 * Two specs need to put a claim into a state the seeded fixture cannot express
 * and the wizard would take ten screens to reach: a ticket complete enough to
 * file (`rejection.spec.ts`), and one whose cited references have lost their
 * reference numbers (`policy-refusal.spec.ts`). Both are states a real
 * claimant reaches through the form; neither is what those specs are testing.
 *
 * Everything here goes through `page.request`, which shares the page's cookie
 * jar and its origin — so these are the claimant's own session, hitting the
 * same Vite proxy the app hits, with the same CSRF token the app fetches. No
 * credential and no second way in: if the session is not good enough for the
 * screens, it is not good enough for these either.
 *
 * Deliberately thin. This is not an API test kit — it exists so a browser test
 * can arrange a starting position, the way `e2e_session --claim` does, and
 * every assertion worth making still belongs on a screen.
 */
import { expect, type APIResponse, type Page } from "@playwright/test"

/** One SEC reference or published paper as the claim carries it. */
export type ClaimAttachment = {
  kind: string
  url: string
  filename: string | null
  size_bytes: number
  ref_number: string | null
  ref_title: string | null
  content_hash: string | null
}

export type ClaimDetail = {
  id: string
  status: string
  ticket_number: string
  paper_title: string
  remuneration: number | null
  sec_refs: string | null
  attachments: ClaimAttachment[]
}

/** The token `lib/api.ts` fetches before every mutating request. */
async function csrfToken(page: Page): Promise<string> {
  const res = await page.request.get("/api/auth/csrf")
  expect(res.status(), "could not get a CSRF token").toBe(200)
  return ((await res.json()) as { csrfToken: string }).csrfToken
}

/** Say what the server said. A bare "expected 200, got 400" over a request
 *  whose whole purpose is to arrange a fixture is a message you have to go and
 *  reproduce; the `detail` string is almost always the entire answer. */
async function expectOk(res: APIResponse, where: string): Promise<void> {
  expect(res.status(), `${where}: ${res.status()} — ${await res.text().catch(() => "")}`).toBe(200)
}

export async function getClaim(page: Page, claimId: string): Promise<ClaimDetail> {
  const res = await page.request.get(`/api/claims/${claimId}`)
  await expectOk(res, `reading claim ${claimId}`)
  return (await res.json()) as ClaimDetail
}

/**
 * A PDF that is really a PDF.
 *
 * `services/uploads.sniff` identifies an upload from its own bytes and refuses
 * anything it does not recognise — renaming a file does not get it past this,
 * which is the point of the check. So this is a genuine (if minimal) PDF, and
 * `nonce` goes inside it because the upload endpoint fingerprints content: two
 * byte-identical uploads come back flagged as the same document, which is a
 * true statement about them and noise in a test that wanted two files.
 */
function pdfBytes(nonce: string): Buffer {
  const body = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
% ${nonce}
trailer << /Root 1 0 R >>
%%EOF
`
  return Buffer.from(body, "utf8")
}

export type Uploaded = {
  url: string
  filename: string
  size_bytes: number
  content_hash: string
}

/** Put one file where the claim can point at it, exactly as the form does. */
export async function uploadPdf(page: Page, filename: string): Promise<Uploaded> {
  const nonce = `${filename}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const res = await page.request.post("/api/claims/upload", {
    headers: { "X-CSRFToken": await csrfToken(page) },
    multipart: {
      file: { name: filename, mimeType: "application/pdf", buffer: pdfBytes(nonce) },
    },
  })
  await expectOk(res, `uploading ${filename}`)
  return (await res.json()) as Uploaded
}

/**
 * PATCH a claim as its owner, and hand back the raw response.
 *
 * Raw, not parsed and asserted, because the two callers want opposite things
 * from it: one expects 200, the other exists entirely to assert a 400 and read
 * the sentence that comes with it.
 *
 * Note that `attachments` is all-or-nothing on the server —
 * `_persist_attachments` replaces the set whole when the key is present and
 * leaves it alone when it is absent. So a caller changing one reference has to
 * send them all, and a caller changing nothing about the files must not send
 * the key at all.
 */
export async function patchClaim(
  page: Page,
  claimId: string,
  data: Record<string, unknown>
): Promise<APIResponse> {
  return page.request.patch(`/api/claims/${claimId}`, {
    headers: { "X-CSRFToken": await csrfToken(page) },
    data,
  })
}

/**
 * Everything `_check_mandatory_fields` names and a seeded ticket does not
 * carry.
 *
 * A fixture claim is a row in a queue, not a form somebody filled in: it has
 * the inputs that *price* a paper — a SNIP, a quartile, an author position,
 * its cited references — and none of the identifiers the submission gate asks
 * for. These are those identifiers, and nothing else. Keeping them in one
 * named place means a new mandatory field breaks both specs in the same
 * obvious way rather than one of them mysteriously.
 */
export const FILEABLE_FIELDS = {
  issn: "0140-6736",
  publication_date: "2026-01-15",
  indexing_level: "Scopus",
  yukthi_id: "NA",
  scopus_author_url: "https://www.scopus.com/authid/detail.uri?authorId=57200000000",
} as const

/** Send the attachment set back as the form would, optionally rewriting each
 *  row on the way — which is how a reference loses its number. */
export function attachmentsPayload(
  attachments: ClaimAttachment[],
  rewrite: (a: ClaimAttachment) => ClaimAttachment = (a) => a
): Record<string, unknown>[] {
  return attachments.map(rewrite).map((a) => ({
    kind: a.kind,
    url: a.url,
    filename: a.filename,
    size_bytes: a.size_bytes,
    ref_number: a.ref_number,
    ref_title: a.ref_title,
    content_hash: a.content_hash,
  }))
}
