import { api } from "@/lib/api"

export type JobStatus = {
  status: "queued" | "running_or_unknown" | "done" | "failed"
  success?: boolean
  result?: unknown
}

/** Poll a django-q2 job until it finishes or we give up. */
export async function pollJob(
  jobId: string,
  onTick?: (s: JobStatus) => void
): Promise<JobStatus> {
  for (let i = 0; i < 120; i++) {
    const s = await api<JobStatus>(`/api/admin/jobs/${jobId}`)
    onTick?.(s)
    if (s.status === "done" || s.status === "failed") return s
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { status: "running_or_unknown" }
}
