# Faculty Publication App — build plan

Every screen and every feature planned for the rebuild, what each one is for,
and what has to exist behind it.

**Status key** — ✅ built · 🟡 in progress · ⬜ not started · 🆕 does not exist
in the current app

---

## 1. What this is, and the rules it is built to

A second frontend in `frontend2/`, talking to the **same Django API**. The live
app keeps serving all 525 accounts untouched. The switch, when everything is
finished, is one line in `vercel.json`.

### The three references

| Reference | What is taken from it |
|---|---|
| **Notion** | The page. White ground, no cards floating on grey, hierarchy carried by type and space rather than boxes and shadow. |
| **Linear** | The keyboard. Ctrl-K is the way around, not a search box. Motion is fast and never in the way. |
| **Stripe** | The table. Dense, aligned, tabular numerals, quiet rules, numbers that can be compared down a column. |

### The rule underneath all of it

> **Borders and shadows are expensive. Whitespace is free.**

A shadow means *this floats above the page* — menus, dialogs, the palette, and
nothing else. A border means *these two things are genuinely different
regions*. Everything else is separated by space, weight and colour. That is
what lets the interface be dense without being loud.

### Design constants

- **Type** — Inter only. 14px body, 13px dense rows, 22px page titles. No
  all-caps letterspaced section labels; uppercase is reserved for column heads
  in a grid, where the label really is a machine category.
- **Colour** — near-greyscale. One indigo accent, used only for things you can
  act on and things that carry state (paid, overdue, refused). Colour is
  information, not decoration.
- **Shape** — 6px radius. 12px turns a panel into a lozenge.
- **Motion** — 80–220ms, `cubic-bezier(0.16, 1, 0.3, 1)`. Anything a pointer
  triggered should read as a response. Shared-element `layoutId` transitions
  for things that persist across routes. Fully disabled under
  `prefers-reduced-motion`.
- **Density** — one comfortable density everywhere (your call), rows ~44px.
- **Money** — `₹` always, paise only when there are any, tabular numerals so a
  column can be read down.

### Non-negotiables carried across

These are **enforced server-side** and no frontend can weaken them. They are
listed so the rebuild is checked against them, not so they are re-implemented.

- Money-blindness for HOD accounts — every money key stripped on the server.
- The four-step chain: Filed → Checked → Approved → Paid. Finance cannot see a
  ticket until the Principal has approved it.
- Duplicate-payment detection and the second-approver rule on high-value claims.
- A paid publication, a ledger row and the audit log cannot be deleted.
- Identity fields are super-admin-only; a claimant may only *request* a change.

---

## 2. Foundation

| # | Piece | Status | Notes |
|---|---|---|---|
| 1.1 | Vite + React 19 + TS + Tailwind v4 scaffold | ✅ | Port 5174, proxies `/api` and `/media` to Django |
| 1.2 | Design tokens (`styles.css`) | ✅ | Colour, type scale, shape, motion, layout |
| 1.3 | `api.ts` — one fetch path, CSRF, 401 handling | ✅ | Same-origin; session expiry announced once, globally |
| 1.4 | `query.ts` — TanStack Query, no retry on 4xx | ✅ | A 403 will not become a 200 by asking again |
| 1.5 | `auth.tsx` — session, roles, `can()` | ✅ | One place answers "what may this account see" |
| 1.6 | `nav.ts` — every route, once, with roles | ✅ | Kills the old app's three copies of Reports |
| 1.7 | App shell — sidebar, collapse, mobile drawer | ✅ | Active item slides via shared `layoutId` |
| 1.8 | Command palette (Ctrl-K) | ✅ | Pages local + instant; records debounced underneath |
| 1.9 | `Button`, `Text`, `Stage`, `money()` | ✅ | Four button kinds, not a variant grab-bag |
| 1.10 | `Table` — sticky head, edge shadows, row links | ✅ | Sticky head, edge shadows that appear only when there is more, row links on the first cell only |
| 1.11 | `Combobox` — type-to-filter select | ✅ | Type to filter, prefix matches first, full keyboard, click-away does not pick |
| 1.12 | `Dialog`, `Sheet`, `Menu`, `Tooltip` on Radix | ✅ | Behaviour from Radix, every pixel written here. `ConfirmDialog` can demand a typed phrase |
| 1.13 | `Field` set — input, textarea, checkbox, radio, date | ✅ | One focus ring, one error convention. Labels sit beside checkbox, radio and switch |
| 1.14 | `EmptyState`, `ErrorState`, skeletons | ✅ | An error never renders as "you have nothing" — three different sentences |
| 1.15 | Toast conventions | ✅ | Outcome plus what it changed, never a bare "Saved" |
| 1.16 | Charts — trend, ranked bars, mix bar, distribution | ✅ | No library. Every chart is also a table; bars link where a row is a record |
| 1.17 | Stepped wizard shell | ✅ | Rail, footer, focus and validation. Content never waits on an animation |
| 1.18 | Product tour / first-run | ✅ | Points at real elements; a step whose target is not on the page is dropped, not shown against nothing |

