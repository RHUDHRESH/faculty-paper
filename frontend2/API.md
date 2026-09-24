# The API, as it actually is

Written down once so that screens are built against what the server returns
rather than against what seemed likely. Everything here was read out of
`backend/core/api.py`. If something you need is not in this file, read that
file — do not invent an endpoint or a field name.

All paths are prefixed `/api`. Auth is a session cookie, same-origin, already
handled by `src/lib/api.ts`. A mutating request needs the CSRF header, which
`api.ts` also handles. **The CSRF token rotates on login**, so anything cached
across a sign-in is stale.

## Money

Only these roles ever see a rupee figure: `FACULTY` (their own), `FINANCE`,
`PRINCIPAL`, `RESEARCH_CELL`, `SUPER_ADMIN`.

**`HOD` must never see money, by any route** — not a total, not a column, not a
nested field. If you are building something an HOD can open, no amount goes on
it. This is the one rule in this file that is not a matter of taste.

Format every amount with `money()` from `@/ui/paper`. Never `toFixed`.

## The claim, which is the centre of everything

`GET /api/claims/{id}` and every list row return the same object. It is large;
these are the fields a screen normally wants.

| Field | Notes |
|---|---|
| `id`, `ticket_number` | `ticket_number` is null until it is filed |
| `paper_title`, `journal_title`, `doi`, `issn` | `doi` is often null on older imported rows |
| `publication_year`, `publication_date`, `publication_type` | |
| `status` | See the chain below |
| `status_note` | Why it was sent back, when it was |
| `owner_id`, `owner_name`, `owner_email`, `owner_department` | |
| `remuneration` | The amount. May be null before verification |
| `remuneration_is_estimate` | **Drafts only.** True when a draft's amount was computed from the claimant's own SNIP or quartile. Submitting re-verifies and recalculates from verified values, so this is always false past `DRAFT` — on an office screen the trust signals are `snip_source`, `quartile_source` and `verification_ok`, not this |
| `qf_amount`, `base_amount`, `author_point` | The formula's working |
| `remuneration_category`, `remuneration_note` | |
| `snip`, `snip_source`, `self_reported_snip` | `snip_source` is `SCOPUS` \| `SNIP_DUMP` \| `MANUAL` |
| `quartile`, `quartile_source`, `self_reported_quartile` | `quartile_source` is `SCIMAGO` \| `MANUAL` |
| `manual_verified_by_name`, `manual_verification_note` | Present when a human overrode a lookup |
| `scimago_verified`, `scimago_sjr`, `scimago_dataset_year` | |
| `author_position`, `total_authors`, `authors_json` | |
| `attachments` | `[{ id, kind, url, filename, size_bytes }]` |
| `duplicate_warning`, `duplicate_matches_json` | Set when this paper may already have been paid |
| `override_duplicate`, `override_reason`, `override_by_name` | |
| `verification_ok`, `verification_snapshot_json` | |
| `waiting_days` | How long it has sat where it is |
| `cleared_by_name`, `principal_approved_by_name`, `second_approved_by_name` | |
| `needs_second_approval` | High-value claims need a second, different signature |
| `voucher_number`, `paid_at` | |
| `created_at`, `updated_at`, `submitted_at` | ISO strings |
| `calc_error` | Non-null means the amount could not be worked out. Show it |

### The chain

`DRAFT → SUBMITTED → CLEARED → PRINCIPAL_APPROVED → DIRECTOR_APPROVED → PAID`,
with `REJECTED` (sent back) reachable from the middle. Legacy ERP rows also
carry `HOD_APPROVED`, `RESEARCH_APPROVED` and `FINANCE_APPROVED`.

Faculty file it · the admin office clears it · the Principal approves the
spend · **the Director authorises it** · Finance pays.

**`PRINCIPAL_APPROVED` is not payable.** The Director step sits between the
Principal and Finance, and `mark-paid` refuses anything that has not reached
`DIRECTOR_APPROVED` — with a message naming the Director rather than a generic
"invalid status". Each review step sends a ticket back exactly one step:
`principal-reject` returns it to `SUBMITTED` (the office) and
`director-reject` returns it to `CLEARED` (the Principal), withdrawing the
approval it is querying rather than leaving a signature on a reopened
decision.

