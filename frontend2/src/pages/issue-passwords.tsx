import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, KeyRound } from "lucide-react"

import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, Radio } from "@/ui/field"
import { Details } from "@/ui/section"
import { Callout, InlineError } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { useApi } from "@/lib/query"

/**
 * Give a group of people a new one-time password and download the list.
 *
 * The accounts were created by an import that threw its generated passwords
 * away, so nobody but the super admin can sign in. Without this the office
 * would have to reset four hundred people one at a time, typing a password for
 * each. The server makes the passwords and answers with the file exactly once:
 * this dialog hands it to the browser as a download and keeps no copy, so
 * there is nothing here to show again, and it says so.
 */

type Who = "no_password_yet" | "role" | "department" | "all"

type Preview = {
  count: number
  by_role: { role: string; count: number }[]
  by_department: { department: string; count: number }[]
}

const ROLE_WORDS: Record<string, string> = {
  FACULTY: "Faculty",
  HOD: "Heads of department",
  PRINCIPAL: "Principal",
  DIRECTOR: "Director",
  FINANCE: "Finance",
  RESEARCH_CELL: "Research cell",
  RESEARCH_COORDINATOR: "Research coordinator",
  SUPER_ADMIN: "Super admin",
}
const roleWord = (r: string) => ROLE_WORDS[r] ?? r.replace(/_/g, " ").toLowerCase()

const ROLE_OPTIONS: ComboboxOption[] = Object.keys(ROLE_WORDS)
  .filter((r) => r !== "SUPER_ADMIN")
  .map((r) => ({ value: r, label: ROLE_WORDS[r] }))

const WHO_CHOICES: { value: Who; label: string; hint?: string }[] = [
  {
    value: "no_password_yet",
    label: "Everyone who has never signed in",
    hint: "Anyone who has signed in keeps their password.",
  },
  { value: "role", label: "A role" },
  { value: "department", label: "A department" },
  { value: "all", label: "Everyone", hint: "Includes people who have already signed in." },
]

/** What the server is asked, without the dry-run flag. Null while the choice is unfinished. */
function scopeBody(who: Who, role: string, department: string, inactive: boolean) {
  if (who === "role" && !role) return null
  if (who === "department" && !department) return null
  return {
    who,
    ...(who === "role" ? { role } : {}),
    ...(who === "department" ? { department } : {}),
    include_inactive: inactive,
  }
}

/** Hand the text to the browser as a file. The BOM is put back because
 *  `Response.text()` drops it, and Excel needs it to read names correctly. */
