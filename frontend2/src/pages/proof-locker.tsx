import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { LoaderCircle, RefreshCw, Trash2, Upload } from "lucide-react"

import { ApiError, api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"

import { formatBytes } from "./filing/bits"
import { KIND_LABEL, LOCKER_KEY, type Proof, ProofChecks, useLocker } from "./filing/locker"
import { ACCEPT } from "./filing/proof"

async function uploadProof(file: File, kind: Proof["kind"]): Promise<Proof & { already_in_locker: boolean }> {
  const body = new FormData()
  body.append("file", file)
  body.append("kind", kind)
  return api("/api/me/proofs", { method: "POST", body } as unknown as Parameters<typeof api>[1])
}

function ProofCard({ proof }: { proof: Proof }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: LOCKER_KEY })
  const [error, setError] = useState<string | null>(null)
  const recheck = useMutation({
    mutationFn: () => api(`/api/me/proofs/${proof.id}/recheck`, { method: "POST" }),
    onSuccess: refresh,
  })
  const setKind = useMutation({
    mutationFn: (kind: Proof["kind"]) => api(`/api/me/proofs/${proof.id}`, { method: "PATCH", json: { kind } }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => api(`/api/me/proofs/${proof.id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not remove this file."),
  })
  return (
    <li className="rounded-md bg-surface p-4 ring-1 ring-inset ring-line">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <a href={proof.url} target="_blank" rel="noreferrer" className="break-all font-medium text-accent hover:underline">
            {proof.filename}
          </a>
          <Meta className="block">
            {formatBytes(proof.size)}
            {proof.publication_title ? ` · ${proof.publication_title}` : ""}
            {proof.used_on.length ? ` · on ${proof.used_on.length} claim${proof.used_on.length === 1 ? "" : "s"}` : ""}
          </Meta>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-fg-muted">
            <span className="sr-only">Kind of file for {proof.filename}</span>
            <select
              value={proof.kind}
              onChange={(e) => setKind.mutate(e.target.value as Proof["kind"])}
              className="rounded-md bg-surface px-2 py-1 text-sm ring-1 ring-inset ring-line"
            >
              {(Object.keys(KIND_LABEL) as Proof["kind"][]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" kind="quiet" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
            <RefreshCw className={cn(recheck.isPending && "animate-spin")} />
            Check again
          </Button>
          <Button size="icon" kind="quiet" aria-label={`Remove ${proof.filename}`} onClick={() => remove.mutate()}>
            <Trash2 className="text-critical" />
          </Button>
        </div>
      </div>
      <ProofChecks checks={proof.checks} />
      {error && (
        <p role="alert" className="mt-2 text-sm text-critical">
          {error}
        </p>
      )}
    </li>
  )
}

/**
 * The proof locker: upload a paper or reference once, see what the research
 * office would send it back for, and reuse it on any claim.
 */
export function ProofLocker() {
  const locker = useLocker()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<Proof["kind"]>("ARTICLE")
  const [over, setOver] = useState(false)
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null)
  const upload = useMutation({
    mutationFn: (file: File) => uploadProof(file, kind),
    onSuccess: (p) => {
      setNote({ tone: "ok", text: p.already_in_locker ? `${p.filename} is already in your locker.` : `${p.filename} was added and checked.` })
      void qc.invalidateQueries({ queryKey: LOCKER_KEY })
    },
    onError: (e) => setNote({ tone: "bad", text: e instanceof ApiError ? e.message : "The upload did not go through." }),
  })
  const send = (files: FileList | File[] | null) => {
    for (const f of Array.from(files || [])) upload.mutate(f)
  }
  const items = locker.data?.items ?? []

  return (
    <div className="page space-y-6 pb-24 sm:pb-6">
      <PageHeader
        title="Proof locker"
        sub="Upload each paper and reference once. We check it for the things claims are sent back for, and you can attach it to any claim."
        action={
          <Button kind="default" asChild>
            <Link to="/papers">My papers</Link>
          </Button>
        }
      />

      <div
        className={cn(
          "flex flex-col items-center gap-3 rounded-md border border-dashed p-5 text-center",
          over ? "border-accent bg-accent-wash" : "border-edge bg-sunken"
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          send(e.dataTransfer.files)
        }}
      >
        <fieldset className="flex flex-wrap justify-center gap-3 text-sm">
          <legend className="sr-only">What kind of file</legend>
          {(["ARTICLE", "REFERENCE", "OTHER"] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="radio" name="proof-kind" checked={kind === k} onChange={() => setKind(k)} />
              {KIND_LABEL[k]}
            </label>
          ))}
        </fieldset>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-testid="locker-input"
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : []
            e.target.value = ""
            send(files)
          }}
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button kind="primary" onClick={() => input.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? <LoaderCircle className="animate-spin" /> : <Upload />}
            {upload.isPending ? "Uploading and checking" : "Choose files"}
          </Button>
          <span className="text-sm text-fg-subtle">or drop them here. PDF, scan or photo, up to 10 MB.</span>
        </div>
        {note && (
          <p role="status" className={cn("text-sm", note.tone === "ok" ? "text-positive" : "text-critical")}>
            {note.text}
          </p>
        )}
      </div>

      {locker.isError ? (
        <ErrorState title="Could not open your locker." message="The server did not answer." onRetry={() => void locker.refetch()} />
      ) : locker.isLoading ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Your locker is empty"
          message="Add your published article and the SEC references it cites. Files you upload while filing a claim are saved here too."
        />
      ) : (
        <ul className="space-y-3">
          {items.map((p) => (
            <ProofCard key={p.id} proof={p} />
          ))}
        </ul>
      )}
    </div>
  )
}

export default ProofLocker
