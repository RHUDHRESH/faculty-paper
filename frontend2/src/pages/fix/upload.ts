import { api, ApiError } from "@/lib/api"

/** What `/api/claims/upload` answers for one stored file. */
export type Uploaded = {
  url: string
  filename: string
  size_bytes: number
  content_hash: string | null
  kind_label?: string
  duplicate_of?: { ticket_number: string | null; same_owner: boolean } | null
}

let csrf: string | null = null

/** One evidence file to the server, the same call the filing form makes. */
export async function uploadEvidence(file: File): Promise<Uploaded> {
  if (!csrf) {
    const r = await fetch("/api/auth/csrf", { credentials: "same-origin" })
    csrf = ((await r.json()) as { csrfToken: string }).csrfToken
  }
  const body = new FormData()
  body.append("file", file)
  const res = await fetch("/api/claims/upload", {
    method: "POST",
    body,
    credentials: "same-origin",
    headers: { "X-CSRFToken": csrf as string },
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    if (res.status === 403) csrf = null
    const detail = (data as { detail?: string } | null)?.detail
    throw new ApiError(res.status, detail || `The upload was refused (${res.status}).`, data)
  }
  return data as Uploaded
}

/** The attachment shape the claim accepts back. */
export type AttachmentBody = {
  kind: string
  url: string
  filename?: string | null
  size_bytes?: number | null
  ref_number?: string | null
  ref_title?: string | null
  content_hash?: string | null
}

/** Saves part of a claim. The server leaves out anything not sent. */
export function saveClaim<T = unknown>(claimId: string, body: Record<string, unknown>): Promise<T> {
  return api<T>(`/api/claims/${claimId}`, { method: "PATCH", json: body })
}
