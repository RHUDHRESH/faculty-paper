"use client"

import { type FormEvent, useEffect, useState } from "react"
import { toast } from "sonner"
import { useAuth } from "@/components/auth-provider"
import { InsetList, InsetRow, PageHeader, Section } from "@/components/layout/page"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/api"

export function FacultyProfilePage() {
  const { user, refresh } = useAuth()
  const [form, setForm] = useState({
    name: "",
    department: "",
    staff_id: "",
    biometric_id: "",
    designation: "",
    scopus_author_url: "",
    scopus_author_id: "",
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    setForm({
      name: user.name || "",
      department: user.department || "",
      staff_id: user.staff_id || "",
      biometric_id: user.biometric_id || "",
      designation: user.designation || "",
      scopus_author_url: user.scopus_author_url || "",
      scopus_author_id: user.scopus_author_id || "",
    })
  }, [user])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api("/api/auth/profile", { method: "PATCH", json: form })
      await refresh()
      toast.success("Profile saved")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Profile"
        subtitle="Staff ID and Scopus link autofill on new tickets"
      />
      <form onSubmit={onSubmit} className="mx-auto max-w-lg space-y-6">
        <Section title="Account">
          <InsetList>
            <InsetRow label="Email">{user?.email}</InsetRow>
          </InsetList>
        </Section>
        <Section title="Identity">
          <InsetList>
            {(
              [
                ["name", "Name"],
                ["department", "Department"],
                ["staff_id", "Staff ID"],
                ["biometric_id", "Biometric ID"],
                ["designation", "Designation"],
              ] as const
            ).map(([key, label]) => (
              <InsetRow key={key} label={label}>
                <Input
                  className="border-0 bg-transparent text-right shadow-none focus-visible:ring-0"
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </InsetRow>
            ))}
          </InsetList>
        </Section>
        <Section title="Scopus">
          <InsetList>
            <InsetRow label="Author ID">
              <Input
                className="border-0 bg-transparent text-right shadow-none focus-visible:ring-0"
                value={form.scopus_author_id}
                onChange={(e) =>
                  setForm({ ...form, scopus_author_id: e.target.value })
                }
              />
            </InsetRow>
            <div className="space-y-2 p-4">
              <Label htmlFor="scopus-url">Author URL</Label>
              <Input
                id="scopus-url"
                value={form.scopus_author_url}
                onChange={(e) =>
                  setForm({ ...form, scopus_author_url: e.target.value })
                }
              />
            </div>
          </InsetList>
        </Section>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Saving…" : "Save profile"}
        </Button>
      </form>
    </div>
  )
}
