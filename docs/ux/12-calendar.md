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

## Event kinds (colour = dot + left rule; text stays fg)
| Kind | Colour token | Icon | Who creates |
|---|---|---|---|
| Deadline | critical | `AlarmClock` | office |
| Submission window (range) | time (sky) | `CalendarRange` | office |
| Payout run | positive | `IndianRupee` | office/finance |
| Meeting / workshop | people (terracotta) | `UsersRound` | office, HOD |
| My: filed / published / paid | record (navy) | `FileText` | automatic |
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

## Add event (dialog, Cal.com-style quick-add)
```
┌ Add event ─────────────────────────────────────────┐
│ Title [ Workshop: writing for Q1 journals        ] │
│ Kind  (●Reminder ○Meeting ○Deadline ○Window)*      │
│ When  [24 Sep 2026] [10:00]–[11:00]  □ All day     │
│       □ Ends on a different day (range)            │
│ Who sees it: (●Only me ○My department* ○College*)  │
│ Notes [                                          ] │
│ □ Add to my Google Calendar after saving           │
│                           [Cancel] [Save event]    │
└────────────────────────────────────────────────────┘
* only for roles allowed (office/HOD); faculty see "Only me" fixed.
```
Clicking or dragging on an empty day or slot opens the dialog prefilled with that date or time.
Clicking an event opens a popover with its details and the actions Edit, Delete (own events
only), "Add to Google Calendar ↗" and "Open paper".

## Google Calendar: the trade-off, and what we build
| Option | What it gives | Cost / risk | Decision |
|---|---|---|---|
| **A. ICS subscription feed** (per-user secret URL, `webcal://`) | All my events appear in Google/Outlook/Apple Calendar, and they update automatically | One-way. Google refreshes subscribed feeds every **8–24h**, which is not configurable. The secret URL is a bearer token, so anyone with it can read the feed. | **Build (v1).** Include only non-sensitive fields: no amounts, no staff id. Offer a **Reset link** that rotates the token. |
| **B. "Add to Google Calendar" links** per event (`https://calendar.google.com/calendar/render?action=TEMPLATE&text=&dates=&details=`) | Instant, one-click, needs no OAuth | Manual, one event at a time, and no updates if the date changes | **Build (v1)** on every event popover and on deadline notifications. |
| **C. Two-way sync** via the Google Calendar API | Real-time, and edits in Google come back | Needs the `calendar.events` scope. Google classes it as **sensitive**, which requires OAuth consent-screen verification. We would have to store refresh tokens, handle revocation, and it widens the security surface. | **Do not build now.** Revisit only if faculty ask for write-back. A read-only `calendar.events.readonly` import of *their* events has no clear value here. |

The Google Calendar menu (the "📅 Google Calendar ▾" button) holds:

- **Subscribe in Google Calendar.** This opens
  `https://calendar.google.com/calendar/r?cid=webcal://{host}/api/calendar/feed/{token}.ics`.
- **Copy feed link (for Outlook / Apple).**
- **Reset link**, with a confirm dialog: "The old link stops working. You'll need to subscribe
  again."
- Help text: "Google checks for changes every 8–24 hours. For an event you need right away,
  use "Add to Google Calendar" on the event."

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
