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
