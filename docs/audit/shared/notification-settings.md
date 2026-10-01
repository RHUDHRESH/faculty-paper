# Audit: Notification settings (`/settings/notifications`)

Built in `frontend2/src/pages/notification-settings.tsx`.

## 1. Who and why
Somebody who is getting too many alerts, or too few. Rarely, and always with one aim: switch this kind off, or send it to email.

## 2. What it showed before
Screenshot: `img/notification-settings-before-1440.png`.

| Part | Problem |
|---|---|
| Email notice | "Email needs the college's mail server (SMTP) to be set up": a faculty member cannot set up SMTP. |
| Columns | "In app" and "Email" headed only the first group; by the third group the switches were unlabelled. |
| Back link | Hidden inside the sentence under the title. |
| Switches | One row per kind with a description, two switches, saved at once. Right. Kept. |

## 3. What changed
- Faculty read "Email is not switched on for the college yet, so everything arrives in the app for now. Your email choices below are kept for when it is." The SMTP wording stays for the super admin only (the server sends the mail-server block to them alone).
- The two column heads repeat on every group.
- "Notifications" is a quiet back button above the title.

## 4. Evidence after
Screenshot `img/notification-settings-after-390.png` (switch pairs stay 40 px apart, no sideways scroll).
