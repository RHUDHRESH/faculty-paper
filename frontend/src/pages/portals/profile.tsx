"use client"

import { type FormEvent, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Copy, ExternalLink, Plus } from "lucide-react"

import { useAuth } from "@/components/auth-provider"
import { SCOPUS_FEEDBACK_WIZARD } from "@/components/claim-eligibility-notice"
import {
  Callout,
  ChoiceCards,
  Field,
  FieldGrid,
  FieldSpan,
  ReadOnlyField,
} from "@/components/form/fields"
import { PageHeader, Section } from "@/components/layout/page"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, type User } from "@/lib/api"
import { DESIGNATIONS, extractScopusAuthorId } from "@/lib/claim-fields"

/**
 * Held by the research cell on purpose: department routes the approval and the
 * biometric ID picks the bank account, and both are copied onto every claim as
 * server-owned values. A claimant who could edit them could redirect a payment.
 */
const LOCKED_HINT =
  "Held on your staff record by the research cell. It decides which department your tickets are filed under and which account is paid, so it cannot be edited here."

function correctionRequest(user: User | null): string {
  return [
    `Profile correction request — ${user?.name || ""} (${user?.email || ""})`,
    `Department: ${user?.department || "not set"}`,
    `Staff ID: ${user?.staff_id || "not set"}`,
    `Biometric ID: ${user?.biometric_id || "not set"}`,
    "",
    "Please correct: ",
  ].join("\n")
}

export function FacultyProfilePage() {
  const { user, refresh } = useAuth()
  const [form, setForm] = useState({
    name: "",
    designation: "",
    scopus_author_url: "",
    scopus_author_id: "",
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    setForm({
      name: user.name || "",
      designation: user.designation || "",
      scopus_author_url: user.scopus_author_url || "",
      scopus_author_id: user.scopus_author_id || "",
    })
  }, [user])

  /** What a claim needs before it can even be filed, listed where it can be fixed. */
  const missing = useMemo(() => {
    const gaps: string[] = []
    if (!form.name.trim()) gaps.push("your name")
    if (!form.designation.trim()) gaps.push("your designation")
    if (!form.scopus_author_url.trim()) gaps.push("your Scopus author link")
    if (!user?.department) gaps.push("your department (research cell)")
    if (!user?.biometric_id) gaps.push("your Biometric ID (research cell)")
    return gaps
  }, [form, user])

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
        subtitle="Your identity details autofill on every new ticket"
        actions={
          <Button asChild variant="secondary">
            <Link to="/faculty/new">
              <Plus className="size-4" />
              New ticket
            </Link>
          </Button>
        }
      />

      <form onSubmit={onSubmit} className="mx-auto max-w-2xl space-y-6">
        {missing.length ? (
          <Callout tone="warning" title="Your profile is not ready for a claim yet">
            Still missing: {missing.join(", ")}. Anything marked "research cell" has to be corrected
            by them — everything else you can set below.
          </Callout>
        ) : (
          <Callout tone="success" title="Your profile is complete">
            Every new ticket starts pre-filled with these details.
          </Callout>
        )}

        <Section title="Your details" description="Yours to edit. Saved to every future ticket.">
          <div className="rounded-2xl border border-border bg-card p-5">
            <FieldGrid>
              <FieldSpan>
                <Field label="Full name" htmlFor="p-name" required>
                  <Input
                    id="p-name"
                    className="h-9"
                    autoComplete="name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </Field>
              </FieldSpan>

              <FieldSpan>
                <Field label="Designation" required>
                  <ChoiceCards
                    name="Designation"
                    columns={2}
                    value={form.designation}
                    onChange={(v) => setForm({ ...form, designation: v })}
                    options={DESIGNATIONS.map((d) => ({ value: d, label: d }))}
                  />
                </Field>
              </FieldSpan>
            </FieldGrid>
          </div>
        </Section>

        <Section
          title="Scopus"
          description="The article on a claim must be indexed and linked to this author profile."
        >
          <div className="rounded-2xl border border-border bg-card p-5">
            <FieldGrid>
              <FieldSpan>
                <Field
                  label="Author profile link"
                  htmlFor="p-scopus-url"
                  required
                  hint={
                    <>
                      Linked to the wrong or a duplicate ID? Merge it with the{" "}
                      <a
                        href={SCOPUS_FEEDBACK_WIZARD}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                      >
                        Scopus Author Feedback Wizard
                        <ExternalLink className="size-3" aria-hidden />
                      </a>{" "}
                      before you file a claim.
                    </>
                  }
                >
                  <Input
                    id="p-scopus-url"
                    className="h-9"
                    inputMode="url"
                    placeholder="https://www.scopus.com/authid/detail.uri?authorId=…"
                    value={form.scopus_author_url}
                    onChange={(e) => {
                      const url = e.target.value
                      const derived = extractScopusAuthorId(url)
                      setForm((f) => ({
                        ...f,
                        scopus_author_url: url,
                        scopus_author_id:
                          derived && !f.scopus_author_id ? derived : f.scopus_author_id,
                      }))
                    }}
                  />
                </Field>
              </FieldSpan>

              <FieldSpan>
                <Field
                  label="Author ID"
                  htmlFor="p-scopus-id"
                  hint="Read from the link above when left empty. Used to check an article really sits on your profile."
                >
                  <Input
                    id="p-scopus-id"
                    className="h-9 font-mono tabular-nums"
                    inputMode="numeric"
                    placeholder="57200000000"
                    value={form.scopus_author_id}
                    onChange={(e) => setForm({ ...form, scopus_author_id: e.target.value })}
                  />
                </Field>
              </FieldSpan>
            </FieldGrid>
          </div>
        </Section>

        <Section
          title="Payment record"
          description="Held by the research cell. Ask them to correct anything wrong here."
          actions={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(correctionRequest(user))
                  .then(() => toast.success("Correction request copied"))
                  .catch(() => toast.error("Could not copy — select the values manually"))
              }}
            >
              <Copy className="size-3.5" />
              Copy request
            </Button>
          }
        >
          <div className="rounded-2xl border border-border bg-card p-5">
            <FieldGrid>
              <ReadOnlyField
                label="Email"
                value={user?.email}
                manageHint="Your login address. The research cell changes this."
              />
              <ReadOnlyField
                label="Department"
                value={user?.department}
                manageHint={LOCKED_HINT}
              />
              <ReadOnlyField label="Staff ID" value={user?.staff_id} mono manageHint={LOCKED_HINT} />
              <ReadOnlyField
                label="Biometric ID"
                value={user?.biometric_id}
                mono
                manageHint={LOCKED_HINT}
              />
            </FieldGrid>
          </div>
        </Section>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Saving…" : "Save profile"}
        </Button>
      </form>
    </div>
  )
}
