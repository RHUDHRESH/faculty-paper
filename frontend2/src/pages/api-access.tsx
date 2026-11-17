import { useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"

import { roleLabel } from "@/app/account"
import { api } from "@/lib/api"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, Field, Input, Select, Switch } from "@/ui/field"
import { Callout, InlineError, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { When } from "@/ui/when"

/**
 * Personal API tokens: the Profile page's "API access" section, and the super
 * admin's list of everybody's.
 *
 * A token lets one person pull their own data into Excel, Google Sheets,
 * Python or Power BI, as themselves and read-only. The secret is shown once,
 * in the dialog that creates it, and is not kept anywhere the page can read
 * it again.
 */

export type ApiTokenRow = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  status: "active" | "expired" | "revoked"
  created_at: string
  last_used_at: string | null
  use_count: number
  expires_at: string | null
  revoked_at: string | null
  last_used_ip?: string | null
}

type MyTokens = {
  enabled: boolean
  scope_options: { scope: string; label: string }[]
  default_days: number
  max_days: number
  rate_limit_per_minute: number
  tokens: ApiTokenRow[]
}

type Created = { token: ApiTokenRow; secret: string }

const EXPIRY: { days: number; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: 730, label: "2 years" },
]

const scopeWord = (scope: string) => scope.replace("read:", "")

function day(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

function Scopes({ scopes }: { scopes: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Chip key={s}>{scopeWord(s)}</Chip>
      ))}
    </span>
  )
}

function StatusChip({ status }: { status: ApiTokenRow["status"] }) {
  if (status === "active") return null
  return <Chip tone={status === "revoked" ? "critical" : "caution"}>{status === "revoked" ? "Revoked" : "Expired"}</Chip>
}

/* ------------------------------------------------------------------------ */
/* Profile: your own tokens                                                  */
/* ------------------------------------------------------------------------ */

export function ApiAccessSection() {
  const qc = useQueryClient()
  const { data, isLoading, isError, refetch } = useApi<MyTokens>(["api-tokens"], "/api/me/api-tokens")
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<ApiTokenRow | null>(null)

  const tokens = data?.tokens ?? []
  const enabled = data?.enabled ?? true

  return (
    <section className="space-y-4" aria-labelledby="api-access-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionTitle id="api-access-title">API access</SectionTitle>
          <Sub className="mt-1">
            Pull your own data into Excel, Google Sheets, Python or Power BI.{" "}
            <Link to="/api-docs" className="underline underline-offset-2">
              See how to use a token
            </Link>
            .
          </Sub>
        </div>
        {data && enabled && (
          <Button kind="default" onClick={() => setCreating(true)}>
            Create token
          </Button>
        )}
      </div>

      {isLoading && <SkeletonRows rows={2} rowHeight={56} />}

      {isError && <InlineError message="Could not load your tokens." onRetry={() => refetch()} />}

      {data && !enabled && (
        <Callout tone="caution" title="API access is switched off for your role">
          The research office has turned tokens off for your role, so none can be created or used.
        </Callout>
      )}

      {data && enabled && tokens.length === 0 && (
        <p className="text-sm text-fg-muted">You have no tokens. Create one to read your data from a spreadsheet or a script.</p>
      )}

      {tokens.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="break-words font-medium">{t.name}</span>
                  <code className="font-mono text-xs text-fg-muted">{t.prefix}…</code>
                  <StatusChip status={t.status} />
                </p>
                <Scopes scopes={t.scopes} />
                <p className="flex flex-wrap gap-x-3 text-[13px] text-fg-muted">
                  <span>Created {day(t.created_at)}</span>
                  <span>{t.last_used_at ? <>Last used <When iso={t.last_used_at} /></> : "Never used"}</span>
                  <span>
                    {t.use_count} {t.use_count === 1 ? "use" : "uses"}
                  </span>
                  {t.status === "active" && t.expires_at && <span>Expires {day(t.expires_at)}</span>}
                </p>
              </div>
              {t.status === "active" && (
                <Button kind="quiet" size="sm" onClick={() => setRevoking(t)} aria-label={`Revoke ${t.name}`}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && (
        <CreateTokenDialog
          open={creating}
          onOpenChange={setCreating}
          options={data.scope_options}
          defaultDays={data.default_days}
          onCreated={() => void qc.invalidateQueries({ queryKey: ["api-tokens"] })}
        />
      )}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null)
        }}
        title="Revoke this token?"
        description={
          revoking
            ? `Anything using "${revoking.name}" (${revoking.prefix}…) stops working straight away. This cannot be undone.`
            : ""
        }
        confirmLabel="Revoke"
        danger
        onConfirm={async () => {
          if (!revoking) return
          try {
            await api(`/api/me/api-tokens/${revoking.id}`, { method: "DELETE" })
            toast.ok(`Revoked ${revoking.name}`)
            await qc.invalidateQueries({ queryKey: ["api-tokens"] })
          } catch (err) {
            toast.fail(err, "Could not revoke the token. Nothing was changed.")
          }
        }}
      />
    </section>
  )
}