**Do not map statuses yourself.** `stageOf(status)` in `@/ui/paper` already
does it, and already knows that a `CLEARED` ticket is waiting for the Principal
and *not* "with Finance" — a distinction the old app got wrong on 18 live
tickets.

## Endpoints these screens need

### Lists

```
GET /api/claims?status=&q=&limit=&offset=
    -> { total, limit, offset, results: Claim[] }
```

`limit` is capped at 200 server-side. `status` takes one status string. `q`
searches title and ticket number. A faculty account sees only its own claims;
the server scopes it, so do not filter by owner on the client.

### One claim

```
GET   /api/claims/{id}              -> Claim (owners also get `actions`, the history)
PATCH /api/claims/{id}              -> Claim          (draft edits)
POST  /api/claims                   -> Claim          ({...fields, submit: boolean})
POST  /api/claims/{id}/withdraw     -> Claim          (owner, SUBMITTED -> DRAFT, keeps the ticket number)
GET   /api/claims/{id}/notes        -> { results: Note[] }
POST  /api/claims/{id}/notes        -> Note
POST  /api/claims/notes/{id}/resolve
POST  /api/claims/upload            -> attachment     (multipart)
```

### Journal and paper lookup, for the filing wizard

```
POST /api/lookup/paper      { query, owner_id?, claim_id? } -> the paper from a DOI, link or title
GET  /api/lookup/sources                             -> { scopus: bool } is Scopus connected here
POST /api/lookup/file-check { url, kind, title?, doi?, journal?, issn?, ref_title? }
                                                     -> what an attached PDF shows
POST /api/lookup/scopus     { doi?, title?, eid? }   -> the paper, from Scopus
POST /api/lookup/candidates { title }                -> possible matches to choose from
POST /api/lookup/scimago    { issn?, title?, year }  -> quartile and SJR
POST /api/lookup/enrich     { ... }                  -> everything it can find
POST /api/prior/check       { doi?, title? }         -> has this already been paid?
POST /api/calculate         { ... }                  -> what it would pay, without saving
```

`POST /api/calculate` is how the wizard shows an amount before anything is
filed. Anything it returns is an **estimate** and must be labelled as one.

`POST /api/lookup/paper` is the wizard's "Paste the DOI or link" box, and it
needs no Scopus key: OpenAlex answers a DOI (free and keyless), Crossref is the
fallback and the title search, and Scopus is asked only when `SCOPUS_API_KEY`
is set. It never answers 5xx — `ok: false` with a `code` (`not_found`,
`choose`, `bad_input`, `scopus_link`, `unreachable`, `error`) and a sentence in
`message`. On success it carries `paper` (title, journal, `issns`, date and its
precision, type, authors in order with printed affiliations, citations,
open-access link), `claimant` (their position and how sure: `exact`, `likely`,
`ambiguous`, `none`), `affiliation` (is the college printed, and beside the
claimant), `metrics` (quartile, SNIP, subject areas and Engineering class from
our own SCImago and SNIP tables), `field_sources` (which source each value came
from), `sources[]` (every source, answered or not), `to_check[]` (sentences for
what the claimant still has to look at) and `already_filed`. Nothing in it is
money.

`POST /api/lookup/file-check` reads one file just uploaded to the form and says
whether it shows the paper's title, DOI and the college. It is the claimant
checking their own upload before filing; the desks' own checks after filing
(`file_checks`, flags) are separate and stay theirs.

### The person

```
GET   /api/auth/me                    -> the account (see below)
PATCH /api/auth/profile/self          { phone }   -> the account; the only self-service write
PATCH /api/auth/profile               -> 403 for everyone but a super admin
POST  /api/auth/change-password       { current_password, new_password }
POST  /api/auth/profile/correction    { field, proposed, note? }
GET   /api/auth/profile/corrections   -> { results: [...] }
```

`me` carries: `id, email, name, role, department, employee_id, staff_id,
biometric_id, designation, scopus_author_url, scopus_author_id,
must_change_password, active, faculty_type, research_quota,
research_quota_note, phone, portal, google`. `google` is `{ email, linked_at }`
or `null` — only on `/auth/me`, never on anybody else's record.

**Self-service is an allow-list of one.** `PATCH /auth/profile/self` accepts
`phone` and nothing else: any other key is a 422, not silently dropped. The
number is lightly checked (digits with spaces, dashes, brackets or a leading
`+`; 7–15 digits) and an empty string clears it. The audit row names the field,
not the number. Research interests (`/api/me/interests`) are the other thing a
person sets for themselves.