function download(text: string, filename: string) {
  const blob = new Blob(["﻿", text], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Later, not now: some browsers start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function IssuePasswordsDialog({ onClose }: { onClose: () => void }) {
  const [who, setWho] = useState<Who>("no_password_yet")
  const [role, setRole] = useState("")
  const [department, setDepartment] = useState("")
  const [inactive, setInactive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ count: number; filename: string } | null>(null)

  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments")
  const body = scopeBody(who, role, department, inactive)

  const preview = useQuery<Preview, Error>({
    queryKey: ["issue-passwords", "preview", body],
    queryFn: () => api<Preview>("/api/admin/passwords/issue", { method: "POST", json: { ...body, dry_run: true } }),
    enabled: body !== null && !done,
    // Never reuse an old count: it is the number the button will promise.
    gcTime: 0,
    staleTime: 0,
  })
  const count = preview.data?.count
  const ready = body !== null && count !== undefined && !preview.isFetching

  async function issue() {
    if (!body || !ready || !count) return
    setBusy(true)
    try {
      // The response is the sign-in list, not JSON: `api` hands back the text.
      const text = await api<string>("/api/admin/passwords/issue", { method: "POST", json: { ...body, dry_run: false } })
      const lines = String(text).trim().split("\n").length - 1
      const filename = `sign-in-list-${new Date().toISOString().slice(0, 10)}.csv`
      download(String(text), filename)
      setDone({ count: lines, filename })
    } catch (err) {
      toast.fail(err)
    } finally {
      setBusy(false)
    }
  }

  const departmentOptions: ComboboxOption[] = (departments.data ?? []).map((d) => ({ value: d, label: d }))

  if (done) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{formatCount(done.count)} passwords issued</DialogTitle>
            <DialogDescription>The list has been downloaded as {done.filename}.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Callout tone="caution" title="This list will not be shown again">
              Hand each person their own line, then delete the file. They choose their own password at first sign-in.
            </Callout>
          </DialogBody>
          <DialogFooter>
            <Button kind="primary" onClick={onClose}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Issue passwords</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {/* First, not last: with the department list open the body scrolls,
              and a warning at the foot is the part that scrolls away. */}
          <Callout tone="caution" title="Their current passwords stop working">
            The list downloads once. Keep it safe.
          </Callout>

          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">Who gets a new password</legend>
            {WHO_CHOICES.map((c) => (
              <div key={c.value} className="space-y-2">
                <Radio
                  name="who"
                  checked={who === c.value}
                  onChange={() => setWho(c.value)}
                  label={c.label}
                  hint={c.hint}
                />
                {who === c.value && c.value === "role" && (
                  <div className="pl-7">
                    <Combobox
                      value={role}
                      onChange={setRole}
                      options={ROLE_OPTIONS}
                      placeholder="Choose a role"
                      aria-label="Role"
                    />
                  </div>
                )}
                {who === c.value && c.value === "department" && (
                  <div className="pl-7">
                    <Combobox
                      value={department}
                      onChange={setDepartment}
                      options={departmentOptions}
                      placeholder={departments.isLoading ? "Loading…" : "Choose a department"}
                      aria-label="Department"
                      disabled={departments.isLoading}
                    />
                  </div>
                )}
              </div>
            ))}
          </fieldset>

          <Checkbox
            checked={inactive}
            onCheckedChange={(v) => setInactive(v === true)}
            label="Include people who have left"
            hint="Your account and other super admins are never included."
          />

          <div>
            <p className="mb-1.5 text-sm font-medium">Who this reaches</p>
            <div aria-live="polite" className="text-sm">
              {body === null ? (
                <Meta>Choose {who === "role" ? "a role" : "a department"} to see the count.</Meta>
              ) : preview.isError ? (
                <InlineError
                  message="Could not count who this reaches."
                  onRetry={() => void preview.refetch()}
                />
              ) : count === undefined ? (
                <Meta>Counting…</Meta>
              ) : count === 0 ? (
                <p>Nobody matches. Nothing would change.</p>
              ) : (
                <div className="space-y-1.5">
                  <p>
                    <span className="text-base font-semibold tabular">{formatCount(count)}</span>{" "}
                    {count === 1 ? "person" : "people"}:{" "}
                    {preview.data?.by_role.map((r) => `${formatCount(r.count)} ${roleWord(r.role).toLowerCase()}`).join(", ")}
                  </p>
                  {(preview.data?.by_department.length ?? 0) > 1 && (
                    <Details label="by department" count={preview.data?.by_department.length}>
                      <ul className="mt-1 max-h-40 divide-y divide-line overflow-y-auto">
                        {preview.data?.by_department.map((d) => (
                          <li key={d.department} className="flex justify-between gap-3 py-1.5">
                            <span>{d.department}</span>
                            <span className="tabular">{formatCount(d.count)}</span>
                          </li>
                        ))}
                      </ul>
                    </Details>
                  )}
                </div>
              )}
            </div>
          </div>

        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!ready || !count || busy} onClick={() => void issue()}>
            {busy ? (
              "Issuing…"
            ) : (
              <>
                <Download />
                {count ? `Issue ${formatCount(count)} ${count === 1 ? "password" : "passwords"}` : "Issue passwords"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The Passwords entry point on People: a sentence saying how many have never
 *  signed in, and the one button. */
export function IssuePasswordsRow({ onOpen }: { onOpen: () => void }) {
  const q = useQuery<Preview, Error>({
    queryKey: ["issue-passwords", "never-signed-in"],
    queryFn: () =>
      api<Preview>("/api/admin/passwords/issue", {
        method: "POST",
        json: { who: "no_password_yet", include_inactive: false, dry_run: true },
      }),
    staleTime: 30_000,
  })
  const n = q.data?.count
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="text-sm text-fg-muted">
        {n === undefined
          ? ""
          : n === 0
            ? "Everyone has signed in."
            : `${formatCount(n)} ${n === 1 ? "account has" : "accounts have"} never signed in.`}
      </p>
      <Button kind="default" size="md" onClick={onOpen}>
        <KeyRound />
        Issue passwords
      </Button>
    </div>
  )
}