---

## 3. Screens — everybody

| # | Screen | Route | Status | What it is for |
|---|---|---|---|---|
| 2.1 | Sign in | `/` when signed out | ✅ | Two fields. Password revealable, caps-lock warned — your issued passwords are 24 random characters typed off paper |
| 2.2 | Set a new password | modal | ⬜ | Forced on first sign-in. Must close when it succeeds — the old one did not |
| 2.3 | Your profile | `/me` | ✅ | Identity read-only, and it says why rather than just refusing |
| 2.4 | Request a correction | `/me` | ✅ | One open request per field; a decline shows its reason |
| 2.5 | Notifications | panel | ⬜ | Unread count, deep links that land on the thing |
| 2.6 | Calendar | `/calendar` | 🆕 ⬜ | Payout runs, submission windows, your own deadlines |
| 2.7 | Not-found / no-access | `*` | ⬜ | Says which, and offers the way back |

---

## 4. Screens — faculty (499 of 525 accounts)

| # | Screen | Route | Status | What it is for |
|---|---|---|---|---|
| 3.1 | **Home** | `/` | ✅ | Received · on the way · needs you. Then what needs them. Then the rest |
| 3.2 | My papers | `/papers` | ✅ | Stage chips counted in one query, filters held in the URL, estimates flagged |
| 3.3 | Paper detail | `/papers/:id` | ✅ | Where it is, what to fix, why the amount, what happened — in that order |
| 3.4 | **File a paper** | `/papers/new` | ⬜ | Stepped wizard. Autosave. Scopus lookup. Duplicate warning before submit |
| 3.5 | Withdraw / edit a draft | `/papers/:id` | ⬜ | A submitted paper can be pulled back before it is checked |
| 3.6 | Why was this the amount | `/papers/:id` | ⬜ | The formula shown against this paper's own numbers |
| 3.7 | Sent back — what to fix | `/papers/:id` | ⬜ | The reason, at the top, with the fields it concerns marked |

---

## 5. Screens — research cell / super admin

| # | Screen | Route | Status | What it is for |
|---|---|---|---|---|
| 4.1 | Home | `/` | ⬜ | What is stuck, what is waiting, what moved |
| 4.2 | **Clearing queue** | `/clearing` | ⬜ | The daily job. Full-width titles, wait time, bulk clear with a running total |
| 4.3 | Review one ticket | `/clearing?t=` | ⬜ | Verification, the money, the history, clear or send back |
| 4.4 | Manual verification | in review | ⬜ | When Scopus cannot confirm, enter verified values with a source note |
| 4.5 | File for someone | `/papers/new?for=` | ⬜ | Same wizard, on behalf of a claimant |
| 4.6 | People | `/people` | ⬜ | Accounts, roles, departments |
| 4.7 | Person record | `/people/:id` | ⬜ | Everything one person has published and been paid |
| 4.8 | Profile requests | `/requests` | ⬜ | Corrections asked for; approve applies the value, decline gives a reason |
| 4.9 | Faults | `/faults` | ⬜ | What is broken, blocked or unreconciled, each row openable |
| 4.10 | Duplicates | `/duplicates` | ⬜ | Same paper paid twice; evidence, and a decision |
| 4.11 | Audit log | `/audit` | ⬜ | Who did what. Never editable, never deletable |
| 4.12 | Monthly run | `/policy/monthly` | ⬜ | Batch processing with progress and resumability |
| 4.13 | ERP import | `/policy/import` | ⬜ | Upload, preview, apply, with the row-level report |
| 4.14 | Journal reference data | `/policy/journals` | ⬜ | SCImago and SNIP dumps, sync and status |
| 4.15 | Policy / formula | `/policy` | ⬜ | Rates, multipliers, thresholds — versioned, with effect dates |
| 4.16 | Data explorer | `/data` | ⬜ | 19 tables, correctable reference values |
| 4.17 | Delete a row · empty the system | `/data` | ⬜ | Both refuse anything carrying a payment |