**Everything else is a request.** A claimant cannot edit `name`, `staff_id`,
`biometric_id`, `designation`, `scopus_author_url` or `scopus_author_id` —
those decide who gets paid. They ask, via `/auth/profile/correction`, and an
admin decides. `department` is correctable too but is not an identity field.
`role`, `faculty_type` (`REGULAR`|`RESEARCH`) and `research_quota` (a whole
number) can be asked for the same way; they are checked when asked, go to a
super admin only, and approving one runs the account editor's checks — one
head per department (409, nobody is replaced from the queue), no approving
your own role, a quota only on a research post, and a regular post drops its
quota.

The correction endpoint refuses a proposal identical to the current value, and
**re-asking for the same field updates the open request rather than queueing a
second one** — so the screen should show one pending request per field, not a
list of duplicates.

A correction row carries `id, field, label, current_value, proposed_value,
value_now, note, identity, status (PENDING|APPROVED|DECLINED), decision_note,
created_at, decided_at, decided_by` — note `decided_by`, not `decided_by_name`
as an earlier draft of this file claimed. `value_now` is what the record says
*today*, which can differ from `current_value` if it moved while the request
sat in the queue.

### Who has worked with whom

```
GET /api/collaborate/me?limit=      -> { me, papers, worked_with[], suggestions[], derived_from }
GET /api/collaborate/graph?department=&limit=
                                    -> { nodes[], links[], department, hidden }
```

`worked_with[]`: `{ id, name, department, designation, together, papers }` —
`together` is how many papers you share.

`suggestions[]`: `{ id, name, department, designation, papers, shared_journals[],
shared_count, cross_department, why, score }` — `why` is a ready-made sentence,
use it rather than composing your own.

`nodes[]`: `{ id, name, department, designation, papers, degree }`.
`links[]`: `{ source, target, papers }` — each pair appears **once**.
`hidden` is how many connected people were left out of the cap. **Say that
number on screen.** Silently truncating reads as "this is everyone".

Neither endpoint carries money, deliberately, so an HOD can open both. Keep it
that way.

`derived_from` explains that co-authorship is inferred from two people filing
for the same paper. Show it. A relationship the system asserts about two real
people has to be accountable.

### Notifications

```
GET  /api/notifications              -> Notification[]   (a bare array)
GET  /api/notifications/unread-count -> { unread }
POST /api/notifications/{id}/read
POST /api/notifications/read-all
```

**Both shapes above were wrong in this file until somebody built against
them.** The list is a bare array, not an envelope, and the count's key is
`unread`, not `count`. Read `api.py`.

Each row has an `href`, and two things about following it:

- Navigate with the **router**, never `window.location`. A full page load
  throws away the session context the app has already fetched and flashes the
  sign-in screen on a slow connection.
- **Translate the path first.** The server writes hrefs against whichever app
  was current when the notification was written — `/finance`, not `/payments`
  — so following one literally lands on the catch-all. `app/notifications.tsx`
  keeps the map, the same way `audit.tsx` does for faults.

### Research faculty and the quota

An account is **regular or research** (`faculty_type`), set by an admin — not
inferred from the designation text, which nine accounts spell four ways.

A research account may carry a **`research_quota`**: how many papers a year the
post already expects. **Papers up to the quota pay ₹0 and only the surplus is
reimbursed**, because a research post is already paid to do research.

The zero is applied *after* the ordinary calculation, so `base_amount`, `qf`
and the author point stay on the ticket — it shows what the paper was worth
and why it came to nothing, rather than looking unpriceable.

`quota_position` is **handed out once and stored**. Deriving it was tried and
does not work: `created_at` comes from a clock coarser than the loop that
writes the rows, so several claims share a timestamp to the microsecond, and
the id is a random uuid, so breaking that tie on the id orders papers
arbitrarily. Four of five papers landed inside a quota of two before this was
a stored number. A draft gets a provisional position and keeps none.

A `COUNT_ONLY` paper never spends the quota — it asks for no money, so it
cannot use up the allowance for money.

### Student project teams

```
GET  /api/teams/{code}     -> the team, or 404 (an ordinary answer, not a failure)
GET  /api/teams?q=&limit=
POST /api/teams            { code, title?, department?, academic_year?,
                             mentor_id?, mentor_name?, members: [...] }
```

