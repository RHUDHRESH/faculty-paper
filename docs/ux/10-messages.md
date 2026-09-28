# 10 · Messages: redesign

Area: **people** (terracotta). Route: `/messages` (`pages/chat.tsx`), with `/messages/:threadId`.

## Why it is confusing today
- There are three concepts on one screen: tabs for "Direct" and "The office", an `@agent`
  mention explained in the subtitle, and a pointer to Discussions.
- The empty state is a big grey box. The privacy notice is a full-width callout above it.
- A new message starts from a button that opens a dialog, and there is no inbox/conversation
  split.

## Redesign
There is **one inbox, and a conversation is a conversation**. The kind of thread is a small
chip, not a tab. The layout is the familiar two-pane pattern (Slack, iMessage, LinkedIn).

Thread kinds:

- **Person:** a DM with one colleague, or a small group.
- **Research office:** a thread with the office (it replaces "The office" tab). It is pinned
  at the top, always present, with a navy `Building2` avatar.
- **Assistant:** `@agent` stays as a mention *inside* any thread. It is explained by a tooltip
  on the composer's `@` button, not in the page subtitle.

## IA
```
DESKTOP
┌ Inbox 340px ─────────────────────┬ Conversation ──────────────────────────────────────┐
│ Messages               [✎ New]   │ ◉ Dr T. Jaya · ECE          [Profile] [⋯]           │
│ ⌕ Search people and messages     │ 🔒 Only you and Dr T. Jaya can read this.  (12px)   │
│ ─ Pinned ─                       │                                                     │
│ [🏛] Research office   ● 1       │   ┌ context card (when opened from a paper/person) ┐│
│      "Your claim ERP-72 was…"    │   │ 📄 Enhanced ML Framework… · attached as context ││
│ ─ Recent ─                       │   └─────────────────────────────────────────────────┘│
│ ◉ Dr T. Jaya          2h         │   Dr T. Jaya · 10:02                                │
│   "Sure — send me the draft"     │   ┌───────────────────────┐                         │
│ ◉ Group: IEEE Access paper 3     │   │ Sure — send me the …  │                         │
│ ◉ Dr S. Kanagamalliga  Mon       │   └───────────────────────┘                         │
│                                  │                          ┌──────────────────────┐   │
│                                  │                          │ Here it is 📎 draft… │ you│
│                                  │                          └──────────────────────┘   │
│                                  ├─────────────────────────────────────────────────────┤
│                                  │ [@] [📎] Write a message…                  [Send ↵] │
└──────────────────────────────────┴─────────────────────────────────────────────────────┘
No thread selected → right pane shows empty-messages.svg + "Start a conversation" +
3 suggested people (recent co-authors) as PersonCards with [Message].

PHONE: inbox full-screen; tap → conversation full-screen with back arrow; composer
sticks above the keyboard; New = floating ✎ button bottom-right.
```

## Interactions
- **New (✎)** opens a people picker, which is the Search people scope limited to messageable
  people. Picking one person opens the existing thread or creates one
  (`POST /api/dm/with/{id}`). Picking several creates a group.
- **Entry points everywhere:**
  - "Message" on PersonCards, profiles and the connection Sheet opens the thread directly.
  - "Ask the research office" on a claim opens the Research office thread with a paper context
    card.
- **Context cards:** when a thread is opened *from* a paper or person, the composer attaches a
  context card, which can be dismissed with ✕ before sending.
- **Enter** sends and **Shift-Enter** inserts a newline. Unread state clears on view
  (`POST /dm/{id}/read`).
- **The privacy line** is one 12px line with a lock under the conversation header. It replaces
  the big callout.
- **Discussions** stays a separate nav item. Messages does not advertise it in the subtitle.

## Copy
- Title: **"Messages"**. There is no subtitle.
- No thread selected: **"Start a conversation"**, then "Message a co-author about a paper, a
  venue or an idea." The three suggestions are headed "People you've written with".
- Inbox empty: "No conversations yet."
- Research office thread intro (first message, system): "Ask the research office anything about
  your claims. They usually reply within 2 working days."
- `@` tooltip: "Mention a person, paper or journal — or @agent to ask the assistant."
- Send failure: "Not sent. [Retry]", inline under the bubble.

## Data
- Existing endpoints:
  - `/api/dm`, `/api/dm/unread`, `/api/dm/with/{user_id}`
  - `/api/dm/{thread_id}` and its `/messages` and `/read`
  - `/api/threads/*` (office)
  - `/api/mentions/search`
- **NEW:** the `/api/dm` list merges office threads, returning
  `[{id, kind:"person|group|office", title, avatar, last:{text,at,from}, unread}]` so the inbox
  is one list. Alternatively, the client merges `/api/dm` and `/api/threads`.
- **NEW:** optional `context: {kind:"paper|person", id}` on the first message POST.

## Acceptance
- [ ] Two-pane layout on desktop and single-pane navigation on phones.
- [ ] The Research office is a pinned thread, not a tab.
- [ ] `@agent` is explained only in the composer tooltip.
- [ ] Every "Message" button in the app lands in the right thread.
- [ ] The empty state suggests co-authors.
- [ ] The privacy line is visible in every conversation.
