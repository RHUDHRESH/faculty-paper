import { useState } from "react"
import { Search } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { ROLE_LABEL } from "@/app/account"
import { type Role } from "@/app/auth"
import { useDebounced } from "@/app/search-engine"
import { api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog"
import { Input } from "@/ui/field"
import { Avatar, initialsOf } from "@/ui/person"
import { toast } from "@/ui/toast"

/**
 * Choose who holds an empty desk (docs/ux/29). The "Put someone at every desk"
 * step used to send the admin to a list filtered to a role nobody has: a page
 * that says "Nobody matches". Here the admin searches the college's people and
 * presses one button on a row; the same endpoint the account editor uses
 * (`PATCH /api/admin/users/{id}`) makes the change and the audit log records it.
 */

type Row = {
  id: string
  name: string
  email: string
  role: Role
  department: string | null
  designation: string | null
  photo_url?: string | null
  initials?: string
}

const HELD: Role[] = ["SUPER_ADMIN", "PRINCIPAL", "DIRECTOR", "FINANCE", "RESEARCH_CELL", "RESEARCH_COORDINATOR"]

export function ChooseDesk({
  role,
  label,
  kind = "default",
  children,
}: {
  /** The role the desk is held by (PRINCIPAL, DIRECTOR, FINANCE, RESEARCH_COORDINATOR). */
  role: Role
  /** What the desk is called ("Director"). */
  label: string
  kind?: "primary" | "default"
  children?: React.ReactNode
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const term = useDebounced(q.trim())
  const people = useApi<{ results: Row[] }>(
    ["admin", "desk-picker", term],
    `/api/admin/users?${new URLSearchParams({ q: term, active: "true", limit: "12" })}`,
    { enabled: open, placeholderData: (prev) => prev }
  )
  // Someone who already holds another desk would lose it, so they are not offered.
  const rows = (people.data?.results ?? []).filter((r) => !HELD.includes(r.role))

  async function choose(r: Row) {
    setBusy(r.id)
    try {
      await api(`/api/admin/users/${r.id}`, { method: "PATCH", json: { role } })
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin"] }),
        qc.invalidateQueries({ queryKey: ["people"] }),
      ])
      toast.ok(`${r.name} is now ${label}`)
      setOpen(false)
      setQ("")
    } catch (err) {
      toast.fail(err, `Could not make ${r.name} ${label}. Nothing was changed.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Button size="sm" kind={kind} onClick={() => setOpen(true)}>
        {children ?? `Choose the ${label}`}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Choose the {label}</DialogTitle>
            <DialogDescription>Their role changes to {label}. You can change it back in People.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input
                autoFocus
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name or email"
                aria-label={`Search for the ${label}`}
                className="pl-9"
              />
            </div>
            {people.isError ? (
              <p className="text-sm text-critical" role="alert">
                Could not search. Try again.
              </p>
            ) : rows.length === 0 && people.data ? (
              <p className="py-4 text-center text-sm text-fg-muted">Nobody matches.</p>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-2">
                    <Avatar
                      size="md"
                      person={{ name: r.name, initials: r.initials ?? initialsOf(r.name), photo_url: r.photo_url ?? null }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.name}</p>
                      <p className="truncate text-xs text-fg-muted">
                        {[r.designation, r.department, ROLE_LABEL[r.role]].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <Button size="sm" disabled={busy !== null} onClick={() => void choose(r)} aria-label={`Make ${r.name} ${label}`}>
                      Make {label}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}