`ClaimReason` now has a third value beside `INCENTIVE` and `COUNT_ONLY`:
**`STUDENT_PROJECT`**. Filing one looks the team up by code, then confirms or
corrects it.

`POST /api/teams` is one endpoint for create *and* confirm, because that is
what the form does — the code is typed, the team comes up, and what comes back
is either agreed with or edited. The member list that is sent **is** the list,
so removing somebody removes them.

Each student carries their own `mentor_name`, falling back to the team's. The
creating faculty member is only assumed to be the mentor when nobody said
otherwise.

Students are **not accounts**: a name and a register number. They do not sign
in and are not paid — `student_remuneration_zero` has always paid a student
author nothing, and creating a login for every project student would put
thousands of payable identities behind a form.

### Sign in with Google

```
GET  /api/auth/google/config   -> { enabled, client_id, hosted_domain }
POST /api/auth/google          { credential }   -> the session, as /auth/me
```

The browser gets an ID token from Google Identity Services and the server
verifies it against Google's public keys with our client id as the audience.
**Only a client id is needed, and it is not a secret** — no client secret, no
code exchange, nothing to keep. Set `GOOGLE_OAUTH_CLIENT_ID`; unset means the
feature is off and `config` says so, rather than drawing a button that fails.

**No account is ever created.** An address Google recognises and this college
does not is refused by name. Accounts carry staff ids and a Scopus link and
decide who gets paid; a free signup form must not be able to mint one.
`GOOGLE_HOSTED_DOMAIN` optionally refuses anything outside one Workspace
domain.

A token that fails to verify answers 401 **without saying why** — expired,
wrong audience and bad signature are useful to an attacker and useless to the
person at the screen.

```
POST   /api/auth/google/link   { credential }   -> { google: { email, linked_at } }
DELETE /api/auth/google/link                    -> { google: null }
```

Linking is done from a signed-in session and **does not require the hosted
domain**: the session was opened with the account's own password, so choosing
a personal Gmail is the owner's decision. The Google account is stored by its
`sub`, not its email. `email_verified` is still required. 409 when that Google
account already opens another account here, or its address is another
account's email — without saying whose. Both are audited (`GOOGLE_LINKED`,
`GOOGLE_UNLINKED`).

Sign-in looks up the `sub` first: a linked account signs in whatever its
domain. Anything not linked falls back to the email match, which keeps the
`GOOGLE_HOSTED_DOMAIN` rule. The client must therefore not pass Google's `hd`
option — it would hide a linked personal Gmail from the account chooser.

### Reference data

```
GET /api/meta/filing-rules     -> the eligibility rules the filing form enforces
GET /api/meta/departments      -> departments, for a Combobox
GET /api/lookup/ticket?q=      -> { tickets[], faculty[] }   (what Ctrl-K uses)
```

## Errors

`api.ts` throws on non-2xx with the server's message. Meaningful codes:

- **401** — session gone. Handled globally; do not catch it per screen.
- **403** — not allowed. Say so plainly; do not retry.
- **409** — the amount moved under you between reading and acting. The body
  carries the recomputed figure. Show both and make the reader confirm again.
- **502** — Scopus is down. Offer a retry; do not present it as the user's fault.

Never render a failed request as an empty state. `ErrorState` and `EmptyState`
in `@/ui/state` are different components because "could not load" and "nothing
here" are different sentences.

---

## Added since the first four screens

### Counting claims by stage

```
GET /api/claims/counts?q=
    -> { counts: { all, draft, filed, checked, approved, paid, sent_back },
         statuses: { RAW_STATUS: n },
         stages:   { stage: [RAW_STATUS, ...] } }
```

One query for every filter chip. It groups the legacy ERP statuses under their
stage — `filed` covers `SUBMITTED` *and* `HOD_APPROVED`, `checked` covers
`CLEARED` *and* `RESEARCH_APPROVED` — which the list endpoint cannot, since
`status` there takes a single value. `q` narrows the counts the same way it
narrows the list, so the chips never promise rows the list will not show.

### Discovery — the two AI features

