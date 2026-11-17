import { useEffect, useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useLocation } from "react-router-dom"

import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { ConfirmDialog } from "@/ui/dialog"
import { Field, Input, Select } from "@/ui/field"
import { InlineError, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

/**
 * The Profile page's "My API keys": a person's own AI, Scopus, OpenAlex and
 * Semantic Scholar accounts.
 *
 * What a person adds here is used for the features they use, on their own
 * allowance (`/api/me/keys`). The server never sends a saved key back, only
 * its last four characters, so a key box is always empty and what is typed
 * replaces whatever is saved. The super admin decides, per service, whether
 * own keys are ignored, preferred or required; each row says which applies.
 */

export type KeyField = { name: string; label: string; secret: boolean; required: boolean; help: string }

export type KeyProvider = {
  provider: "ai" | "scopus" | "openalex" | "semanticscholar"
  label: string
  about: string
  works_without_key: boolean
  fields: KeyField[]
  policy: "college" | "own_preferred" | "own_required"
  has_own_key: boolean
  masked: string
  has_inst_token: boolean
  values: Record<string, string>
  key_label: string
  source: "yours" | "college" | "none"
  ignored: boolean
  usage: { today: number; month: number }
  last_used_at: string | null
  last_test: { at: string; ok: boolean | null; message: string } | null
  problem: string
  blocked_message?: string
}

type Listing = { providers: KeyProvider[] }
type TestResult = { ok: boolean; latency_ms: number; message: string }

export const MY_KEYS = ["me", "keys"]
export const MY_KEYS_ID = "my-api-keys"
export const MY_KEYS_PATH = `/profile#${MY_KEYS_ID}`

const SERVICES: { label: string; url: string }[] = [
  { label: "Groq", url: "https://api.groq.com/openai/v1" },
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
]

/** A sentence from the server that points at My API keys, with the pointer made a link. */
export function KeyText({ text }: { text: string }) {
  const parts = text.split(/(Profile, under My API keys)/)
  if (parts.length < 3) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        part === "Profile, under My API keys" ? (
          <Link key={i} to={MY_KEYS_PATH} className="underline underline-offset-2">
            {part}
          </Link>
        ) : (
          part
        )
      )}
    </>
  )
}

/** The one sentence shown wherever a feature is unavailable because the college asks for your own key. */
export function OwnKeyNotice({ what, className }: { what: "AI" | "Scopus"; className?: string }) {
  return (
    <p className={className ?? "text-sm text-fg-muted"} data-testid="own-key-notice">
      Your college asks everyone to use their own {what} key.{" "}
      <Link to={MY_KEYS_PATH} className="underline underline-offset-2">
        Add yours in your Profile, under My API keys
      </Link>
      .
    </p>
  )
}

export function isOwnKeyRequired(code: string | null | undefined): boolean {
  return code === "own_key_required"
}

function statusOf(p: KeyProvider): { text: string; tone: "positive" | "neutral" | "critical" } {
  if (p.policy === "own_required" && !p.has_own_key) return { text: "Not available: add your key", tone: "critical" }
  if (p.source === "yours") return { text: "Using your key", tone: "positive" }
  if (p.source === "college") return { text: "Using the college key", tone: "neutral" }
  return { text: p.works_without_key ? "No key in use" : "Not available: add your key", tone: p.works_without_key ? "neutral" : "critical" }
}

function sentenceOf(p: KeyProvider): string {
  if (p.ignored) return "The college has asked everyone to use its own key for this, so the key you saved is kept but not used."
  if (p.policy === "own_required" && !p.has_own_key) return "Your college asks everyone to bring their own key for this. It stays off until you add yours."
  if (p.source === "none" && p.works_without_key) return "This works without a key. Add one only if you want your own allowance."
  if (p.source === "none") return "Nothing is set up on this server for this yet. Add your key to use it."
  return ""
}

export function MyKeysSection() {
  const { hash } = useLocation()
  const { data, isLoading, isError, refetch } = useApi<Listing>(MY_KEYS, "/api/me/keys")

  useEffect(() => {
    if (hash === `#${MY_KEYS_ID}` && data) document.getElementById(MY_KEYS_ID)?.scrollIntoView?.({ block: "start" })
  }, [hash, data])

  return (
    <section id={MY_KEYS_ID} className="scroll-mt-20 space-y-4" aria-labelledby="my-keys-title">
      <div className="min-w-0">
        <SectionTitle id="my-keys-title">My API keys</SectionTitle>
        <Sub className="mt-1">
          Add your own keys and the features you use run on your account and your allowance. A saved key is never shown again, only its last four characters.
        </Sub>
      </div>

      {isLoading && <SkeletonRows rows={3} rowHeight={72} />}
      {isError && <InlineError message="Could not load your keys." onRetry={() => void refetch()} />}

      {data && (
        <ul className="divide-y divide-line border-y border-line">
          {data.providers.map((p) => (
            <KeyRow key={p.provider} provider={p} />
          ))}
        </ul>
      )}
    </section>
  )
}

