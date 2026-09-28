# 02 · Search and Ctrl-K (absorbs "Colleagues")

Area: neutral (navy actions), with results tinted by their entity's area.
Routes:

- `/search?q=&scope=`, rewriting `pages/search.tsx`.
- `/u` redirects to `/search?scope=people`.
- `pages/people.tsx` is retired as a page. Its directory list becomes the People scope.

Palette: `app/palette.tsx`, rebuilt on the same result renderer.

## Purpose
One box that finds **anything**: papers (ours and the literature), people (here and external
co-authors), journals, departments, topics, pages and actions. The palette is the same engine,
available everywhere. The page adds room, filters and an empty state that teaches.

## What the walk found
- The search page is a normal-sized field at the top left, over a paragraph of help text. It
  does not invite a search.
- Colleagues is a separate page with the same people data as search.
- The palette only knows pages, tickets, people and journals. It has no actions and no topics.

## User jobs
| # | Job |
|---|---|
| J1 | "Is this paper already claimed / does it exist?" (DOI or title) |
| J2 | "Find Dr X" (here, or an external co-author) and see how I'm connected |
| J3 | "Is this journal real / what quartile?" |
| J4 | "Who here works on federated learning?" (topic → people + papers) |
| J5 | "Take me to Calendar / file a paper / download my CSV" (pages + actions) |

## IA
```
DESKTOP /search (no query)
┌──────────────────────────────────────────────────────────────────────────────┐
│                 Find anything                (display, centred, 120px top)    │
│   ┌──────────────────────────────────────────────────────────────── Ctrl K ┐ │
│   │ ⌕  Papers, people, journals, topics, departments, pages…               │ │ 64px
│   └────────────────────────────────────────────────────────────────────────┘ │
│   [All] [Papers] [People] [Journals] [Topics] [Departments] [Pages & actions]│
│                                                                              │
│   Try:  "10.1016/j.…"   "Kanagamalliga"   "IEEE Access"   "federated learning"│
│   (chips, fill the box on click)                                             │
│                                                                              │
│   ┌ Jump to (ChoiceTiles, icon-xl, 4 across) ──────────────────────────────┐ │
│   │ [FilePlusCorner] File a paper  [UsersRound] Browse people  [BookOpen] Top   │ │
│   │                                                journals  [Building2] Depts │
│   └────────────────────────────────────────────────────────────────────────┘ │
│   Recent searches (last 5, local, clearable)                                  │
└──────────────────────────────────────────────────────────────────────────────┘

DESKTOP /search?q=kanaga
┌ BigSearch (docked to top, 56px) + scope chips with counts: All 14 · People 3 · Papers 9 · … ┐
├ Left 8/12: grouped results ─────────────────────────────┬ Right 4/12: preview ─────────────┤
│ PEOPLE (3)                                  See all →   │ [avatar 64] Dr. S. Kanagamalliga  │
│  ◉ Dr. S. Kanagamalliga · ECE · 104 papers   Saveetha   │ ECE · Associate Professor         │
│      You → Dr T. Jaya → her  (2 hops)                   │ ConnectionPath: You → X → her     │
│  ◉ S. Kanagaraj · IIT Madras · external co-author        │ "3 papers with Dr T. Jaya, who    │
│ PAPERS (9)                                               │  wrote 2 with you"                │
│  📄 Title… · IEEE Access · 2024 · Q2 · claimed by …      │ [Message] [Open profile]          │
│ JOURNALS (1) · TOPICS (1) · PAGES & ACTIONS (0)          │                                   │
└─────────────────────────────────────────────────────────┴───────────────────────────────────┘
People scope with empty q = the old Colleagues directory: department filter + A–Z grid of PersonCards.

PHONE: BigSearch 56px full-width under the page title; scope chips scroll horizontally;
results single column; preview opens as bottom sheet on tap-and-hold, tap opens entity.
```

## Palette (Ctrl-K / ⌘K / `/` when not in a field)
```
┌──────────────────────────────────────────────── modal 640px ┐
│ ⌕ kanaga_                                   [Esc]           │
├─────────────────────────────────────────────────────────────┤
│ PEOPLE                                                      │
│ ▸ ◉ Dr. S. Kanagamalliga   ECE · 2 hops           ↵ open    │
│ PAPERS                                                      │
│   📄 …                                                      │
│ ACTIONS                                                     │
│   ✉ Message Dr. S. Kanagamalliga                  ⌘↵        │
│ Search everything for "kanaga" →                  ⇧↵        │
└─────────────────────────────────────────────────────────────┘
```