---

## 6. Screens — principal

| # | Screen | Route | Status | What it is for |
|---|---|---|---|---|
| 5.1 | Home | `/` | ⬜ | What is waiting on her, and what the college is doing |
| 5.2 | **Approvals** | `/approvals` | ⬜ | Sort and filter by wait time; running total of the selection |
| 5.3 | Every ticket | `/publications` | ⬜ | Read-only view of the whole pipeline |
| 5.4 | Comment to the research cell | on a ticket | ⬜ | Private to the office; not part of the claimant's history |

---

## 7. Screens — finance

| # | Screen | Route | Status | What it is for |
|---|---|---|---|---|
| 6.1 | Home | `/` | ⬜ | What is payable, what it totals, what is blocked |
| 6.2 | **Payment orders** | `/payments` | ⬜ | Pay one or many. Amount re-checked at the moment of paying |
| 6.3 | Processed | `/payments/done` | ⬜ | What has been paid, with vouchers |
| 6.4 | Void a payment | on a row | ⬜ | Writes a reversing ledger entry; never deletes |
| 6.5 | Ledger | `/ledger` | ⬜ | Every movement, exportable |
| 6.6 | Budget | `/budget` | ⬜ | Allocation against spend, per year |

---

## 8. Screens — head of department

Money-blind throughout. Enforced on the server, not by hiding columns.

| # | Screen | Route | Status | What it is for |
|---|---|---|---|---|
| 7.1 | Home | `/` | ⬜ | The department's output, staff who published, staff who did not |
| 7.2 | Department publications | `/publications` | ⬜ | Scoped to their own department, no money, downloadable |
| 7.3 | Staff | `/people` | ⬜ | Their own staff, publications and first-authorship only |

---

## 9. Screens — looking at the college

| # | Screen | Route | Status | What it is for |
|---|---|---|---|---|
| 8.1 | **Publications** | `/publications` | ⬜ | Query anything. Filters fold away; results lead |
| 8.2 | **Reports** | `/reports` | ⬜ | Fewer, larger figures — each opens the rows behind it in place |
| 8.3 | Report drill-down | panel | ⬜ | Opens over the page. Escape returns you where you were |
| 8.4 | Journal record | `/journals/:title` | ⬜ | SJR, SNIP, quartile per subject, who publishes there |
| 8.5 | Journals index | `/journals` | ⬜ | Most-used, searchable |
| 8.6 | Accreditation | `/accreditation` | ⬜ | NAAC/NIRF tables, what would fail, correct it here |
| 8.7 | Exports | throughout | ⬜ | xlsx · csv · json · pdf · docx, of exactly what is on screen |

---

## 10. New surfaces 🆕

The three things that make this more than a claims system. **All three need
backend work that does not exist yet.**

### 10.1 Discover — help me find something to publish

| # | Feature | Status | Needs |
|---|---|---|---|
| 9.1 | Pick your interest domains | ⬜ | `ResearchInterest` model |
| 9.2 | What is new in your areas | ⬜ | Gemini + a source of recent work |
| 9.3 | Topic suggestions from your own record | ⬜ | Gemini, prompted with your papers and journals |
| 9.4 | Journals that fit a topic | ⬜ | Existing SCImago data + matching |
| 9.5 | Calls for papers / deadlines | ⬜ | Feeds into the calendar |

**Explicitly not built:** a chatbot, and analysis of what you have already
filed. You asked for ideas and what is new, not a conversation.

### 10.2 Who to work with — the collaboration graph

The good news: **this is computable from data you already hold.** Two faculty
who filed claims for the same paper *are* co-authors, and the duplicate
detector already matches on DOI and normalised title.