```
GET  /api/discover/status        -> { available: boolean, model: string }
GET  /api/meta/research-domains?q=&limit=
                                 -> { domains: string[] }
GET  /api/me/interests           -> { domains: string[] }
PUT  /api/me/interests           { domains: string[] }   -> { domains }
GET  /api/discover/directions    -> { directions[], grounded_on, note? }
POST /api/discover/venues        { title, abstract?, keywords?,
                                   author_position?, total_authors? }
```

**Ask `/discover/status` before offering any of it.** With no API key
configured, `/venues` and `/directions` return **503** with a readable message.
That is a supported state, not an error to apologise for — the screen should
say the feature is switched off, not show a button that always fails.

`/discover/venues` returns:

```
{
  journals: [{ title, issn, quartile, subject, sjr, snip, dataset_year, why,
               payout: { amount, base, qf, author_point, category, note, why_not } }],
  unverified: [{ title, why }],
  assumed: { author_position, total_authors, publication_type }
}
```

The split is the whole point. **`journals` are names we resolved against our own
Scimago and SNIP rows**, so their quartile and amount are real. **`unverified`
are names the model produced that we could not identify**, and they carry no
quartile and no amount — never invent one for them, never sort them in among
the verified ones, and never let a reader mistake the two. A plausible journal
name with a confident payout beside it is how somebody submits to a venue that
does not exist.

`payout.amount` is null when we hold no SNIP or no quartile; `payout.why_not`
says which. Show that sentence rather than a blank or a zero.

Everything under `payout` is an **estimate**, computed for the author position
in `assumed`. Say so, and say what was assumed — an estimate whose assumptions
are invisible is a number somebody will treat as a promise.

```
POST /api/discover/reprice  { issns: string[], author_position?, total_authors? }
                            -> { journals[], assumed }
```

**Use this, not `/venues`, when only the author position changed.** It reprices
journals `/venues` already resolved, using the ISSNs it returned. No model
call, so it is instant and free — asking the model the same question again for
an answer that cannot have changed costs seconds and a paid call per keystroke.
It works with no key configured at all. An ISSN we do not hold is dropped
rather than priced: the client is not the authority on which journal an ISSN
is.

`/discover/directions` returns `directions: [{ topic, why, first_step }]` and
`grounded_on: { papers, interests }`. Show `grounded_on`: a thin answer is
usually an empty history rather than a bad model, and the reader cannot tell
those apart unless you say. When there is nothing to go on at all it returns an
empty list plus `note`, without calling the model.

`meta/filing-rules` returns `max_authors`, `min_sec_references`, the
attachment limits and a `why` sentence for each, read from the **active
policy** rather than hard-coded. Any signed-in account may read it —
deliberately wider than `/admin/formula`, which 403s a claimant.

The distinction matters: a claimant may not read the *rates*, but must be able
to read the rules that decide whether their own paper is eligible at all. Both
of them silently pay **zero** — more than `max_authors` authors, or fewer than
`min_sec_references` cited SEC-affiliated references — and before this the only
place either was stated was a note attached to the resulting ₹0.

**Do not hard-code these numbers in a client.** A hard-coded 2 stops matching
the policy the money is calculated from the day somebody publishes a new one.

`research-domains` is the 302 subject categories our own journals are
classified under. Interests must be chosen from it — free text cannot be
matched against anything later.

### The clearing queue — the research cell's daily job

```
GET  /api/admin/clearing-queue?status=      -> Claim[]   (a bare array, not an envelope)
POST /api/admin/bulk-clear   { claim_ids: string[], note? }
                                            -> { cleared: number, skipped: [...] }
POST /api/claims/{id}/clear  { note?, expected_amount? }
POST /api/claims/{id}/reject { note }        (sending it back needs a reason)
POST /api/claims/{id}/recalculate            -> { remuneration, changed, previous... }
POST /api/admin/claims/{id}/set-verified
     { snip?, quartile?, engineering_class?, note }   (note ≥ 10 chars)
```

Notes that matter:

- **It returns a plain array**, capped at 200, oldest first. Oldest first is
  deliberate: the ticket that has waited longest is the one to clear next.
- `status` defaults to `SUBMITTED`; pass `ALL` for everything.
- **`expected_amount` is the amount the actor saw when they confirmed.** If the
  recomputed figure differs, the server answers **409** with the new amount and
  clears nothing. Show both figures and make the reader confirm again. Money
  moving because a number changed between reading and clicking is the failure
  this guards.
