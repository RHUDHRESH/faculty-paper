import { useState } from "react"

import { useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { useApi, queryClient } from "@/lib/query"
import { Button } from "@/ui/button"
import { Field, Input } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { Rows, Section } from "@/ui/section"
import { ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"
import { OwnKeysAdmin } from "@/pages/own-keys-admin"

/**
 * Integrations: the AI key, the Scopus key and the OpenAlex settings.
 *
 * Super admin only (`GET /api/admin/integrations`). A key saved here is used
 * at once, with no redeploy; clearing it hands the job back to the host's
 * environment variable, if there is one. The server never sends a saved key
 * back, only its last four characters, so the key box is always empty and
 * what you type replaces whatever is there.
 */

type Field = {
  name: string
  label: string
  help: string
  secret: boolean
  configured: boolean
  source: "app" | "environment" | "none"
  masked: string
  value: string
  problem?: string
}
type Provider = {
  provider: string
  label: string
  about: string
  configured: boolean
  source: "app" | "environment" | "none"
  masked: string
  last_tested_at: string | null
  last_test_ok: boolean | null
  last_test_message: string
  usage: { today: number; month: number }
  rate_limit: { remaining: number | null; limit: number | null; reset: number | null } | null
  fields: Field[]
}
type Listing = { providers: Provider[] }
type TestResult = { ok: boolean; latency_ms: number; message: string; provider: Provider }

const KEY = ["admin", "integrations"]

const SOURCE: Record<Field["source"], string> = {
  app: "Configured from app",
  environment: "Configured from environment",
  none: "Not set",
}

export function Integrations() {
  const { me, loading: signingIn } = useAuth()
  const isSuper = me?.role === "SUPER_ADMIN"
  const { data, isLoading, error, refetch } = useApi<Listing>(KEY, "/api/admin/integrations", { enabled: isSuper })

  if (signingIn) {
    return (
      <div className="page space-y-10">
        <SkeletonRows rows={6} />
      </div>
    )
  }
  if (!isSuper || error?.status === 403) {
    return (
      <div className="page py-8">
        <NotOpen message="Ask the research office if you think it should be yours." />
      </div>
    )
  }

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Integrations"
        sub="The keys and addresses this app uses to reach other services. A key saved here is used at once."
      />
      {isLoading ? (
        <SkeletonRows rows={6} />
      ) : error || !data ? (
        <ErrorState
          title="Could not load the integrations"
          message="The server did not answer. Nothing was changed."
          onRetry={() => void refetch()}
        />
      ) : (
        data.providers.map((p) => <ProviderSection key={p.provider} provider={p} />)
      )}
      <OwnKeysAdmin />
    </div>
  )
}

function ProviderSection({ provider: p }: { provider: Provider }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; latency_ms: number; message: string } | null>(null)

  async function test() {
    setTesting(true)
    setResult(null)
    try {
      const out = await api<TestResult>(`/api/admin/integrations/${p.provider}/test`, { method: "POST" })
      setResult({ ok: out.ok, latency_ms: out.latency_ms, message: out.message })
      await queryClient.invalidateQueries({ queryKey: KEY })
    } catch (e) {
      toast.fail(e, "The test could not be run")
    } finally {
      setTesting(false)
    }
  }

  const rate = p.rate_limit
  return (
    <Section title={p.label} sub={p.about} showSub>

      <Rows>
        {p.fields.map((f) => (
          <FieldRow key={f.name} field={f} />
        ))}
      </Rows>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => void test()} disabled={testing}>
          {testing ? "Testing" : "Test connection"}
        </Button>
        {result && (
          <p role="status" className={result.ok ? "text-sm text-positive" : "text-sm text-critical"}>
            {result.ok ? "It worked" : "It did not work"} ({formatCount(result.latency_ms)} ms). {result.message}
          </p>
        )}
        {!result && p.last_tested_at && (
          <Meta>
            Last tested <Ago iso={p.last_tested_at} />. {p.last_test_ok ? "It worked." : "It did not work."}
          </Meta>
        )}
      </div>

      <p className="mt-3 text-sm text-fg-muted">
        Calls today {formatCount(p.usage.today)}. Calls this month {formatCount(p.usage.month)}.
        {rate && rate.remaining != null && (
          <>
            {` Scopus has ${formatCount(rate.remaining)}${rate.limit != null ? ` of ${formatCount(rate.limit)}` : ""} calls left`}
            {rate.reset ? ` until ${new Date(rate.reset * 1000).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}
            .
          </>
        )}
      </p>
    </Section>
  )
}

function FieldRow({ field: f }: { field: Field }) {
  // A key is never put back in the box. A plain setting (a model name, an
  // address) is not secret, so it is shown and can be edited in place.
  const [text, setText] = useState(f.secret ? "" : f.value)
  const [busy, setBusy] = useState(false)

  async function put(value: string, done: string) {
    setBusy(true)
    try {
      await api(`/api/admin/integrations/${f.name}`, { method: "PUT", json: { value } })
      setText(f.secret ? "" : value)
      toast.ok(done)
      await queryClient.invalidateQueries({ queryKey: KEY })
    } catch (e) {
      toast.fail(e, "Could not save. Nothing was changed.")
    } finally {
      setBusy(false)
    }
  }

  const typed = text.trim().length > 0
  return (
    <li className="space-y-2 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium">{f.label}</span>
        <Meta>
          {SOURCE[f.source]}
          {f.secret && f.masked ? `, ends ${f.masked}` : ""}
        </Meta>
      </div>
      {f.problem && (
        <p role="alert" className="text-sm text-critical">
          {f.problem}
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (typed) void put(text.trim(), `${f.label} saved`)
        }}
      >
        <Field label={f.secret ? `New ${f.label.toLowerCase()}` : f.label} hint={f.help || undefined} className="min-w-0 flex-1 basis-64">
          <Input
            type={f.secret ? "password" : "text"}
            autoComplete={f.secret ? "new-password" : "off"}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={f.secret ? "Paste a key to replace the current one" : ""}
          />
        </Field>
        <Button type="submit" kind="primary" disabled={!typed || busy}>
          Save
        </Button>
        {f.source === "app" && (
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void put("", f.secret ? `${f.label} cleared. The environment value is used again` : `${f.label} cleared`)
            }
          >
            Clear
          </Button>
        )}
      </form>
    </li>
  )
}