| # | Feature | Status | Needs |
|---|---|---|---|
| 10.1 | Who has worked with whom | ✅ | Derived from shared DOI / normalised title. 466 shared papers, 421 pairs, no data entry |
| 10.2 | Your own network, visualised | ✅ | SVG, deterministic circle grouped by department — a force layout reshuffles on every reload |
| 10.3 | Department-to-department collaboration | ⬜ | Same derivation, aggregated |
| 10.4 | Who could you work with | ✅ | Shared journals, minus existing co-authors. Cross-department flagged |
| 10.5 | Person → their interests and output | ⬜ | Person record, extended |
| 10.6 | Introduce me | ⬜ | Starts a discussion thread with them |

### 10.3 Discussions — the forum

| # | Feature | Status | Needs |
|---|---|---|---|
| 11.1 | Threads by topic / interest area | ⬜ | `Thread`, `Post` models |
| 11.2 | Post, reply, edit, delete own | ⬜ | Same models |
| 11.3 | Ask the admin — private to the office | ⬜ | Thread visibility field |
| 11.4 | Follow a thread, notifications | ⬜ | `Subscription` model |
| 11.5 | Mentions | ⬜ | Parsing + notification |
| 11.6 | Attach a paper or journal to a thread | ⬜ | Reference field |
| 11.7 | Moderation | ⬜ | Admin controls, audit entries |

---

## 11. Backend work required 🆕

The API is otherwise unchanged. These are additions the new surfaces need.

| # | Work | For |
|---|---|---|
| 12.1 | `ResearchInterest` model + endpoints | Discover, Collaborate — Done — vocabulary drawn from our own 302 Scimago categories |
| 12.2 | `Thread` / `Post` / `Subscription` models + endpoints | Discussions |
| 12.3 | Co-authorship derivation endpoint | Collaborate — Done — `/collaborate/me` and `/collaborate/graph`, 18 tests |
| 12.4 | Recommendation endpoint | Collaborate |
| 12.5 | Gemini service + key in Secret Manager | Discover — Service done; **key still needed** |
| 12.6 | Calendar events endpoint | Calendar |
| 12.7 | Notification types for the above | All three |

---

## 12. Sequence

Ordered by how much each unblocks, not by how interesting it is.

| Phase | Contents | Why here |
|---|---|---|
| **A** ✅ | Foundation, sign-in, faculty home | Done. Proves the stack end to end |
| **B** | Table, Combobox, Dialog/Sheet, Fields, Empty/Error, toasts | Every later screen needs these. Building pages first means rewriting them |
| **C** | Faculty: my papers, paper detail, filing wizard | 499 of 525 accounts |
| **D** | Clearing queue, review, payment orders, approvals | The daily work of the office |
| **E** | Publications, reports, drill-down, journals | The oversight surface |
| **F** | People, requests, faults, duplicates, audit, data, policy | Administration |
| **G** | Accreditation, exports, budget, ledger, monthly run | Periodic work |
| **H** | Discover, Collaborate, Discussions, Calendar | The new surfaces. Backend first |
| **I** | Mobile pass, tour, polish, the 17 audits re-pointed | Before the switch |
| **J** | Cut over `vercel.json`; retire `frontend/` | One line |

---

## 13. How each screen is checked

Nothing counts as built until:

1. It typechecks and lints clean.
2. It renders against **real data** — 3,236 publications, 525 accounts — not
   fixtures.
3. It survives the page audit: no overflow, no sideways scroll at 390px, no
   console errors, no blank shell, every internal link resolving.
4. Its role boundary is verified — a head sees no money, a claimant sees only
   their own.
5. I have looked at a screenshot of it and said what is wrong with it.

The 17 browser audits from the current app are re-pointed at the new one as it
goes. They are the acceptance spec, and they are why "rewrite the logic too"
is safe: the guards they check are server-side and cannot be lost here.

---

## 14. Open questions

1. **Google sign-in** — build it into the new login from the start, or
   password-only for now? Needs a decision before phase B closes.
2. **Gemini key** — needs creating and putting in Secret Manager before 10.1
   can be more than a screen.
3. **Discussions moderation** — who can delete somebody else's post?
4. **Calendar** — what actually goes in it besides payout runs?
5. **Interests** — free text, or a fixed taxonomy? Affects whether
   recommendations are any good.
