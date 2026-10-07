# 12 · Calendar: a real interactive calendar, plus Google Calendar

Area: **time** (sky). Route: `/calendar?view=month|week|agenda&date=YYYY-MM-DD`
(`pages/calendar.tsx`).

## What the walk found
- The calendar is a chronological list headed "27 May 2026 to 21 Feb 2027", with Earlier/Later
  links.
- It has 8 all-caps legend items and two entries, both "You filed…".
- There is no grid, no day view and no connection to anyone's real calendar.

## Purpose
Put college research dates (submission windows, deadlines, payout runs, meetings) and my own
events (filed, published, paid, personal reminders) on a proper calendar. Faculty should be
able to see them in **Google Calendar**, where they actually live.

## Event kinds (colour = icon + left rule; text stays fg)
Colour is never the only clue: no two kinds of event share an icon, and a key under the grid
names the ones on screen. Every colour is at least 4.5:1 against its own chip in light and dark.
A kind the page has never heard of reads "Event" (`kindLabelOf` in `calendar/model.ts`).
| Kind | Colour token | Icon | Who creates |
|---|---|---|---|
| Deadline, filing cutoff | critical | `AlarmClock` | office |
| Submission window (range) | time (sky) | `CalendarRange` | office |
| Payment run | positive | `IndianRupee` | office/finance |
| Meeting | people (terracotta) | `UsersRound` | office, HOD |
| Seminar, conference | navy | `Presentation`, `Mic` | office |
| Workshop, call for papers | caution | `Wrench`, `Megaphone` | office |
| Faculty development programme | time (sky) | `GraduationCap` | office |
| My: filed / published | record (navy) | `FileUp`, `FileCheck` | automatic |
| My: paid | positive | `IndianRupee` | automatic |
| Research scout deadline | caution | `Telescope` | automatic |
| My: personal reminder | fg-muted | `Bell` | me (private) |

## IA
```
DESKTOP (month)
┌ HeroBand area=time, compact ─────────────────────────────────────────────────────────┐
│ Calendar            ‹ September 2026 ›  [Today]   [Month|Week|Agenda]   [＋ Add event] │
│ Next: ⏰ Q3 submission window closes Fri 3 Oct (in 9 days)       [📅 Google Calendar ▾]│
└───────────────────────────────────────────────────────────────────────────────────────┘
┌ Filter chips: [All] [College dates] [My papers] [My reminders]   Dept ▾ ─────────────┐
├ Mon    Tue    Wed    Thu    Fri    Sat    Sun ─────────────────────────────────────────┤
│  1      2      3      4      5      6      7                                            │
│ ▌Payout      ▬▬▬▬▬▬▬ Submission window (spans) ▬▬▬▬▬▬▬▬▬                                 │
│  8 …   ● filed "Enhanced…"                                                             │
│ 22   23   [24 today ring]  25    26 ⏰ Deadline                                        │
│ max 3 chips/day, "+2 more" → day popover                                               │
└───────────────────────────────────────────────────────────────────────────────────────┘
WEEK: 7 columns, all-day row for ranges/deadlines, hour grid 8:00–20:00 for timed events.
AGENDA: the current list view (kept; best on phone and for screen readers).

PHONE: default view = Agenda; Month available as compact grid with dots per day,
tapping a day shows its events below the grid (Notion Calendar / iOS pattern).
Add event = floating ＋ button.
```

## Add event (quick add)
A title and a day are all it asks for; Enter adds. The rest is one tap away.
```
┌ Add event ─────────────────────────────────────────┐
│ Title [ Send revisions to the editor             ] │
│ Date  [24 Sep 2026]        □ Add a time (from, to) │
│ Who sees it: (●Only me ○My department* ○College*)* │
│ More options ⌄  kind · runs over days · paper · notes │
│                            [Cancel] [Add event]    │
└────────────────────────────────────────────────────┘
* only for roles allowed (office/HOD); faculty see "Only me" fixed.
```
Clicking an empty day opens it prefilled with that date. Kinds offered are the ones the server
lists (`kinds` in `GET /api/calendar`), so a kind added there appears here without a release.

## The event sheet
Clicking an event opens a **sheet** (from the right; from the bottom on a phone), not a page:
kind, title, when, notes, venue, speaker and link where there are any, who sees it, and the
actions Edit and Delete (own events, or the office), "Add to Google Calendar" and "Open paper".
Once Google Calendar is connected the sheet says the event is already there instead.