- `bulk-clear` recalculates per row and returns `skipped` with a reason per
  row. **Report those individually** — "cleared 12 of 15" with no word on the
  other three is how three tickets get forgotten.
- `set-verified` is the manual lane for when Scopus cannot confirm a journal.
  It demands a note because somebody typed a number that decides a payment.

### People — and who may change what

```
GET    /api/admin/users?q=&role=&department=&active=&limit=&offset=
                                                 -> { total, limit, offset, results }
GET    /api/admin/users/{id}                     -> one account, plus its claim stats
POST   /api/admin/users                          { email, name, password, role, ... }
PATCH  /api/admin/users/{id}                     { role?, department?, active?, ...identity }
POST   /api/admin/users/{id}/reset-password      { password }
PATCH  /api/auth/profile                         -> 403 for everyone but a super admin
```

**Nothing on a profile is self-service.** A claimant cannot write a single
field of their own; `PATCH /api/auth/profile` refuses everybody but a super
admin and tells them to raise a correction request instead.

Above that, the writable fields split in two, and the split is enforced field
by field on the server:

| Tier | Fields | Who |
|---|---|---|
| **Routing** | `role`, `department`, `active` | `can_manage_users` — the research cell and a super admin |
| **Identity** | `name`, `designation`, `staff_id`, `biometric_id`, `scopus_author_url`, `scopus_author_id` | **super admin only** |

The reason identity is narrower is not seniority. The research cell processes
the claims these fields decide the outcome of, so it cannot also set them: a
Scopus link pointed at the wrong profile attributes a paper to another author,
and the staff ID is what the payment is made against. A research-cell account
sending any identity field gets a 403 naming the fields — even if the value is
unchanged, so a client must send only what actually moved.

Two more guards: an admin cannot change their own role or deactivate their own
account (that is how a system ends up with nobody able to manage users), and
every change is written to the audit log with its before and after.

`ASSIGNABLE_ROLES` is the set a role may be set to. It includes `DIRECTOR` —
without it the chain has a step nobody can be appointed to — and `HOD`, which
is a real post again now that a head has their own department screen.
GET   /api/faculty/{user_id}/report              -> everything one person published
GET   /api/meta/departments                      -> string[]
```

The person report carries `faculty`, `totals` (`publications`, `paid_claims`,
`paid_amount`, `in_review`), and the breakdowns `by_month`, `by_quartile`,
`by_status`, `by_year`, `by_journal`, `by_type`, `by_position`, plus `claims`.
Each of those breakdowns is `[{ key, count, amount }]` — the shape
`@/ui/chart` already takes.

`per_paper` is **not** one of them, whatever an earlier draft of this file
implied. It is a single stats object, `{ count, mean, median, min, max }`,
describing what one paid paper is worth. Every field in it is money, so there
is nothing in it to show a money-blind role.

### Filing a paper

```
POST /api/claims              { ...fields, submit: boolean }   -> Claim
PATCH /api/claims/{id}        { ...fields }                    -> Claim
POST /api/claims/upload       (multipart)                      -> attachment
POST /api/lookup/scopus       { doi?, title?, eid? }
POST /api/lookup/candidates   { title }
POST /api/lookup/scimago      { issn?, title?, year }
POST /api/lookup/enrich       { ... }
POST /api/prior/check         { doi?, title? }
POST /api/calculate           { snip, quartile, total_authors, author_position, ... }
                              -> { base, point, remuneration, qf, error, note }
