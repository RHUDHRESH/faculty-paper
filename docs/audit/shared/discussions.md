# Audit: Discussions (`/discussions`, and a thread at `/discussions/:id`)

`/discussions` renders the feed (`feed.tsx`), which belongs to the feed helper; this card covers the thread page and the new-conversation dialog in `discussions.tsx`.

## 1. Who and why
A faculty member who asked "which journal for a signal processing paper?" and reads the answers, or someone who follows a notification into a thread.

## 2. What it showed before
Screenshot: `img/discussions-before-1440.png` (the feed, unchanged here). Thread: see `img/discussion-thread-after-390.png`.

| Part | Problem |
|---|---|
| Posts | Name only, no face (docs/ux/17). |
| Header | A Refresh button and "Checked 1 minute ago" on a page that refreshes itself every 12 seconds. |
| Prose | "Nobody else can open it — not your department", "Sent to X — “title”" toasts. |
| Feed (not changed here) | Fine on data; "Follow" cards row is the feed helper's. NEEDS: none. |

## 3. What changed
- A face beside every author, from the server (`author_photo_url`, initials when there is none).
- Refresh and "Checked" removed; the thread polls.
- Toasts: "Sent to the research office", "Sent to a faculty member". Dashes out of the privacy note.

## 4. Evidence after
`img/discussion-thread-after-390.png` (no horizontal scroll), backend faces test.
