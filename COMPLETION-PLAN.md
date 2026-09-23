# Completion plan — frontend2 to production

Written 2026-09-23 from a full audit of the repo plus 30 answered decisions.
Frontend 1 stays live until every box here is ticked; then cut over.

## What the audit found

| Area | Finding | Evidence |
|---|---|---|
| Production | Cloud Run API answers **503**; the live app (frontend 1) is down | `curl …run.app/api/health` |
| Backend tests | 1012 tests: **1 fail, 68 errors** | `manage.py test core --parallel 4` |
| └ cause | 67 tests patch `core.api.<fn>`; after the api.py → package split those names are not re-exported and patching the package never intercepts calls made inside submodules | `core/tests.py:230` etc. |
| └ cause | `test_harness_provider` fake `responder()` lacks the `timeout` kwarg the client now sends | `core/services/harness.py:172` |
| Money bug | `POST /admin/claims/{id}/edit` accepts **any** column: can set `status=PAID` with no Director authorisation and no ledger row; writes raw JSON into date/FK fields | `core/api/superadmin.py:54-71` |
| Frontend2 gates | tsc, oxlint, route/token audits, 108/108 unit tests, build — all pass | `npm run check && npm test && npm run build` |
| Frontend2 bugs | Director approve doesn't invalidate Finance's `payouts`; void doesn't invalidate clearing/principal queues; `money()` float/paise bug; 409 amount parsed out of message text by regex | `authorisations.tsx:479,677`, `payments.tsx:913`, `ui/paper.tsx:207`, `approvals.tsx:1354` |
| Frontend2 shipping | `/gallery` dev page reachable signed-out in prod; no route code-splitting (1.34 MB main chunk) | `main.tsx:31,116,170` |
| Simplicity | `file-paper.tsx` 4,995 lines; approvals/authorisations/clearing/payments each re-implement the 409 dialog, selection, formatters; backend 4× duplicated second-signature + bulk-guard blocks; dead endpoints | reviewers' reports |
| Parity | F1 features missing in F2: impersonation, SCImago online sync, faculty record export, ticket dialog overlay, dark mode | parity audit |
| Stale docs | `PLAN.md` still marks built items ⬜ (4.4, 4.5, 5.4, 8.3); `go-live.sh` type-checks `frontend/`; `.vercelignore` names `frontend/`; `deploy/.env.product.example` is gitignored so it doesn't exist | |

## Decisions (from the 30 questions)

- **Host:** keep Vercel (SPA) + Cloud Run (API) + Postgres + GCS. GCP credentials later; **run locally now** (dev servers to build, docker compose to verify).
- **Frontend 1:** stays live until frontend2 is done.
- **Look:** clean modern SaaS, **light + dark toggle**, **Saveetha branding** (logo to be supplied), desktop and phone equally.
- **Sign-in:** password + Google.
- **AI:** off for launch.
- **Keep:** Discussions, Collaborate, Discover/My research, Calendar.
- **Bring back from F1:** impersonation, SCImago sync, faculty record export, **ticket as a dialog overlay**.
- **Filing:** keep the **five-step wizard with every feature**; fix and polish, don't simplify.
- **Chain:** Faculty → Research supervisor (the research office desk) → Principal → Director → Finance.
  - Filing runs the duplicate/discrepancy check; faculty see "already claimed by …", may contest and forward — claim is flagged.
  - **Research supervisor, Principal, Super admin:** return one step · return to faculty · reject · **put on hold** (new state).
  - **Director, Finance: forward only.** Director batch-approves from a summary and can drill in. Finance only pays.
  - **Contested flag hidden from Director and Finance**; visible to everyone else.
  - **Void payment: super admin only.**
  - **Super admin sees every step** of every ticket.
- **Faculty tracker:** vague stages + days waiting — never names the desk or person.
- **Principal claim view:** faculty's past claims, journal history, department trend, red-flag summary.
- **Director summary:** budget impact, research output, accreditation effect, risk items.
- **HOD:** not an approver, money-blind. Department privileges: targets, **assign work** (research areas, paper targets with deadlines, co-author pairing, tasks), staff performance, track department tickets, department research vision.
- **Admin edit:** allow-list correctable fields only.
- **Data:** real ERP workbook (to be supplied), seed until then.

## Work list

### Phase 0 — make it trustworthy
- [ ] Fix the 67 mis-aimed test patches (patch where the name is looked up) and the harness fake; suite green
- [ ] Allow-list `admin_edit_claim`; refuse status/money/approval columns; validate types
- [ ] Fix `money()` paise/float bug; use a structured amount from 409 responses (backend adds `current_amount`)
- [ ] Fix query invalidation (authorise → payouts; void → clearing/principal queues)
- [ ] Remove `/gallery` from production builds; lazy-load routes
- [ ] Fix stale docs/scripts (`go-live.sh`, `.vercelignore`, `PLAN.md`, commit the env example)

### Phase 1 — the chain as decided (backend first, tests with each)
- [ ] `ON_HOLD` state + hold/resume endpoints (supervisor, Principal, super admin)
- [ ] "Return one step" and "return to faculty" for supervisor + Principal + super admin
- [ ] Director forward-only: remove send-back; batch approve from summary
- [ ] Void → super admin only
- [ ] Contest flag stripped from Director/Finance responses (server-side, like HOD money-blindness)
- [ ] Faculty-facing status: vague stage + days waiting; desk/actor names stripped server-side
- [ ] Super-admin full ticket timeline

### Phase 2 — role screens
- [ ] Principal: ledger list → claim detail with past claims, journal history, dept trend, red flags
- [ ] Director: summary (budget impact, output, accreditation, risk) + batch approve + drill-in
- [ ] Finance: pay-only screen
- [ ] Faculty tracker
- [ ] HOD: assign work (research areas, targets with deadlines, co-author pairing, tasks), department vision, dept ticket tracker

### Phase 3 — parity and look
- [ ] Impersonation + banner; SCImago online sync; faculty record export; ticket dialog overlay
- [ ] Dark mode; Saveetha branding; visual pass on every screen at 1440px and 375px
- [ ] Google sign-in wired (needs OAuth client id)

### Phase 4 — simplicity
- [ ] Split `file-paper.tsx` (autosave hook, steps, lookup, duplicate check) — behaviour unchanged
- [ ] Shared `useAmountGuardedMutation`, `useRowSelection`, `lib/format.ts` across the four desk pages
- [ ] Backend: one `_maybe_second_sign`, one bulk drift guard; remove dead endpoints

### Phase 5 — go live
- [ ] Import real workbook locally; verify counts
- [ ] Docker-compose full run + e2e suite for all roles
- [ ] With GCP access: diagnose the 503, redeploy API, point Vercel root at `frontend2/`, smoke per `docs/SMOKE.md`

## Needed from you
1. The ERP workbook (`Publication_Processing_ERP_V3.0.xlsx`) → put it in `D:\Faculty Paper\`
2. Saveetha logo (SVG/PNG) and colours
3. Google OAuth client id (for Google sign-in)
4. Later: `gcloud auth login` on this machine, and Vercel CLI login
