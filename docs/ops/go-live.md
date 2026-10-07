# Go live: Render (app) + Neon (database) + R2 (files and backups)

About 30 minutes, in this order. Nothing here needs a terminal. Paste every key into
the service named, never into chat or email.

## 0. Accounts (one-time, free)
| Service | Why | What to copy |
|---|---|---|
| **Neon** (neon.tech, sign in with GitHub) | The database. Never expires, point-in-time restore. | Project → **Connect** → *Connection string*, **Pooled connection: OFF** (the address must NOT contain `-pooler`). It ends in `?sslmode=require&channel_binding=require`. Region: **AWS Asia Pacific (Singapore)**. |
| **Cloudflare R2** (dash.cloudflare.com → R2), optional | Paper PDFs and photos, plus a daily off-site backup (14 kept). Free up to 10 GB, but Cloudflare asks for a card on file first. Skip it and files stay in Neon (the full restore is ~13 MB compressed, well inside Neon's 1 GB). | Create bucket `saveetha-publications` (private). R2 → **Manage API tokens** → *Object Read & Write* for that bucket: copy **Access Key ID**, **Secret Access Key** and the **S3 endpoint** `https://<account-id>.r2.cloudflarestorage.com`. |
| **Groq** (console.groq.com) | AI features. | A **new** API key (rotate the one that was pasted in chat). |
| **Brevo** (brevo.com), optional | Alert emails (300 a day free). | SMTP: host `smtp-relay.brevo.com`, port `2525`, login and SMTP key. |
| **Sentry** (sentry.io), optional | Tells you about server errors. No personal data is sent. | New project → Django → copy the **DSN**. |
| **UptimeRobot** (uptimerobot.com), optional | Emails you if the site goes down. | Add an HTTP monitor for `https://saveetha-publications.onrender.com/api/health`, every 5 minutes. |

## 1. Render
1. The old `faculty-paper-api` service: Settings → **Suspend** (done) or Delete.
2. **New → Blueprint** → repository **RHUDHRESH/faculty-paper**, branch **master**.
3. It lists two free services: `saveetha-publications-api` and `saveetha-publications`.
   No database (Neon holds it).
4. Fill in the secrets it asks for:
   - **DATABASE_URL**: the Neon direct connection string.
   - **AI_API_KEY**: the new Groq key. Provider and models are already set.
   - **S3_BUCKET_NAME** `saveetha-publications`, **S3_ENDPOINT_URL**, **AWS_ACCESS_KEY_ID**,
     **AWS_SECRET_ACCESS_KEY**: from R2. Leave all four empty to keep files in the database.
   - **GOOGLE_OAUTH_CLIENT_SECRET**: optional, for one-click Google Calendar (section 2b below).
   - **SENTRY_DSN**, the **EMAIL_*** fields, **SCOPUS_API_KEY**, **OPENALEX_API_KEY**: optional.
   - Leave **ANTHROPIC_API_KEY**, **WHATSAPP_*** empty.
5. **Apply.** The first build takes about 10 minutes. It's done when
   `https://saveetha-publications.onrender.com/api/health` shows `"ok": true`. The database
   tables are created at boot.

## 2. The college's data
1. `https://saveetha-publications.onrender.com/setup`: create the first super admin.
2. **Admin → Get the college running**:
   - **Restore**: already done. On 2026-10-06 the export was loaded straight into Neon from the
     project machine (160,524 records in 106 s, none dropped). For a future fresh database:
     upload `data\derived\restore-2026-10-01.jsonl.gz` here. The page shows progress, about
     5–10 minutes on the free server. If it stops, upload the same file again and it resumes.
   - **Roles**: give Director, Finance, Research cell and Research coordinator to the real people.
   - **Passwords**: everyone keeps the password in `data\all-accounts-LOCAL.csv`, or use
     **People → Issue passwords** to hand out fresh ones.
   - **Fix imported claims**: preview, then apply (51 old-ERP claims, 7 repeats and 3 rejected held).
3. **Google sign-in**: Google Cloud console → Credentials → OAuth client `635082195334-…` →
   *Authorised JavaScript origins* → add `https://saveetha-publications.onrender.com`. Then
   **Publish app** on the consent screen.

### Photos and files
The restore loads every record but none of the files they point to, so people show as initials
and claim attachments are broken until the files are added. The files are on the project
machine, in `backend\media`. One zip puts them back.

1. Make the zip. In PowerShell, from the project folder (use today's date):
   ```
   Compress-Archive -Path backend\media\avatars,backend\media\claims,backend\media\feed,backend\media\site -DestinationPath data\media-2026-10-07.zip
   ```
   That is about 800 files and 10 MB. Windows PowerShell writes the folder names with
   backslashes inside the zip; the upload accepts that.
2. Open **Admin → Get the college running**. Under *Also*, the **Photos and files** row has the
   picker. Choose the zip, leave *Overwrite files that already exist* off, press **Add the files**.
   It takes a few seconds and keeps this page's result on screen: how many were added, how many
   were already there, and the name and reason for any file it refused.
3. Run it again any time. A file that is already on the server is skipped, so a second run says
   *Nothing new*. Tick *Overwrite* only to replace the copies on the server with the ones in the
   zip. The row turns done when the photos and files the records name are there.

Only the folders `avatars`, `claims`, `feed` and `site` are read. Limits: 150 MB a zip, 20 MB
a file, 5,000 files; split a bigger set into two zips. On a machine with a shell the same
thing is `python manage.py import_media data\media-2026-10-07.zip` (add `--overwrite` to
replace).

## 2b. One-click Google Calendar (optional, about 10 minutes)
Until this is done the Calendar page still works: **Add to Google Calendar** subscribes to the
person's own feed link, and Google refreshes that about once a day. Once it is done, each person
gets **Connect Google Calendar**: one click, a calendar called "Saveetha Publications" appears in
their Google account, and it follows every change here (plus a daily pass at 05:30). The app asks
for the narrowest calendar permission Google offers, `calendar.app.created`: it can only touch the
calendar it made and cannot read anyone's other calendars. It also learns which Google account was
connected (`openid` and email, already used for sign-in).

Use the **same project and the same web client** as Google sign-in (`635082195334-…`).
1. **Enable the API.** Google Cloud console → **APIs & Services → Library** → *Google Calendar
   API* → **Enable**.
2. **Add the redirect address.** **Google Auth platform → Clients** → open the web client →
   *Authorised redirect URIs* → **Add URI**:
   `https://saveetha-publications.onrender.com/api/calendar/google/callback`
   Save. It must match exactly (no trailing slash, `https`). The *Authorised JavaScript origins*
   from section 2 stay as they are.
3. **Copy the client secret** from the same page (**Add secret** if none is shown; Google shows a
   new secret only once). Never paste it into chat or into a file in the repository.
4. **Allow the permission.** **Google Auth platform → Data Access → Add or remove scopes** → tick
   `…/auth/calendar.app.created` (and keep `openid` and `…/auth/userinfo.email`) → **Update**, **Save**.
5. **Avoid Google's review.** **Google Auth platform → Audience**:
   - If the project belongs to the college's Google Workspace organisation, choose **Internal**.
     Only college accounts can connect, and Google does not review an Internal app. This is the
     simplest route, and it matches sign-in, which already accepts only `saveetha.ac.in`.
   - If the project is a personal one, Internal is greyed out. Keep **External**, **In production**:
     people then see "Google hasn't verified this app" and press *Advanced → Go to … (unsafe)*, up to
     100 people, until Google verifies the app.
6. **Give Render the secret.** Render → `saveetha-publications-api` → **Environment** → add
   **GOOGLE_OAUTH_CLIENT_SECRET** = the secret → **Save, rebuild and deploy** (or *Restart*).
   `GOOGLE_OAUTH_CLIENT_ID` is already set by the blueprint.
7. **Try it.** Sign in, open **Calendar**: the button now says **Connect Google Calendar**. Click it,
   choose a Google account, **Allow**. You land back on Calendar with "Connected as …", and a calendar
   called "Saveetha Publications" is in Google Calendar. **Disconnect** removes that calendar again and
   revokes the permission.

If a person's Google access ends (they removed it in their Google account, or the secret changed) the
page says "Google no longer lets us in" with a **Connect again** button; nothing else breaks. Changing
`DJANGO_SECRET_KEY` makes every stored Google token unreadable, so everyone connects again once.

## 3. Keeping it healthy
- **Always on:** the `keep-alive` GitHub workflow pings `/api/health` every 4 minutes. If the
  address changes, set the repository variable `SITE_URL`.
- **Backups**, in three layers:
  1. Neon point-in-time restore (Neon console → Branches → Restore).
  2. A daily full copy to R2 at 04:15, the newest 14 kept (`backups/` in the bucket).
  3. A weekly copy inside the database, the newest 4 kept (Admin → Data health → Backup), which you
     can also download any time.
- **Safeguards:** 17 money checks run nightly. See Admin → Safeguards and Faults.
- **Errors:** Sentry emails you (if set). **Downtime:** UptimeRobot emails you (if set).
- **AI:** limited to 60 calls per person per day and 6,000 a month for the college, with
  retries and a cut-out if Groq is busy. Change the limits with `AI_PERSON_DAILY_CALLS` and
  `AI_COLLEGE_MONTHLY_CALLS`.

## 4. If something goes wrong
- The API won't start: Render → `saveetha-publications-api` → **Logs**. Database changes run at boot.
- A deploy is wrong: Render → the service → **Deploys** → previous one → **Rollback**.
- The data is wrong: Neon → restore to a point in time, or **Imports → Restore** with a backup from R2.
- Free-plan limits: the API has 0.1 CPU and 512 MB. If pages feel slow, upgrade the API to
  **Starter ($7 a month)** in Render. No code change is needed.
