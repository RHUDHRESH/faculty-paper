import { Link } from "react-router-dom"
import { MessageCircle } from "lucide-react"
import { useApi } from "@/lib/query"

type ThreadRow = { id: string; title: string; post_count?: number }

/** Where the ticket's "messages" link goes: the office thread about this
 *  claim when there is one, else the office inbox. */
export function officeThreadLink(rows: ThreadRow[] | undefined): { to: string; label: string } {
  const t = rows?.[0]
  if (t) {
    const n = t.post_count ?? 0
    return { to: `/messages/o/${t.id}`, label: `Open their messages about this claim${n ? ` (${n})` : ""}` }
  }
  return { to: "/messages/office", label: "No messages about this claim yet. Open the office inbox" }
}

/** The claimant's conversation with the research office about this ticket. */
export function ClaimOfficeThread({ claimId }: { claimId: string }) {
  const q = useApi<{ results: ThreadRow[] }>(
    ["threads", "office", "claim", claimId],
    `/api/threads?visibility=OFFICE&claim=${encodeURIComponent(claimId)}&limit=5`,
  )
  if (q.isLoading) return null
  const link = officeThreadLink(q.data?.results)
  return (
    <p className="text-sm">
      <Link to={link.to} className="inline-flex items-center gap-1.5 text-accent underline-offset-2 hover:underline">
        <MessageCircle className="size-4" aria-hidden />
        {link.label}
      </Link>
    </p>
  )
}
