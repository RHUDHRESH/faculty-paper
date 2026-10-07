import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CalendarPlus, CalendarSync, ChevronDown, Copy, Ellipsis, ExternalLink, Mail, RefreshCw, RotateCcw, X } from "lucide-react"

import { api } from "@/lib/api"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { Callout, InlineError, Skeleton } from "@/ui/state"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"
import type { FeedLink, GoogleStatus } from "./model"

/**
 * The one place the calendar page talks about Google.
 *
 * There are three honest situations and each gets one obvious button:
 *   not set up on the server   "Add to Google Calendar": Google's own subscribe
 *                              page with this person's feed filled in. Google
 *                              refreshes a subscription about once a day, and
 *                              the strip says so rather than letting people
 *                              wonder why a new date has not turned up.
 *   set up, not connected      "Connect Google Calendar": one click to Google's
 *                              consent screen, one click back, and a calendar
 *                              of their own appears.
 *   connected                  who, when it last synced, "Sync now" and
 *                              "Disconnect"; if Google ended the link, "Connect
 *                              again" instead, because nothing else will help.
 * Without this the choice between those is a menu of five items, which is what
 * a non-technical reader looked at and gave up on.
 */

const STATUS_KEY = ["calendar", "google", "status"] as const
const NAME = "Saveetha Publications"
/** In a sentence the name stays on one line: "Saveetha" at the end of a line and "Publications" on the next reads as two things. */
const NAME_ONE_LINE = NAME.replace(" ", "\u00a0")

export function useGoogleStatus() {
  return useApi<GoogleStatus>(STATUS_KEY, "/api/calendar/google/status", { staleTime: 15_000 })
}

type SyncResult = { created: number; updated: number; deleted: number; failed: number; partial?: boolean; busy?: boolean }

export function syncMessage(r: SyncResult): string {
  // A sync of theirs was already under way, or a very long list ran out of
  // time and the rest is queued: either way it is not "up to date" yet.
  if (r.busy) return "A sync is already running. It will finish in a moment."
  if (r.partial) return "Still syncing a long list. The rest will arrive in a minute or two."
  const parts = [
    r.created ? `${r.created} added` : "",
    r.updated ? `${r.updated} updated` : "",
    r.deleted ? `${r.deleted} removed` : "",
  ].filter(Boolean)
  return parts.length ? `Synced: ${parts.join(", ")}.` : "Your Google Calendar is already up to date."
}

type Notice = { tone: "positive" | "critical"; text: string }

const COULD_NOT_CONNECT = "Google Calendar could not be connected. Please try again."

/**
 * The reasons the way back from Google can give, word for word as the server
 * writes them (WHY_* in core/services/google_calendar.py, and the few in
 * core/api/google_calendar.py). The address is the only place they travel, and
 * anybody can write an address: a link made by someone else must not be able
 * to put its own sentence on this page, so anything not on this list is
 * replaced by the general one.
 */
const KNOWN_WHY = new Set([
  "That sign-in took too long or did not start here. Please press Connect again.",
  "You chose not to allow it, so nothing was connected.",
  "Google did not give permission to add a calendar. Tick the calendar box and try again.",
  "Google did not keep the connection open. Remove Saveetha Publications under your Google Account's third-party access, then connect again.",
  "Google could not finish connecting. Please try again in a moment.",
  "Google could not confirm which account this is. Please try again.",
  "Google did not say which account this is. Please try again.",
  "Connecting to Google Calendar is not switched on yet. You can still add the calendar to Google with the link on this page.",
  "You are viewing as somebody else. Stop viewing as them before connecting a calendar.",
  "Please sign in again, then connect Google Calendar.",
])

