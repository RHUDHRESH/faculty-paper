# Audit: Notifications (`/notifications`) and the bell

Built in `frontend2/src/pages/notifications.tsx` and `app/notifications.tsx`. Backend copy checked in `core/api/journals.py`, `core/services/notify.py`, `core/api/profile_requests.py`.

## 1. Who and why
Everybody, daily: "did anything happen to my paper, did anyone write to me". The job is to see what is new and open the thing.

## 2. What it showed before
Screenshot: `img/notifications-before-1440.png`.

| Part | Problem |
|---|---|
| Header | No count. "Notification settings" was a small underlined link nobody would take for a button. |
| Tabs | A faculty member saw "Work", a tab for papers reaching a queue somebody works from, which is always empty for them. |
| Raw markup | A notification about a message that mentioned somebody showed the mention code in the body. |
| Copy leaks | Checked every claim notification: they say only the stage ("Approved for payment", "Paid", "Sent back to you", "Not accepted") and no desk. One gap: a claim without a number was titled "Ticket · ...". A profile-change answer said "declined". |
| Empty state | Good: says what would appear and gives the one action. Kept. |

## 3. What changed
- "4 unread. What happened to your papers, your posts and your messages." (real count, zero says "Nothing unread").
- "Notification settings" is a button. The Work tab shows for staff only, in the bell and on the page.
- Mention codes show as the person's name.
- Server: "Ticket" becomes "Your claim"; a declined profile change reads "change not accepted".
- Each row already has a face for the person who did it and the kind's icon otherwise, a dot and a tint while unread, and opens the thing it is about.

## 4. Evidence after
- Screenshots: `img/notifications-after-1440.png`, `img/notifications-after-390.png`.
- Tests: `notifications.test.tsx` (12 passing).