function CreateTokenDialog({
  open,
  onOpenChange,
  options,
  defaultDays,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: { scope: string; label: string }[]
  defaultDays: number
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<string[]>([])
  const [days, setDays] = useState(defaultDays)
  const [created, setCreated] = useState<Created | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")

  const create = useApiMutation<{ name: string; scopes: string[]; expires_in_days: number }, Created>(
    "/api/me/api-tokens"
  )

  function close(next: boolean) {
    if (!next) {
      // The secret goes with the dialog: it is not kept anywhere to be read again.
      setName("")
      setScopes([])
      setDays(defaultDays)
      setCreated(null)
      setCopied(false)
      setError("")
    }
    onOpenChange(next)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError("")
    create.mutate(
      { name: name.trim(), scopes, expires_in_days: days },
      {
        onSuccess: (result) => {
          setCreated(result)
          onCreated()
        },
        onError: (err) => setError(err.message),
      }
    )
  }

  async function copy() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.secret)
      setCopied(true)
    } catch {
      setError("Could not copy. Select the token and copy it by hand.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Your token</DialogTitle>
              <DialogDescription>
                Use it as <code className="font-mono text-xs">Authorization: Bearer …</code> in Excel, Sheets or a script.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <Callout tone="caution">Copy it now; it will not be shown again.</Callout>
              <div className="flex items-center gap-2">
                <Input readOnly aria-label="Token" value={created.secret} onFocus={(e) => e.currentTarget.select()} className="font-mono" />
                <Button kind="primary" onClick={copy}>
                  {copied ? "Copied" : "Copy token"}
                </Button>
              </div>
              {error && <InlineError message={error} />}
            </DialogBody>
            <DialogFooter>
              <Button kind="default" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader>
              <DialogTitle>Create a token</DialogTitle>
              <DialogDescription>It reads your data only, as you, and cannot change anything.</DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <Field label="Name" hint="Where you will use it, for example Excel on my laptop.">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">What it may read</legend>
                {options.map((o) => (
                  <Checkbox
                    key={o.scope}
                    label={o.label}
                    checked={scopes.includes(o.scope)}
                    onCheckedChange={(on) =>
                      setScopes((cur) => (on === true ? [...cur, o.scope] : cur.filter((s) => s !== o.scope)))
                    }
                  />
                ))}
              </fieldset>
              <Field label="Expires after">
                <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {EXPIRY.map((x) => (
                    <option key={x.days} value={x.days}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {error && <InlineError message={error} />}
            </DialogBody>
            <DialogFooter>
              <Button kind="quiet" type="button" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button kind="primary" type="submit" disabled={!name.trim() || scopes.length === 0} loading={create.isPending}>
                Create token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Super admin: everybody's tokens, and the switch per role                  */
/* ------------------------------------------------------------------------ */

type AdminToken = ApiTokenRow & {
  owner: { id: string; name: string; email: string; role: string; department: string | null }
}

type AdminTokens = { access: Record<string, boolean>; tokens: AdminToken[] }

export function AdminApiTokens() {
  const qc = useQueryClient()
  const { data, isLoading, isError, refetch } = useApi<AdminTokens>(["api-tokens-admin"], "/api/admin/api-tokens")
  const [revoking, setRevoking] = useState<AdminToken | null>(null)
  const setAccess = useApiMutation<{ role: string; enabled: boolean }>("/api/admin/api-access", {
    method: "PUT",
    invalidates: [["api-tokens-admin"], ["api-tokens"]],
  })

  return (
    <section className="space-y-4" aria-labelledby="api-admin-title">
      <div>
        <SectionTitle id="api-admin-title">API access</SectionTitle>
        <Sub className="mt-1">
          Personal tokens let people read their own data into spreadsheets. Switch a role off and its tokens stop working.
        </Sub>
      </div>

      {isLoading && <SkeletonRows rows={3} rowHeight={48} />}
      {isError && <InlineError message="Could not load the tokens." onRetry={() => refetch()} />}

      {data && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(data.access).map(([role, on]) => (
              <Switch
                key={role}
                checked={on}
                label={roleLabel(role)}
                onCheckedChange={(enabled) =>
                  setAccess.mutate(
                    { role, enabled },
                    {
                      onSuccess: () => toast.ok(`API access ${enabled ? "on" : "off"} for ${roleLabel(role).toLowerCase()}`),
                      onError: (err) => toast.fail(err, "Could not change that. Nothing was changed."),
                    }
                  )
                }
              />
            ))}
          </div>

          {data.tokens.length === 0 ? (
            <p className="text-sm text-fg-muted">Nobody has made a token yet.</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {data.tokens.map((t) => (
                <li key={t.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="break-words font-medium">{t.owner.name}</span>
                      <Meta>{roleLabel(t.owner.role)}</Meta>
                      <StatusChip status={t.status} />
                    </p>
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="break-words">{t.name}</span>
                      <code className="font-mono text-xs text-fg-muted">{t.prefix}…</code>
                      <Scopes scopes={t.scopes} />
                    </p>
                    <p className="flex flex-wrap gap-x-3 text-[13px] text-fg-muted">
                      <span>Created {day(t.created_at)}</span>
                      <span>{t.last_used_at ? <>Last used <When iso={t.last_used_at} /></> : "Never used"}</span>
                      <span>
                        {t.use_count} {t.use_count === 1 ? "use" : "uses"}
                      </span>
                    </p>
                  </div>
                  {t.status === "active" && (
                    <Button kind="quiet" size="sm" onClick={() => setRevoking(t)} aria-label={`Revoke ${t.name} for ${t.owner.name}`}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null)
        }}
        title="Revoke this token?"
        description={
          revoking
            ? `${revoking.owner.name}'s token "${revoking.name}" stops working straight away. This cannot be undone.`
            : ""
        }
        confirmLabel="Revoke"
        danger
        onConfirm={async () => {
          if (!revoking) return
          try {
            await api(`/api/admin/api-tokens/${revoking.id}`, { method: "DELETE" })
            toast.ok(`Revoked ${revoking.owner.name}'s token`)
            await qc.invalidateQueries({ queryKey: ["api-tokens-admin"] })
          } catch (err) {
            toast.fail(err, "Could not revoke the token. Nothing was changed.")
          }
        }}
      />
    </section>
  )
}