```

`submit: false` saves a draft; `true` files it. A draft and a **sent-back**
claim can both be PATCHed — the server allows both, and a rejected paper with
no way to edit it is the hole the old app left people in.

`/prior/check` before submitting is what stops the same paper being paid twice.
Warn plainly; do not block silently.

---

## Endpoints for the remaining screens

Shapes not spelled out here are in `backend/core/api.py`. Read it. Every wave
so far has found at least one place where this file was wrong, so treat it as a
map, not as the territory.

### Principal — approvals

```
GET  /api/principal/queue                  -> tickets awaiting the Principal
POST /api/principal/bulk-approve           { claim_ids: string[], note? }
POST /api/claims/{id}/principal-approve     { note?, expected_amount? }
POST /api/claims/{id}/principal-reject      { note }
```

A `CLEARED` ticket is waiting here. `needs_second_approval` means the amount is
over the policy's high-value threshold and needs a second, *different*
signature — the actor may not be whoever cleared it (`cleared_by_name`).

**`/claims/{id}/second-approve` is not a Principal action**, whatever an
earlier draft of this file said. It is restricted to SUPER_ADMIN and
RESEARCH_CELL; a Principal calling it gets 403. Show
`needs_second_approval` on this screen as information, not as a button.

**A super admin may act as the Principal.** `_may_approve_as_principal` allows
both, deliberately — somebody has to keep payments moving while a post is
vacant. The same is true of Finance via `rbac.can_approve_as_finance`. `can()`
in `app/auth.tsx` mirrors both.

**`principal-reject` does not go to the claimant.** It returns the ticket to
`SUBMITTED` — back to the research cell — and writes the reason to
`status_note`. Both the clearing queue and the paper page now show that note;
they did not, so a required explanation went nowhere.

### The Director — authorising

```
GET  /api/director/queue                    -> tickets awaiting the Director
POST /api/director/bulk-approve             { claim_ids: string[], note? }
POST /api/claims/{id}/director-approve      { note?, expected_amount? }
POST /api/claims/{id}/director-reject       { note }   (>= 5 chars)
```

Shaped exactly like the Principal's queue — same sort, same whole-filter
totals, same 409 amount guard — because the two roles do the same kind of work
one step apart, and a queue that totalled differently would have them quoting
different figures for the same claims.

`rbac.can_approve_as_director` is **DIRECTOR and SUPER_ADMIN**, the same
stand-in arrangement the Principal and Finance have.

**The second-signature rule still applies at this step.** A high-value claim
authorised by the Director is still refused by Finance until a second,
different signature exists — the Director's own authorisation supplies it only
where they are not the person who cleared it.

### Reporting — build one

```
GET /api/reports/areas?year=&department=&limit=
    -> { areas[], distinct, shown, coverage, years }
GET /api/reports/build?dimensions=&year=&department=&month=&fmt=&limit=
    -> { tables[], subtitle, available[], years }   (JSON without fmt, a file with)
```

`build` is one endpoint behind both the preview and the download — ask without
`fmt` for the screen, with one for the workbook — so the file cannot disagree
with what was on screen.

`dimensions` is a comma-separated list of: `year department quartile journal
type indexing designation status engineering category person area`.

**Two of them overlap** — `area` and `indexing`, where one paper belongs to
several rows at once. Those come back with `overlapping: true` and
`totals.amount: null`, deliberately: a paper spanning four subject areas has
its full amount counted under each, which turned ₹2.8 crore of real payouts
into a ₹12.6 crore "total". Per-row amounts are real; the column total is not,
and is withheld rather than printed with a caveat nobody reads.

`areas` carries `coverage`, and it must be shown. Subject areas are known only
for a paper whose journal matched our Scimago rows — about half the record —
so a chart without its denominator reads as "this is what we do" when it means
"this is what we do, among the half we can classify".

### Faculty — the research programme

```
GET /api/programme/me?limit=   -> { areas, interests, search_terms,
                                    colleagues, live, totals, classified }
