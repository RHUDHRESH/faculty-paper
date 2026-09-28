import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"

import { api, type ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Switch } from "@/ui/field"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

type Level = "email" | "in_app" | "off"

type Kind = {
  key: string
  label: string
  description: string
  group: string
  level: Level
  default: Level
  whatsapp: boolean
  can_turn_off: boolean
}

export type Preferences = {
  email_available: boolean
  whatsapp_available: boolean
  email: string
  has_phone: boolean
  count_my_visits: boolean
  whatsapp_opt_in: boolean
  kinds: Kind[]
}

type Change = { levels?: Record<string, Level>; count_my_visits?: boolean; whatsapp_opt_in?: boolean }

const KEY = ["notification-preferences"]

/** Short labels for the three settings, in the order they are offered. */
const CHOICES: { value: Level; label: string }[] = [
  { value: "email", label: "By email too" },
  { value: "in_app", label: "In the app" },
  { value: "off", label: "Off" },
]

/**
 * Every kind of alert this app sends, and how the person wants each one: by
 * email as well as in the app, in the app only, or not at all.
 *
 * A change is saved the moment it is made -- there is no Save button to
 * forget. The social switches on the statistics page write the same
 * preferences, so the two pages can never disagree.
 */
export function NotificationSettings() {
  const qc = useQueryClient()
  const query = useApi<Preferences>(KEY, "/api/notifications/preferences")
  const save = useMutation<Preferences, ApiError, Change>({
    mutationFn: (body) => api<Preferences>("/api/notifications/preferences", { method: "PUT", json: body }),
    onSuccess: (p) => {
      qc.setQueryData(KEY, p)
      // The social panel reads the same switches.
      void qc.invalidateQueries({ queryKey: ["social-settings"] })
    },
    onError: (err) => {
      toast.fail(err)
      void qc.invalidateQueries({ queryKey: KEY })
    },
  })

  function choose(kind: Kind, level: Level) {
    const p = query.data
    if (!p || kind.level === level) return
    qc.setQueryData<Preferences>(KEY, {
      ...p,
      kinds: p.kinds.map((k) => (k.key === kind.key ? { ...k, level } : k)),
    })
    save.mutate({ levels: { [kind.key]: level } })
  }

  function flip(field: "count_my_visits" | "whatsapp_opt_in", on: boolean) {
    const p = query.data
    if (!p) return
    qc.setQueryData<Preferences>(KEY, { ...p, [field]: on })
    save.mutate({ [field]: on })
  }

  const p = query.data
  const groups = p ? groupKinds(p.kinds) : []

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <PageTitle>Notification settings</PageTitle>
        <Sub>
          Choose how each kind of alert reaches you. Changes are saved as you make them.{" "}
          <Link to="/notifications" className="underline underline-offset-2">
            Back to notifications
          </Link>
        </Sub>
      </div>

      {query.isPending ? (
        <SkeletonRows rows={6} rowHeight={48} />
      ) : query.isError || !p ? (
        <ErrorState
          title="Could not load your settings"
          message="The server did not answer. Nothing has changed."
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          {!p.email_available ? (
            <Callout tone="info">
              Email is not set up here yet, so everything arrives in the app only. What you choose
              below is kept for when it is.
            </Callout>
          ) : (
            <Meta className="block">Email goes to {p.email}. Every email has a link to stop that kind.</Meta>
          )}

          {groups.map(([group, kinds]) => (
            <section key={group} className="space-y-2" aria-labelledby={`group-${slug(group)}`}>
              <SectionTitle id={`group-${slug(group)}`}>{group}</SectionTitle>
              <ul className="divide-y divide-line rounded-lg ring-1 ring-inset ring-edge">
                {kinds.map((k) => (
                  <li key={k.key} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p id={`kind-${k.key}`} className="text-sm font-medium">
                        {k.label}
                      </p>
                      <Meta className="block">{k.description}</Meta>
                    </div>
                    <LevelChoice kind={k} onChange={(level) => choose(k, level)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="space-y-3" aria-labelledby="personal-switches">
            <SectionTitle id="personal-switches">About you</SectionTitle>
            <Switch
              checked={p.count_my_visits}
              onCheckedChange={(on) => flip("count_my_visits", on)}
              label="Count my visits in colleagues' stats"
              hint="Off: opening a profile or seeing a post is not counted in anybody's numbers. Nobody is ever shown who visited, either way."
            />
            {p.whatsapp_available && (
              <Switch
                checked={p.whatsapp_opt_in}
                disabled={!p.has_phone}
                onCheckedChange={(on) => flip("whatsapp_opt_in", on)}
                label="Also send payment news on WhatsApp"
                hint={
                  p.has_phone
                    ? "Approved, paid, sent back and not accepted only."
                    : "Add a phone number to your profile first."
                }
              />
            )}
          </section>
        </>
      )}
    </div>
  )
}

function LevelChoice({ kind, onChange }: { kind: Kind; onChange: (level: Level) => void }) {
  const choices = kind.can_turn_off ? CHOICES : CHOICES.filter((c) => c.value !== "off")
  return (
    <div
      role="radiogroup"
      aria-labelledby={`kind-${kind.key}`}
      className="inline-flex max-w-full rounded-md bg-sunken p-0.5"
    >
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={kind.level === c.value}
          onClick={() => onChange(c.value)}
          className={cn(
            "h-7 shrink-0 rounded-sm px-2.5 text-xs font-medium transition-colors",
            "duration-[var(--dur-1)] ease-out",
            kind.level === c.value ? "bg-surface text-fg" : "text-fg-muted hover:text-fg"
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}

/** Kinds under their headings, headings in the order the server first lists them. */
function groupKinds(kinds: Kind[]): [string, Kind[]][] {
  const out = new Map<string, Kind[]>()
  for (const k of kinds) {
    const list = out.get(k.group) ?? []
    list.push(k)
    out.set(k.group, list)
  }
  return Array.from(out.entries())
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-")
}