- Groups appear in this order: exact-ID hit (a DOI or ticket number), then People, Papers,
  Journals, Topics, Departments, Pages, Actions.
- A group shows at most 4 rows in the palette and 5 on the page, with "See all" beneath.
- **Actions are verbs**, each with a keyword list: File a paper, Pull from Scopus, Download my
  papers (CSV), New message, Add calendar event, Open my impact card, Subscribe calendar to
  Google, Sign out.
- With an empty query, the palette shows *Recent*, 5 items, followed by *Suggested actions*
  that depend on context. For example, on `/papers` it offers "File a paper" and "Download
  CSV".
- **Keys:**
  - ↑↓ move through results.
  - ↵ opens the result.
  - ⌘↵ / Ctrl↵ runs the secondary action (Message a person, Copy a DOI).
  - ⇧↵ opens the full results on `/search?q=`.
  - Tab cycles through scopes.
  - Esc closes the palette.
- **ARIA:** the palette is a combobox with virtual focus (`aria-activedescendant`).

## Interactions
- Typing is debounced by 150ms. A request runs from 2 characters. A DOI pattern
  (`10.\d{4,}/`) skips the debounce and goes straight to `/api/lookup/paper`.
- Results stream in as groups resolve, so local groups do not wait for Crossref/OpenAlex. Each
  group has its own skeleton.
- The query is kept in the URL (`?q=&scope=`), so the back button restores it.
- The page recognises a paper as *mine* when it is in `/api/me/publications`. Mine get a
  "Yours" chip and a "File it" action if unclaimed.
- External people show their affiliation chip plus a ConnectionPath when one exists within 2
  hops. Otherwise they show "Not connected yet".
- The preview pane (desktop only) updates on arrow-key focus, without navigating.

## Copy
- Title: **"Find anything"**
- Placeholder: "Papers, people, journals, topics, departments, pages…"
- Hint under the chips: "Paste a DOI to check whether a paper exists and who has claimed it."
- No results: **"Nothing called "{q}" here or in the literature."** followed by "Check the
  spelling, try a DOI, or search only [People] / [Papers]." Use the plate illustration
  `empty-search.svg`.
- A source failed (for example OpenAlex is down): an inline caution chip in the Papers group,
  "Literature search is slow right now — showing our own records only. [Retry]".
- People scope, empty q: "Everyone at the college — {n} people. Filter by department, or type
  a name."

## Data
- Existing endpoints:
  - `/api/search` (claims, people, journals)
  - `/api/research/search`
  - `/api/lookup/paper`
  - `/api/people` (directory)
  - `/api/mentions/search` (fast typeahead)
  - `/api/meta/departments`
  - `/api/meta/research-domains` (topics)
- **External people:** `/api/search/people-external?q=` (planned) returns
  `[{id, name, affiliation, openalex_id, papers_with_saveetha, hops, via:[{id,name}]}]`.
- **NEW: `/api/search/all?q=&scope=&limit=`**, a fan-out on the server that returns
  ```json
  { "groups": [ {"kind":"person|paper|journal|topic|department|page|action",
                 "total": 3, "items":[{"id","title","subtitle","url","chips":[],"secondary_action":{}}],
                 "status":"ok|partial|error"} ] }
  ```
  Pages and actions are resolved on the client from `nav.ts` plus an `ACTIONS` registry. The
  server does not need to know them.

## Acceptance
- [ ] `/search` with no query shows the centred 64px box, scope chips, try-chips and jump
      tiles.
- [ ] One query returns grouped results across at least 5 kinds. A DOI resolves to an
      exact-hit row at the top.
- [ ] `/u` redirects to `/search?scope=people`. The directory grid and the department filter
      work with an empty query.
- [ ] Ctrl-K opens from any page, including inside the file wizard, and shows the same
      groups. Actions are executable.
- [ ] External co-authors appear with an affiliation chip and a 2-hop path when one exists.
- [ ] Keyboard only: open, search, arrow, open the result, return. No pointer is needed.
- [ ] 390px: chips scroll, and there is no horizontal page scroll.
