import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { useAuth } from "@/components/auth-provider"
import { Money } from "@/components/ticket-ui"
import { InsetList, InsetRow, Section, Stepper, StickyActions } from "@/components/layout/page"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api, ensureCsrf, type Claim } from "@/lib/api"
import {
  buildClaimPayload,
  claimToFormState,
  formStateFromFacultyOption,
  formStateFromUser,
  INDEXING_LEVELS,
  PUBLICATION_STEPS,
  PUBLICATION_TYPES,
  QUARTILE_OPTIONS,
  type PublicationFormState,
} from "@/lib/claim-fields"

type FacultyOption = {
  owner_id?: string | null
  master_id?: string | null
  name: string
  email?: string | null
  department?: string | null
  staff_id?: string | null
  biometric_id?: string | null
  designation?: string | null
  scopus_author_url?: string | null
  has_user_account?: boolean
}

async function uploadPdf(file: File): Promise<string> {
  const fd = new FormData()
  fd.append("file", file)
  const csrf = await ensureCsrf()
  const res = await fetch(`${import.meta.env.VITE_API_BASE || ""}/api/claims/upload`, {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRFToken": csrf },
    body: fd,
  })
  if (!res.ok) {
    let msg = "Upload failed"
    try {
      const err = await res.json()
      msg = err.detail || msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const data = await res.json()
  return data.url as string
}

export function PublicationForm({
  mode,
  claimId,
  onSuccess,
}: {
  mode: "faculty" | "admin"
  claimId?: string | null
  onSuccess?: (claim: Claim) => void
}) {
  const { user } = useAuth()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<PublicationFormState>(() =>
    user ? formStateFromUser(user) : formStateFromUser({})
  )
  const [facultyOptions, setFacultyOptions] = useState<FacultyOption[]>([])
  const [facultyQuery, setFacultyQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [calc, setCalc] = useState<{ remuneration?: number | null; error?: string | null } | null>(
    null
  )
  const [sendAnywayOpen, setSendAnywayOpen] = useState(false)
  const [sendNote, setSendNote] = useState("")
  const [blockReason, setBlockReason] = useState("")
  const [successOpen, setSuccessOpen] = useState(false)
  const [issuedTicket, setIssuedTicket] = useState<string | null>(null)
  const [issuedId, setIssuedId] = useState<string | null>(null)
  const [issuedAmount, setIssuedAmount] = useState<number | null>(null)

  useEffect(() => {
    if (mode === "faculty" && user) {
      setForm(formStateFromUser(user))
    }
  }, [mode, user])

  useEffect(() => {
    if (!claimId) return
    api<Claim>(`/api/claims/${claimId}`)
      .then((c) => setForm(claimToFormState(c)))
      .catch(() => toast.error("Could not load ticket"))
  }, [claimId])

  useEffect(() => {
    if (mode !== "admin") return
    const q = facultyQuery.trim()
    const t = setTimeout(() => {
      api<FacultyOption[]>(`/api/admin/faculty-options${q ? `?q=${encodeURIComponent(q)}` : ""}`)
        .then(setFacultyOptions)
        .catch(() => setFacultyOptions([]))
    }, 200)
    return () => clearTimeout(t)
  }, [mode, facultyQuery])

  function set<K extends keyof PublicationFormState>(key: K, value: PublicationFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function recalc() {
    try {
      const c = await api<{ remuneration?: number | null; error?: string | null }>("/api/calculate", {
        method: "POST",
        json: {
          snip: form.snip === "" ? null : Number(form.snip),
          quartile: form.quartile || form.self_reported_quartile || null,
          total_authors: form.total_authors,
          author_position: form.author_position,
          publication_type: form.aggregation_type || form.publication_type,
        },
      })
      setCalc(c)
    } catch {
      /* optional */
    }
  }

  async function quietFill() {
    if (!form.paper_title.trim()) return
    try {
      const res = await api<{
        ok: boolean
        matched_title?: string
        doi?: string
        issn?: string
        journal?: string
        snip?: number | null
        quartile?: string | null
        paper?: { aggregation_type?: string; publication_year?: number }
      }>("/api/lookup/enrich", {
        method: "POST",
        json: { doi: form.doi || null, title: form.paper_title.trim() },
      })
      if (!res.ok) return
      setForm((f) => ({
        ...f,
        paper_title: res.matched_title || f.paper_title,
        doi: res.doi || f.doi,
        issn: res.issn || f.issn,
        journal_title: res.journal || f.journal_title,
        snip: res.snip != null ? String(res.snip) : f.snip,
        quartile: res.quartile || f.quartile,
        self_reported_quartile: res.quartile || f.self_reported_quartile,
        aggregation_type: res.paper?.aggregation_type || f.aggregation_type,
        publication_type: res.paper?.aggregation_type || f.publication_type,
        publication_year:
          res.paper?.publication_year && !f.publication_year ?
            String(res.paper.publication_year)
          : f.publication_year,
      }))
      await recalc()
    } catch {
      /* silent */
    }
  }

  async function handleUpload(field: "proof_url" | "sec_proof_url", file: File | null) {
    if (!file) return
    setBusy(true)
    try {
      const url = await uploadPdf(file)
      set(field, url)
      toast.success("File uploaded")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setBusy(false)
    }
  }

  async function save(submit: boolean, sendAnyway = false) {
    if (!form.paper_title.trim()) {
      toast.error("Enter the paper title")
      return
    }
    if (mode === "admin" && !form.owner_id) {
      toast.error("Select a faculty member")
      return
    }
    setBusy(true)
    try {
      if (submit && !sendAnyway) await quietFill()
      const payload = buildClaimPayload(form, {
        submit,
        contest_forward: sendAnyway,
        contest_note: sendNote,
        owner_id: mode === "admin" ? form.owner_id : undefined,
      })
      const claim =
        claimId ?
          await api<Claim>(`/api/claims/${claimId}`, { method: "PATCH", json: payload })
        : await api<Claim>("/api/claims", { method: "POST", json: payload })

      if (submit && claim.ticket_number) {
        setIssuedTicket(claim.ticket_number)
        setIssuedId(claim.id)
        setIssuedAmount(claim.remuneration ?? calc?.remuneration ?? null)
        setSuccessOpen(true)
        setSendAnywayOpen(false)
        toast.success("Submitted")
        onSuccess?.(claim)
      } else if (!submit) {
        toast.success("Draft saved")
        onSuccess?.(claim)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Submit failed"
      if (submit && !sendAnyway && /auto-confirm|send with a short note|Could not/i.test(message)) {
        setBlockReason(message)
        setSendAnywayOpen(true)
      } else {
        toast.error(message)
      }
    } finally {
      setBusy(false)
    }
  }

  const identityStep = (
    <Section title="Faculty identity">
      {mode === "admin" ? (
        <InsetList>
          <div className="space-y-2 p-4">
            <Label htmlFor="faculty-search">Search faculty</Label>
            <Input
              id="faculty-search"
              placeholder="Name, staff ID, or email"
              value={facultyQuery}
              onChange={(e) => setFacultyQuery(e.target.value)}
            />
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {facultyOptions.length === 0 ?
                <p className="px-2 py-3 text-sm text-muted-foreground">No matches</p>
              : facultyOptions.map((opt) => (
                  <button
                    key={`${opt.owner_id || opt.master_id}`}
                    type="button"
                    className="flex w-full flex-col rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setForm(formStateFromFacultyOption(opt))
                      if (!opt.has_user_account) {
                        toast.warning("No login account — create user before submitting")
                      }
                    }}
                  >
                    <span className="font-medium">{opt.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {opt.staff_id} · {opt.department || "—"}
                      {opt.has_user_account ? "" : " · no account"}
                    </span>
                  </button>
                ))
              }
            </div>
          </div>
        </InsetList>
      ) : null}
      <InsetList>
        <InsetRow label="Email">
          <Input className="border-0 bg-transparent text-right shadow-none" value={form.email} readOnly />
        </InsetRow>
        <InsetRow label="Faculty name">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.faculty_name}
            readOnly={mode === "faculty"}
            onChange={(e) => set("faculty_name", e.target.value)}
          />
        </InsetRow>
        <InsetRow label="Department">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.department}
            readOnly={mode === "faculty"}
            onChange={(e) => set("department", e.target.value)}
          />
        </InsetRow>
        <InsetRow label="Staff ID">
          <Input className="border-0 bg-transparent text-right shadow-none" value={form.staff_id} readOnly />
        </InsetRow>
        <InsetRow label="Biometric ID">
          <Input className="border-0 bg-transparent text-right shadow-none" value={form.biometric_id} readOnly />
        </InsetRow>
        <InsetRow label="Designation">
          <Input className="border-0 bg-transparent text-right shadow-none" value={form.designation} readOnly />
        </InsetRow>
        <InsetRow label="Scopus author link">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.scopus_author_url}
            onChange={(e) => set("scopus_author_url", e.target.value)}
            placeholder="https://"
          />
        </InsetRow>
      </InsetList>
    </Section>
  )

  const publicationStep = (
    <Section title="Publication details">
      <InsetList>
        <div className="space-y-2 p-4">
          <Label htmlFor="paper_title">Title of the paper</Label>
          <Textarea
            id="paper_title"
            rows={3}
            className="resize-none"
            value={form.paper_title}
            onChange={(e) => set("paper_title", e.target.value)}
            onBlur={() => quietFill()}
          />
        </div>
        <InsetRow label="Journal name">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.journal_title}
            onChange={(e) => set("journal_title", e.target.value)}
          />
        </InsetRow>
        <InsetRow label="Journal quartile">
          <Select
            value={form.self_reported_quartile || form.quartile}
            onValueChange={(v) => {
              set("self_reported_quartile", v)
              set("quartile", v)
              setTimeout(recalc, 0)
            }}
          >
            <SelectTrigger className="border-0 bg-transparent shadow-none">
              <SelectValue placeholder="Q1–Q4" />
            </SelectTrigger>
            <SelectContent>
              {QUARTILE_OPTIONS.map((q) => (
                <SelectItem key={q} value={q}>
                  {q}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InsetRow>
        <InsetRow label="ISSN">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.issn}
            onChange={(e) => set("issn", e.target.value)}
          />
        </InsetRow>
        <InsetRow label="Yukthi ID">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.yukthi_id}
            onChange={(e) => set("yukthi_id", e.target.value)}
          />
        </InsetRow>
        <InsetRow label="Date of publication">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            placeholder="YYYY-MM-DD"
            value={form.publication_date}
            onChange={(e) => set("publication_date", e.target.value)}
          />
        </InsetRow>
        <InsetRow label="Publication type">
          <Select
            value={form.publication_type}
            onValueChange={(v) => {
              set("publication_type", v)
              set("aggregation_type", v)
            }}
          >
            <SelectTrigger className="border-0 bg-transparent shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PUBLICATION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InsetRow>
        <InsetRow label="Indexing level">
          <Select value={form.indexing_level} onValueChange={(v) => set("indexing_level", v)}>
            <SelectTrigger className="border-0 bg-transparent shadow-none">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {INDEXING_LEVELS.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InsetRow>
        <InsetRow label="AU / UGC ref">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.indexing_ref}
            onChange={(e) => set("indexing_ref", e.target.value)}
            placeholder="Ref no or NA"
          />
        </InsetRow>
        <InsetRow label="DOI">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.doi}
            onChange={(e) => set("doi", e.target.value)}
          />
        </InsetRow>
        <InsetRow label="Subject category">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.subject_category}
            onChange={(e) => set("subject_category", e.target.value)}
          />
        </InsetRow>
      </InsetList>
    </Section>
  )

  const authorsStep = (
    <Section title="Authors and metrics">
      <InsetList>
        <InsetRow label="Total authors">
          <Input
            type="number"
            min={1}
            className="border-0 bg-transparent text-right shadow-none"
            value={form.total_authors}
            onChange={(e) => set("total_authors", Number(e.target.value) || 1)}
            onBlur={recalc}
          />
        </InsetRow>
        <InsetRow label="Your position">
          <Input
            type="number"
            min={1}
            className="border-0 bg-transparent text-right shadow-none"
            value={form.author_position}
            onChange={(e) => set("author_position", Number(e.target.value) || 1)}
            onBlur={recalc}
          />
        </InsetRow>
        <InsetRow label="SNIP">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.snip}
            onChange={(e) => set("snip", e.target.value)}
            onBlur={recalc}
          />
        </InsetRow>
        <InsetRow label="Impact factor">
          <Input
            className="border-0 bg-transparent text-right shadow-none"
            value={form.impact_factor}
            onChange={(e) => set("impact_factor", e.target.value)}
          />
        </InsetRow>
        <div className="flex items-center justify-between px-4 py-3">
          <Label htmlFor="student-pub">Student publication</Label>
          <Switch
            id="student-pub"
            checked={form.is_student_publication}
            onCheckedChange={(v) => set("is_student_publication", v)}
          />
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <Label htmlFor="affiliation-ok">Saveetha affiliation confirmed</Label>
          <Switch
            id="affiliation-ok"
            checked={form.affiliation_ok}
            onCheckedChange={(v) => set("affiliation_ok", v)}
          />
        </div>
      </InsetList>
    </Section>
  )

  const documentsStep = (
    <Section title="Proofs and references">
      <InsetList>
        <div className="space-y-2 p-4">
          <Label htmlFor="proof">Upload proof (PDF)</Label>
          <Input
            id="proof"
            type="file"
            accept="application/pdf"
            onChange={(e) => handleUpload("proof_url", e.target.files?.[0] || null)}
          />
          {form.proof_url ?
            <p className="text-xs text-muted-foreground">Uploaded: {form.proof_url}</p>
          : null}
        </div>
        <div className="space-y-2 p-4">
          <Label htmlFor="sec_refs">Reference numbers (SEC affiliation)</Label>
          <Textarea
            id="sec_refs"
            rows={2}
            className="resize-none"
            value={form.sec_refs}
            onChange={(e) => set("sec_refs", e.target.value)}
          />
        </div>
        <div className="space-y-2 p-4">
          <Label htmlFor="reference_articles">List reference articles (SEC affiliation)</Label>
          <Textarea
            id="reference_articles"
            rows={3}
            className="resize-none"
            value={form.reference_articles}
            onChange={(e) => set("reference_articles", e.target.value)}
          />
        </div>
        <div className="space-y-2 p-4">
          <Label htmlFor="sec_proof">Upload reference papers (PDF)</Label>
          <Input
            id="sec_proof"
            type="file"
            accept="application/pdf"
            onChange={(e) => handleUpload("sec_proof_url", e.target.files?.[0] || null)}
          />
          {form.sec_proof_url ?
            <p className="text-xs text-muted-foreground">Uploaded: {form.sec_proof_url}</p>
          : null}
        </div>
      </InsetList>
    </Section>
  )

  const reviewStep = (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Review submission</CardTitle>
          <CardDescription>Confirm all ERP fields before submitting.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <span className="text-muted-foreground">Faculty:</span> {form.faculty_name} ({form.staff_id})
          </p>
          <p>
            <span className="text-muted-foreground">Paper:</span> {form.paper_title || "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Journal:</span> {form.journal_title || "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Quartile:</span>{" "}
            {form.quartile || form.self_reported_quartile || "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Indexing:</span> {form.indexing_level || "—"}
          </p>
          {calc?.remuneration != null ?
            <p className="text-lg font-semibold">
              Estimated: <Money value={calc.remuneration} />
            </p>
          : null}
        </CardContent>
      </Card>
    </div>
  )

  const steps = [identityStep, publicationStep, authorsStep, documentsStep, reviewStep]
  const isFirst = step === 0
  const isLast = step === PUBLICATION_STEPS.length - 1

  return (
    <div className="pb-24">
      <div className="mb-6">
        <Stepper steps={[...PUBLICATION_STEPS]} current={step} />
      </div>
      <div className="space-y-4">{steps[step]}</div>

      <StickyActions>
        {!isFirst ?
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setStep((s) => s - 1)}>
            Back
          </Button>
        : null}
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !form.paper_title.trim()}
          onClick={() => save(false)}
        >
          Save draft
        </Button>
        {isLast ?
          <Button
            type="button"
            disabled={busy || !form.paper_title.trim()}
            onClick={() => save(true, false)}
          >
            {busy ? "Submitting…" : "Submit"}
          </Button>
        : <Button type="button" disabled={busy} onClick={() => setStep((s) => s + 1)}>
            Continue
          </Button>
        }
      </StickyActions>

      <AlertDialog open={sendAnywayOpen} onOpenChange={setSendAnywayOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send for approval anyway?</AlertDialogTitle>
            <AlertDialogDescription>{blockReason}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="send-note">Note (10+ characters)</Label>
            <Textarea
              id="send-note"
              rows={3}
              className="resize-none"
              value={sendNote}
              onChange={(e) => setSendNote(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Edit details</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || sendNote.trim().length < 10}
              onClick={(e) => {
                e.preventDefault()
                save(true, true)
              }}
            >
              Send anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={successOpen} onOpenChange={setSuccessOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submitted</DialogTitle>
            <DialogDescription>Your ticket is with HoD for approval.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-center">
            <p className="font-mono text-3xl font-semibold tracking-tight text-primary">
              {issuedTicket}
            </p>
            {issuedAmount != null ?
              <p className="text-sm text-muted-foreground">
                Estimated: <Money value={issuedAmount} />
              </p>
            : null}
          </div>
          <DialogFooter>
            <Button asChild className="w-full">
              <Link to={mode === "admin" ? "/admin" : `/faculty?claim=${issuedId}`}>
                {mode === "admin" ? "Back to admin" : "View ticket"}
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