```

Derived entirely from the college's own records and **needs no API key**:
areas come from the subject areas of papers somebody actually filed,
colleagues from who else publishes in them, `live` from what those colleagues
filed most recently. Pair it with `/api/research/search` (OpenAlex, Crossref,
arXiv — also keyless) for the field outside.

**It carries no money at all**, and that is enforced in the endpoint rather
than by the screen: the page is about other people, so any amount in it would
be a colleague's payout leaking through the back door.

### Finance — paying

```
GET  /api/admin/payouts?status=&limit=&offset=
POST /api/claims/{id}/mark-paid       { voucher_number?, expected_amount }
POST /api/admin/bulk-mark-paid        { items: [{ claim_id, voucher_number?, expected_amount }] }
POST /api/claims/{id}/void-payment    { note }        (note ≥ 10 chars)
GET  /api/admin/ledger  ·  GET /api/admin/ledger/export
GET  /api/budgets  ·  POST /api/budgets  ·  DELETE /api/budgets/{id}
```

**`expected_amount` is mandatory in spirit on every one of these.** A mismatch
answers 409 with the recomputed figure and moves no money. Show both figures
and make the reader confirm again.

`mark-paid` recalculates from **stored verified values only** — it never calls
Scopus, so Finance is never blocked by an outage. Paying a claim that needs a
second approval is refused.

`void-payment` writes a *reversing* ledger row rather than deleting anything,
and returns the claim to `CLEARED`. Nothing in this system deletes a payment.

### Oversight — querying and reporting

```
GET /api/reports/search?…&limit=&offset=   -> { total, limit, offset, results }
GET /api/reports/search/export
GET /api/reports        ·  GET /api/reports/export
GET /api/reports/pack   ·  GET /api/reports/pack/rows
PATCH /api/reports/pack/rows/{claim_id}
GET /api/journals/top   ·  GET /api/journals/report
GET /api/dashboard
```

**A head of department is refused `/api/reports` and `/api/reports/search`
outright — 403.** They have `/api/hod/overview` and `/api/hod/publications`,
scoped to their department and carrying no money. Any screen offered to an HOD
must branch on the role and call those instead. This is verified by test, not
assumed.

### Head of department — steering, not just watching

```
GET    /api/hod/overview                 -> department output, people, no money
GET    /api/hod/publications             -> their department's papers
GET    /api/hod/standing?year=           -> where they sit against the college
GET    /api/hod/targets?year=            -> targets + live progress
POST   /api/hod/targets                  { year, metric, target, person_id?, note? }
DELETE /api/hod/targets/{id}
GET    /api/hod/opportunities?year=      -> where the lift is, with the names
```

`metric` is `PUBLICATIONS`, `Q1` or `FIRST_AUTHOR`. **There is no money
metric**, deliberately — a head is money-blind everywhere else and a rupee
target would be the one place it came back.

`person_id` null sets the target on the department as a whole. A head may only
set one on somebody **in their own department**; the server answers 403 with
the person's name otherwise, rather than the screen merely hiding the option.

Progress is recomputed on every read, never stored — a stored figure is wrong
from the moment somebody files a paper.

`standing` returns the department's counts and rates beside the college's,
plus `position` and `of` ("3rd of 22") and `share`. **It never names another
department.** A head sees where they sit and what the college typically does;
a ranked table of colleagues' departments is a different document with
different politics.

`opportunities` returns groups (`silent`, `no_q1`, `never_led`) each carrying
the actual people, the papers missing an ISSN or DOI, and the Q3/Q4 journals
the department already publishes in. Each item is something a head can act on
this term rather than a statistic.

### The office

```
GET  /api/admin/profile-requests?status=      -> { results, pending }
POST /api/admin/profile-requests/{id}         { approve: bool, note? }
GET  /api/admin/faults
GET  /api/admin/duplicate-findings
POST /api/admin/duplicate-findings/{id}
GET  /api/admin/audit?…
GET  /api/admin/data/tables  ·  GET /api/admin/data/{table}
PATCH  /api/admin/data/{table}/{row_id}
DELETE /api/admin/data/{table}/row/{row_id}
GET  /api/admin/wipe/preview  ·  POST /api/admin/wipe
GET  /api/admin/formula   ·  GET /api/monthly  ·  POST /api/monthly
GET  /api/admin/scimago/stats  ·  GET /api/admin/snip/stats
```

Two things about the destructive ones. `DELETE` lives at
`/row/{row_id}` — **not** `/{row_id}` — because the shorter path was swallowed
by `/admin/data/{table}/export` and answered 405. And both delete and wipe
refuse anything carrying a payment; the screen should say so before the reader
tries, not after.

The audit log is append-only. There is no edit and no delete, by design, and
the screen should not imply otherwise.

### Research search — no key, no model, no credits

```
GET /api/research/search?q=&limit=&sources=&author_position=&total_authors=
    -> { results[], asked[], failed[], query, assumed }
```

A metasearch over OpenAlex, Crossref and arXiv, merged and deduped by DOI then
normalised title. Free, keyless, and it works whether or not Gemini does.

Each result: `{ title, doi, year, journal, issn, citations, open_access, type,
authors[], url, sources[], journal_known }`. When `journal_known` is true it
also carries `quartile`, `snip`, `sjr` and `payout` — priced by our own formula
for the author position asked about.

`sources[]` names which upstreams returned that work; two sources agreeing is
worth showing. **`failed[]` names upstreams that did not answer** — say so, or
a thin result set reads as a thin field rather than as arXiv timing out.
