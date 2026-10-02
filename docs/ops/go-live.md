# Go live on the new Render account (saveetha-publications)

About 20 minutes of clicks, in this order. Nothing here needs a terminal.

## 1. Render (the account that will host the college)
1. **Old service:** open `faculty-paper-api` → **Settings** → bottom → **Suspend Web Service** (or Delete). While it runs it uses the
   workspace's 750 free hours, and the new API needs those to stay up all the time.
2. **New → Blueprint** → repository **RHUDHRESH/faculty-paper**, branch **master**.
3. Render reads `render.yaml` and lists three free resources. Check the names and the plan:
   - `saveetha-publications-db`: Postgres, Free, Singapore;
   - `saveetha-publications-api`: web service, Free;
   - `saveetha-publications`: static site, Free.
4. Before **Apply**, fill in the secrets it asks for (each can be left empty and added later under
   *Environment*):
   - **AI_API_KEY**: your **Groq** API key. Provider, address and models are already set to Groq
     (`llama-3.3-70b-versatile` for considered answers and `llama-3.1-8b-instant` for fast ones). Without a key, every AI
     panel shows its counted version instead.
   - **SCOPUS_API_KEY**, and optionally **OPENALEX_API_KEY**.
   - Email (Brevo): **EMAIL_HOST** `smtp-relay.brevo.com`, **EMAIL_PORT** `2525`, **EMAIL_USE_TLS**
     `true`, **EMAIL_HOST_USER**, **EMAIL_HOST_PASSWORD**, **DEFAULT_FROM_EMAIL**. Empty means alerts stay in the app.
   - Leave **ANTHROPIC_API_KEY** empty.
5. **Apply.** The first build takes about 10 minutes. It's done when
   `https://saveetha-publications.onrender.com/api/health` shows `"ok": true`.
   If Render adds a suffix to a name (the name was taken), tell the developer: two addresses in
   `render.yaml` must match.

## 2. The college's data
1. Open `https://saveetha-publications.onrender.com/setup` and create the first super admin. Use your own
   email and a strong password.
2. **Admin → Get the college running** (`/admin/start`) walks through the rest:
   - **Restore:** upload `D:\Faculty Paper\data\derived\restore-<date>.jsonl.gz`. The page shows
     progress; it takes about 5–10 minutes on the free server. If it stops, upload the same file again and it
     resumes.
   - **Roles:** give **Director**, **Finance**, **Research cell** and **Research coordinator** to the
     real people (People → person → Role). Until then the super admin stands in at those desks.
   - **Passwords:** everyone keeps the password in `all-accounts-LOCAL.csv`. To hand out fresh ones,
     use **People → Issue passwords** and download the list once.
   - **Imported claims:** run **Fix imported claims → preview → apply** for the 51 old-ERP claims
     that were marked paid without an amount. 7 possible repeats and 3 rejected ones stay held.
3. **Google sign-in:** Google Cloud console → Credentials → OAuth client `635082195334-…` →
   add `https://saveetha-publications.onrender.com` to *Authorised JavaScript origins*. Sign-in uses
   Google's button, which hands a token to the app, so no redirect address is needed. Then press **Publish app**
   on the consent screen.

## 3. Staying up
- The `keep-alive` GitHub workflow pings the site every 4 minutes, all day, so the free API never sleeps.
  If the site address changes, set the repository variable `SITE_URL` (Settings → Secrets and
  variables → Actions → Variables).
- **The free Postgres expires 30 days after it is created.** Before then, either upgrade it (about $6 a month)
  or move to a free Neon database (`docs/ops/move-host.md` covers export and restore).
- **Every night at 03:45**, 17 safeguard checks run. Problems show on **Admin → Safeguards** and **Faults**.

## 4. If something goes wrong
- The API won't start: Render → `saveetha-publications-api` → **Logs**. Database changes run at
  boot.
- A deploy is wrong: Render → the service → **Deploys** → pick the previous one → **Rollback**.
- The data looks wrong: **Admin → Data health → Backup** downloads a full backup at any time.
