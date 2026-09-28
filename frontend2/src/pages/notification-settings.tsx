import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Copy } from "lucide-react"
import { Link } from "react-router-dom"

import { api, type ApiError } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
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
    <div className="page max-w-3xl space-y-8 py-8">
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
              Email needs the college's mail server (SMTP) to be set up, and it is not yet, so
              everything arrives in the app for now. The email switches below are kept for when it
              is.
            </Callout>
          ) : (
            <Meta className="block">Email goes to {p.email}. Every email has a link to stop that kind.</Meta>
          )}

          {groups.map(([group, kinds], i) => (
            <section key={group} className="space-y-1" aria-labelledby={`group-${slug(group)}`}>
              <div className="flex items-end justify-between gap-3">
                <SectionTitle id={`group-${slug(group)}`}>{group}</SectionTitle>
                {i === 0 && (
                  <div aria-hidden="true" className="flex shrink-0 gap-6 text-xs font-medium text-fg-subtle">
                    <span className="w-14 text-center">In app</span>
                    <span className="w-14 text-center">Email</span>
                  </div>
                )}
              </div>
              <ul className="divide-y divide-line border-y border-line">
                {kinds.map((k) => (
                  <li key={k.key} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p id={`kind-${k.key}`} className="text-sm font-medium">
                        {k.label}
                      </p>
                      <Meta className="block">{k.description}</Meta>
                    </div>
                    <KindToggles kind={k} onChange={(level) => choose(k, level)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <CalendarFeed />

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

/**
 * Two switches over the one stored level: In app (anything but off) and Email
 * (email, which always includes in app). Turning email on turns in app on;
 * turning in app off turns email off with it.
 */
function KindToggles({ kind, onChange }: { kind: Kind; onChange: (level: Level) => void }) {
  const inApp = kind.level !== "off"
  const email = kind.level === "email"
  return (
    <div className="flex shrink-0 items-center gap-6">
      <span className="flex w-14 justify-center" title={kind.can_turn_off ? undefined : "This one always shows in the app"}>
        <Switch
          checked={inApp}
          disabled={!kind.can_turn_off}
          aria-label={`${kind.label}: in app`}
          onCheckedChange={(on) => onChange(on ? "in_app" : "off")}
        />
      </span>
      <span className="flex w-14 justify-center">
        <Switch
          checked={email}
          aria-label={`${kind.label}: email`}
          onCheckedChange={(on) => onChange(on ? "email" : "in_app")}
        />
      </span>
    </div>
  )
}

type FeedLink = { url: string; webcal?: string }

/** The personal calendar feed: deadlines and your papers' dates, in any calendar app. */
function CalendarFeed() {
  const link = useApi<FeedLink>(["calendar", "feed-link"], "/api/calendar/feed-link", { staleTime: Infinity })
  async function copy() {
    if (!link.data) return
    try {
      await navigator.clipboard.writeText(link.data.url)
      toast.ok("Link copied. Paste it into Google, Outlook or Apple Calendar.")
    } catch {
      toast.fail(new Error("Could not copy. Select the link and copy it by hand."))
    }
  }
  return (
    <section className="space-y-2" aria-labelledby="calendar-feed">
      <SectionTitle id="calendar-feed">Calendar feed</SectionTitle>
      <Meta className="block">
        Subscribe once and filing deadlines and your papers' dates appear in your own calendar. Keep
        the link to yourself; anybody with it can read the feed.
      </Meta>
      {link.isError ? (
        <Meta className="block text-critical">Could not load your feed link. Reload to try again.</Meta>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            readOnly
            aria-label="Calendar feed link"
            value={link.data?.url ?? "Loading…"}
            onFocus={(e) => e.currentTarget.select()}
            className="h-8 min-w-0 flex-1 rounded-md bg-sunken px-2 font-mono text-xs text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <Button kind="default" size="sm" disabled={!link.data} onClick={() => void copy()}>
            <Copy />
            Copy link
          </Button>
          <Link to="/calendar" className="text-sm underline underline-offset-2">
            Open the calendar
          </Link>
        </div>
      )}
    </section>
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