/** Google sends the browser back to /calendar?google=connected, or ?google=failed&why=... */
function useReturnNotice(): [Notice | null, () => void] {
  const [params, setParams] = useSearchParams()
  const [notice, setNotice] = useState<Notice | null>(() => {
    if (params.get("google") === "failed") {
      const why = params.get("why") ?? ""
      return { tone: "critical", text: KNOWN_WHY.has(why) ? why : COULD_NOT_CONNECT }
    }
    return null
  })
  const result = params.get("google")
  useEffect(() => {
    if (!result) return
    if (result === "connected") toast.ok(`Connected. “${NAME}” is now in your Google Calendar.`)
    // The address is only a message from Google's way back: say it once, then
    // leave a clean URL so a reload does not say it again.
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("google")
        next.delete("why")
        return next
      },
      { replace: true }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return [notice, () => setNotice(null)]
}

export function GoogleStrip() {
  const status = useGoogleStatus()
  const [notice, dismiss] = useReturnNotice()
  const [connecting, setConnecting] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const sync = useApiMutation<void, SyncResult>("/api/calendar/google/sync", { invalidates: [[...STATUS_KEY]] })
  const leave = useApiMutation<void, { calendar_removed: boolean }>("/api/calendar/google/disconnect", {
    invalidates: [[...STATUS_KEY]],
  })

  async function connect() {
    setConnecting(true)
    try {
      const { url } = await api<{ url: string }>("/api/calendar/google/connect")
      window.location.assign(url)
    } catch (err) {
      toast.fail(err)
      setConnecting(false)
    }
  }

  async function syncNow() {
    try {
      const result = await sync.mutateAsync(undefined as never)
      toast.ok(syncMessage(result))
    } catch (err) {
      toast.fail(err)
    }
  }

  async function disconnect() {
    try {
      const result = await leave.mutateAsync(undefined as never)
      toast.ok(
        result.calendar_removed
          ? `Disconnected. “${NAME}” was removed from your Google Calendar.`
          : `Disconnected. You can delete the “${NAME}” calendar in Google Calendar yourself.`
      )
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  if (status.isLoading) return <Skeleton className="h-[4.5rem] rounded-panel" />
  if (status.isError || !status.data) {
    return <InlineError message="Could not check your Google Calendar." onRetry={() => void status.refetch()} />
  }
  const s = status.data
  const lost = s.connected && s.needs_reconnect
  const slipped = s.connected && !s.needs_reconnect && Boolean(s.error)

  let heading: string
  let line: React.ReactNode
  let actions: React.ReactNode
  if (!s.configured) {
    heading = "Add these dates to your Google Calendar"
    line = "Google refreshes subscribed calendars about once a day."
    actions = (
      <Button asChild kind="default" size="md">
        <a href={s.subscribe_url} target="_blank" rel="noopener noreferrer">
          <CalendarPlus />
          Add to Google Calendar
          <ExternalLink />
        </a>
      </Button>
    )
  } else if (!s.connected) {
    heading = "Connect your Google Calendar"
    line = `One click. We add a calendar called “${NAME_ONE_LINE}” to your Google account and keep it up to date. We cannot see your other calendars.`
    actions = (
      <Button kind="primary" size="md" onClick={() => void connect()} loading={connecting}>
        <CalendarPlus />
        Connect Google Calendar
      </Button>
    )
  } else if (lost) {
    heading = "Reconnect your Google Calendar"
    line = s.error
    actions = (
      <>
        <Button kind="primary" size="md" onClick={() => void connect()} loading={connecting}>
          <CalendarSync />
          Connect again
        </Button>
        <Button kind="quiet" size="md" onClick={() => setConfirm(true)}>
          Disconnect
        </Button>
      </>
    )
  } else {
    heading = `Connected as ${s.google_email ?? "your Google account"}`
    line = slipped ? (
      <span className="text-caution">{s.error}</span>
    ) : (
      <>
        {s.last_synced ? (
          <>
            Synced <Ago iso={s.last_synced} />.{" "}
          </>
        ) : (
          "Not synced yet. "
        )}
        “{(s.calendar_name ?? NAME).replace(" ", "\u00a0")}” stays up to date on its own.
      </>
    )
    actions = (
      <>
        <Button kind="default" size="md" onClick={() => void syncNow()} loading={sync.isPending}>
          <RefreshCw />
          Sync now
        </Button>
        <Button kind="quiet" size="md" onClick={() => setConfirm(true)}>
          Disconnect
        </Button>
      </>
    )
  }

  return (
    <div className="space-y-2">
      <section aria-label="Google Calendar" className="panel flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-control bg-[var(--area-time-wash)] max-sm:hidden">
          <CalendarSync className="size-5 text-[var(--area-time)]" />
        </span>
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-base font-medium">{heading}</h2>
          <p className="text-sm text-fg-muted">{line}</p>
        </div>
        <div className="flex items-center gap-2 max-sm:w-full sm:flex-wrap [&>*:first-child]:max-sm:flex-1">
          {actions}
          <OtherCalendarApps />
        </div>
      </section>

      {notice && (
        <Callout tone={notice.tone}>
          <span className="flex items-start gap-2">
            <span className="min-w-0 flex-1">{notice.text}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={dismiss}
              className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-4" aria-hidden />
            </button>
          </span>
        </Callout>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title="Disconnect Google Calendar?"
        description={`This removes the “${NAME}” calendar from your Google account and stops syncing. Nothing on this site is deleted.`}
        confirmLabel="Disconnect"
        onConfirm={disconnect}
      />
    </div>
  )
}

/**
 * Outlook, Apple and anything else that can follow a calendar link, plus the
 * link itself and the way to change it. Always there, never the headline: most
 * people will use Google and never open it.
 */
function OtherCalendarApps() {
  const [confirm, setConfirm] = useState(false)
  const link = useApi<FeedLink>(["calendar", "feed-link"], "/api/calendar/feed-link", { staleTime: Infinity })
  const reset = useApiMutation<void, FeedLink>("/api/calendar/feed-link/reset", {
    invalidates: [["calendar", "feed-link"]],
  })

  async function copy() {
    if (!link.data) return
    try {
      await navigator.clipboard.writeText(link.data.url)
      toast.ok("Calendar link copied. Paste it into any calendar that can follow a link.")
    } catch {
      toast.fail(new Error("Could not copy. Select the link and copy it by hand."))
    }
  }

  async function doReset() {
    await reset.mutateAsync(undefined as never)
    toast.ok("New link made. The old one no longer works.")
  }

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button kind="quiet" size="md" aria-label="Other calendar apps" className="max-sm:px-0">
            <span className="max-sm:hidden">Other calendar apps</span>
            <ChevronDown className="max-sm:hidden" />
            <Ellipsis className="sm:hidden" />
          </Button>
        </MenuTrigger>
        <MenuContent align="end" className="w-80">
          <MenuItem disabled={!link.data} onSelect={() => link.data && window.location.assign(link.data.webcal)}>
            <span className="inline-flex items-center gap-1.5">
              <Mail aria-hidden /> Add to Outlook or Apple Calendar
            </span>
          </MenuItem>
          <MenuItem disabled={!link.data} onSelect={() => void copy()}>
            <span className="inline-flex items-center gap-1.5">
              <Copy aria-hidden /> Copy calendar link
            </span>
          </MenuItem>
          <MenuItem danger onSelect={() => setConfirm(true)}>
            <span className="inline-flex items-center gap-1.5">
              <RotateCcw aria-hidden /> Reset link
            </span>
          </MenuItem>
          <MenuSeparator />
          <MenuLabel className="whitespace-normal leading-4">
            The link shows titles and dates only, never amounts. Outlook and Apple check it every few hours.
          </MenuLabel>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title="Reset your calendar link?"
        description="The old link stops working. You'll need to add the calendar again in each app that followed it."
        confirmLabel="Reset link"
        onConfirm={doReset}
      />
    </>
  )
}