## Google Calendar: the trade-off, and what we build
| Option | What it gives | Cost / risk | Decision |
|---|---|---|---|
| **A. ICS subscription feed** (per-user secret URL, `webcal://`) | All my events appear in Google/Outlook/Apple Calendar, and they update automatically | One-way. Google refreshes subscribed feeds every **8–24h**, which is not configurable. The secret URL is a bearer token, so anyone with it can read the feed. | **Build (v1).** Include only non-sensitive fields: no amounts, no staff id. Offer a **Reset link** that rotates the token. |
| **B. "Add to Google Calendar" links** per event (`https://calendar.google.com/calendar/render?action=TEMPLATE&text=&dates=&details=`) | Instant, one-click, needs no OAuth | Manual, one event at a time, and no updates if the date changes | **Build (v1)** on every event popover and on deadline notifications. |
| **C. Two-way sync** via the Google Calendar API | Real-time, and edits in Google come back | Needs the `calendar.events` scope. Google classes it as **sensitive**, which requires OAuth consent-screen verification. We would have to store refresh tokens, handle revocation, and it widens the security surface. | **Do not build.** Nobody asked for write-back, and reading *their* events has no clear value here. |
| **D. Connect Google Calendar** (one-way push into a calendar of its own) | One click, no copy-paste, and a new date reaches Google within a minute or two. Nothing is read back. | Needs the OAuth client secret in the environment. Scope is `calendar.app.created` only: the app can make and manage calendars *it created* and cannot see any other. The refresh token is stored encrypted (Fernet, key derived from `SECRET_KEY`); a revoked token marks the link "connect again" and nothing else breaks. | **Build.** Where it is not set up, option A ("Add to Google Calendar", the subscribe link) is the one-click path. Setup: `docs/ops/go-live.md`, section 2b. |

One strip under the page title says where this calendar can go, and does it in one click:

| State | What the strip shows |
|---|---|
| Not set up on the server | **Add to Google Calendar** (opens `https://calendar.google.com/calendar/r?cid=` + the feed's `webcal://` address) and the line "Google refreshes subscribed calendars about once a day." |
| Set up, not connected | **Connect Google Calendar** (the page's one primary button; Add event steps back to an ordinary one) |
| Connected | "Connected as x@y", when it last synced, **Sync now**, **Disconnect** (asks first; removes the calendar we made and revokes the permission) |
| Google ended the link | "Google no longer lets us in. Connect again to carry on." and **Connect again** |
| A sync slipped | the reason, in words, and **Sync now** |

**Other calendar apps ▾** is always there: **Add to Outlook or Apple Calendar** (the `webcal://`
link), **Copy calendar link**, and **Reset link** with its confirm: "The old link stops working."
Coming back from Google, the page says once whether it worked (`?google=connected`, or
`?google=failed&why=…`; only the server's own sentences are printed, never other text from the address).

## Copy
- Hero "Next" line: "Next: {icon} {title} {relative date}". When nothing is coming up: "Nothing
  on the calendar in the next 30 days."
- Empty month: "A quiet month. College dates appear here as the research office adds them.
  [＋ Add a reminder]"
- Feed privacy note: "Your feed shows titles and dates only — never amounts."
- Error: "Could not load the calendar. Nothing on it has been changed. [Try again]"

## Data
- Existing endpoints: `GET /api/calendar?from=&to=`, `PATCH /api/calendar/{id}`.
- **NEW:** `POST /api/calendar` (create) and `DELETE /api/calendar/{id}`, with body
  `{title, kind, start, end, all_day, visibility:"me|department|college", notes}`.
  Visibility is enforced by role on the server.
- **NEW:** `GET /api/calendar/feed/{token}.ics`. It is unauthenticated and authorised by the
  token, with `Cache-Control: max-age=900`. It emits VEVENTs with `UID`s that stay stable.
- **NEW:** `GET /api/calendar/feed-link` returns `{url, webcal, google_subscribe_url}`, and
  `POST /api/calendar/feed-link/reset`.
- **NEW:** Connect Google Calendar: `GET /api/calendar/google/status`
  (`{configured, connected, google_email, calendar_name, last_synced, error, needs_reconnect,
  subscribe_url}`), `GET .../connect` (the consent address), `GET .../callback` (where Google sends
  the browser back), `POST .../sync`, `POST .../disconnect`. A calendar change queues
  `core.tasks.sync_google_calendars` for the connected people who can see it, and a daily
  schedule catches the rest.
- Events need a stable `id`, `kind`, `start`, `end`, `all_day` and `url` (paper link, when
  there is one).

## Acceptance
- [ ] Month, week and agenda views, with `‹ ›`, Today and keyboard arrows (←/→ move by
      period, T jumps to today).
- [ ] Multi-day windows render as spanning bars in month and week.
- [ ] Clicking a day or slot opens Add prefilled. Faculty can only create "Only me" events.
- [ ] Every event popover has "Add to Google Calendar", which opens the correct template URL.
- [ ] The ICS feed validates (RFC 5545) and imports into Google Calendar. Reset rotates it.
- [ ] The feed carries no money or staff ids.
- [ ] Phones default to Agenda. The month grid is compact with dots.
- [ ] With the Google client secret set, "Connect Google Calendar" is one click to Google and one back;
      the calendar "Saveetha Publications" appears and follows every change. Without it, "Add to
      Google Calendar" subscribes in one click.
- [ ] A revoked connection says "Connect again" and breaks nothing. Disconnect removes the calendar.
- [ ] Clicking an event opens a sheet, not a page. Adding needs only a title and a day.