function KeyRow({ provider: p }: { provider: KeyProvider }) {
  const qc = useQueryClient()
  const shown = p.values
  const [kind, setKind] = useState(shown.kind || "openai")
  const [baseUrl, setBaseUrl] = useState(shown.base_url || "")
  const [model, setModel] = useState(shown.model || "")
  const [mailto, setMailto] = useState(shown.mailto || "")
  const [secret, setSecret] = useState("")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState("")

  const status = statusOf(p)
  const note = sentenceOf(p)
  const has = (name: string) => p.fields.some((f) => f.name === name)

  const changed =
    (has("kind") && kind !== (shown.kind || "openai")) ||
    (has("base_url") && baseUrl.trim() !== (shown.base_url || "")) ||
    (has("model") && model.trim() !== (shown.model || "")) ||
    (has("mailto") && mailto.trim() !== (shown.mailto || ""))
  const typed = secret.trim().length > 0 || token.trim().length > 0
  const canSave = typed || (p.has_own_key && changed) || (p.provider === "openalex" && changed)

  async function refresh() {
    await qc.invalidateQueries({ queryKey: MY_KEYS })
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError("")
    setResult(null)
    const body: Record<string, string> = {}
    if (has("kind")) body.kind = kind
    if (has("base_url")) body.base_url = kind === "anthropic" ? "" : baseUrl.trim()
    if (has("model")) body.model = model.trim()
    if (has("mailto")) body.mailto = mailto.trim()
    if (secret.trim()) body.value = secret.trim()
    if (token.trim()) body.inst_token = token.trim()
    try {
      await api(`/api/me/keys/${p.provider}`, { method: "PUT", json: body })
      setSecret("")
      setToken("")
      toast.ok(`${p.label} key saved`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Nothing was changed.")
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setTesting(true)
    setResult(null)
    try {
      setResult(await api<TestResult>(`/api/me/keys/${p.provider}/test`, { method: "POST" }))
      await refresh()
    } catch (err) {
      toast.fail(err, "The test could not be run")
    } finally {
      setTesting(false)
    }
  }

  async function remove() {
    try {
      await api(`/api/me/keys/${p.provider}`, { method: "DELETE" })
      setSecret("")
      setToken("")
      setResult(null)
      toast.ok(`${p.label} key removed`)
      await refresh()
    } catch (err) {
      toast.fail(err, "Could not remove the key. Nothing was changed.")
    }
  }

  return (
    <li className="space-y-3 py-4" data-testid={`key-row-${p.provider}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="font-medium">{p.label}</p>
          <p className="text-sm text-fg-muted">{p.about}</p>
        </div>
        <Chip tone={status.tone}>{status.text}</Chip>
      </div>

      {note && (
        <p className="text-sm text-fg-muted" data-testid={`key-note-${p.provider}`}>
          {note}
        </p>
      )}
      {p.problem && (
        <p role="alert" className="text-sm text-critical">
          {p.problem}
        </p>
      )}

      <form className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2" onSubmit={(e) => void save(e)}>
        {has("kind") && (
          <Field label="Kind of service">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="openai">OpenAI-compatible (Groq, OpenAI, Gemini, OpenRouter)</option>
              <option value="anthropic">Claude (Anthropic)</option>
            </Select>
          </Field>
        )}
        {has("base_url") && kind !== "anthropic" && (
          <>
            <Field label="Common services">
              <Select
                value={SERVICES.find((s) => s.url === baseUrl.trim())?.url ?? ""}
                onChange={(e) => e.target.value && setBaseUrl(e.target.value)}
              >
                <option value="">Other (type the address)</option>
                {SERVICES.map((s) => (
                  <option key={s.url} value={s.url}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Service address" hint="Starts with https://">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} autoComplete="off" />
            </Field>
          </>
        )}
        {has("model") && (
          <Field label="Model (optional)" hint={kind === "anthropic" ? "Leave empty to use the standard Claude model." : "Leave empty for Groq, OpenAI and Gemini. Other services need one."}>
            <Input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
        )}
        {has("mailto") && (
          <Field label="Contact email" hint="OpenAlex gives faster service to requests that say who sent them.">
            <Input type="email" value={mailto} onChange={(e) => setMailto(e.target.value)} autoComplete="email" />
          </Field>
        )}
        <Field
          label={p.has_own_key ? "New API key" : "API key"}
          hint={p.has_own_key && p.masked ? `Saved key ends ${p.masked.replace("••••", "")}. Paste a new one to replace it.` : undefined}
        >
          <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={p.has_own_key ? "Paste a key to replace the saved one" : "Paste your key"}
          />
        </Field>
        {has("inst_token") && (
          <Field label="Institution token (optional)" hint={p.has_inst_token ? "One is saved. Paste a new one to replace it." : "Only if Elsevier gave you one."}>
            <Input type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        )}

        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" kind="primary" disabled={!canSave || busy}>
            {busy ? "Saving" : "Save"}
          </Button>
          {p.has_own_key && (
            <>
              <Button type="button" onClick={() => void test()} disabled={testing}>
                {testing ? "Testing" : "Test"}
              </Button>
              <Button type="button" kind="quiet" onClick={() => setRemoving(true)} aria-label={`Remove my ${p.label} key`}>
                Remove
              </Button>
            </>
          )}
        </div>
      </form>

      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className={result.ok ? "text-sm text-positive" : "text-sm text-critical"}>
          {result.ok ? "It worked" : "It did not work"} ({formatCount(result.latency_ms)} ms). {result.message}
        </p>
      )}
      {!result && p.last_test && (
        <Meta className="block">
          Last tested <Ago iso={p.last_test.at} />. {p.last_test.ok ? "It worked." : "It did not work."}
        </Meta>
      )}
      {p.has_own_key && (
        <Meta className="block">
          Calls today {formatCount(p.usage.today)}. Calls this month {formatCount(p.usage.month)}.
        </Meta>
      )}

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove your ${p.label} key?`}
        description={
          p.policy === "own_required"
            ? "The college asks for your own key, so this feature stops working for you until you add another."
            : "The features you use go back to the college key, if there is one."
        }
        confirmLabel="Remove"
        danger
        onConfirm={remove}
      />
    </li>
  )
}
