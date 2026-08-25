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
| `remuneration_is_estimate` | **True means the figure rests on self-reported values.** Say so on screen — never show an estimate as though it were settled |
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

`DRAFT → SUBMITTED → CLEARED → PRINCIPAL_APPROVED → PAID`, with `REJECTED`
(sent back) reachable from the middle. Legacy ERP rows also carry
`HOD_APPROVED`, `RESEARCH_APPROVED` and `FINANCE_APPROVED`.

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
POST /api/lookup/scopus     { doi?, title?, eid? }   -> the paper, from Scopus
POST /api/lookup/candidates { title }                -> possible matches to choose from
POST /api/lookup/scimago    { issn?, title?, year }  -> quartile and SJR
POST /api/lookup/enrich     { ... }                  -> everything it can find
POST /api/prior/check       { doi?, title? }         -> has this already been paid?
POST /api/calculate         { ... }                  -> what it would pay, without saving
```

`POST /api/calculate` is how the wizard shows an amount before anything is
filed. Anything it returns is an **estimate** and must be labelled as one.

### The person

```
GET   /api/auth/me                    -> the account (see below)
PATCH /api/auth/profile               -> only fields a person may change themselves
POST  /api/auth/change-password       { current_password, new_password }
POST  /api/auth/profile/correction    { field, proposed, note? }
GET   /api/auth/profile/corrections   -> { results: [...] }
```

`me` carries: `id, email, name, role, department, employee_id, staff_id,
biometric_id, designation, scopus_author_url, scopus_author_id,
must_change_password, active, portal`.

**Identity is not self-service.** A claimant cannot edit `name`, `staff_id`,
`biometric_id`, `designation`, `scopus_author_url` or `scopus_author_id` —
those decide who gets paid. They ask, via `/auth/profile/correction`, and an
admin decides. `department` is correctable too but is not an identity field.

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
GET  /api/notifications              -> { results: [...] }
GET  /api/notifications/unread-count -> { count }
POST /api/notifications/{id}/read
POST /api/notifications/read-all
```

Each row has an `href` — navigate with the router, never `window.location`.

### Reference data

```
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

`/discover/directions` returns `directions: [{ topic, why, first_step }]` and
`grounded_on: { papers, interests }`. Show `grounded_on`: a thin answer is
usually an empty history rather than a bad model, and the reader cannot tell
those apart unless you say. When there is nothing to go on at all it returns an
empty list plus `note`, without calling the model.

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

### People

```
GET   /api/admin/users?q=&role=&limit=&offset=   -> { total, limit, offset, results }
GET   /api/admin/users/{id}                      -> one account
GET   /api/faculty/{user_id}/report              -> everything one person published
GET   /api/meta/departments                      -> string[]
```

The person report carries `faculty`, `totals` (`publications`, `paid_claims`,
`paid_amount`, `in_review`), and the breakdowns `by_month`, `by_quartile`,
`by_status`, `by_year`, `by_journal`, `by_type`, `by_position`, plus `per_paper`
and `claims`. Each breakdown is `[{ key, count, amount }]` — the shape
`@/ui/chart` already takes.

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
