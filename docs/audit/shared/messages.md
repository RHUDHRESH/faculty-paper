# Audit: Messages (`/messages`, `/messages/c/:id`)

Built in `frontend2/src/pages/messages/index.tsx` and `chat.tsx` (chat unchanged).

## 1. Who and why
Someone with a question for a colleague ("can I use your dataset?") or a reply to read. Daily for some, weekly for most.

## 2. What it showed before
Screenshot: `img/messages-before-1440.png`, chat `img/messages-chat-after-1440.png`.

| Part | Problem |
|---|---|
| Inbox | Good: face, name, last line, time, unread dot, one search box, a pinned row for the office. Kept. |
| Message previews | A message that mentioned somebody showed the raw markup (`@user:"Dr. R. S"`) in the inbox line. |
| Container | A hand-set 12 px radius on the two-pane frame. |
| Start pane | Kept: "People you have written papers with", one button. |

## 3. What changed
- Previews and notifications show the display text of a mention, never the markup.
- The frame uses the panel radius.
- The office row and its pane are covered in `messages-office.md`.

## 4. Evidence after
Screenshots `img/messages-after-390.png` (the phone shows the inbox alone, with the round New button), `img/messages-chat-after-1440.png`. No horizontal scroll at 390. Existing social-plus tests pass.
