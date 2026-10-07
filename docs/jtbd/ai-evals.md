# AI evals

Every AI feature is tested the same way: golden inputs, a model that misses
the shape, and the attacks in promptfoo's red-team catalogue (prompt
injection, indirect injection through documents, prompt extraction, hidden
Unicode, personal data, object and function level access, role leaks, claims
of acting, invented ids and links, markup in answers, oversized inputs).

Run them: `python manage.py ai_eval` (offline, a stand-in model, nothing is
sent anywhere) or `python manage.py ai_eval --live` (the configured provider).
Offline is part of the test suite (`core/test_ai_harness.py`). How to add cases
for a new feature: `docs/ops/ai-harness.md`.

Other features keep their own sections below the harness's.

<!-- ai-harness:start -->

## Harness evals (`core/ai_evals`)

Last run: 2026-10-07, offline, with a stand-in model. Pass rate **296/296 (100.0%)**.

| Category | What it tries | Passed |
|---|---|---|
| golden | Ordinary inputs; the answer is usable and in the right shape. | 27/27 (100.0%) |
| shape | A model that gets the shape wrong: re-asked, or failed cleanly. | 17/17 (100.0%) |
| prompt-injection | Instructions typed into a field the model reads. | 21/21 (100.0%) |
| indirect-prompt-injection | Instructions inside a document, abstract, thread or record. | 125/125 (100.0%) |
| prompt-extraction | Asking for, or leaking, the system prompt and the fence token. | 2/2 (100.0%) |
| ascii-smuggling | Invisible Unicode carrying text the reader cannot see. | 17/17 (100.0%) |
| pii | Contact details and identifiers coming out of the model. | 7/7 (100.0%) |
| bola | Another person's data (object level). | 2/2 (100.0%) |
| bfla | A function the reader's role may not use (function level). | 5/5 (100.0%) |
| rbac | What each role may be told: desks, flags, money. | 15/15 (100.0%) |
| excessive-agency | The model claiming or attempting an action. | 14/14 (100.0%) |
| hallucination | Invented ids, names, links and counts. | 17/17 (100.0%) |
| output-injection | Markup, links and images in the answer. | 8/8 (100.0%) |
| oversized | Inputs far beyond the budget. | 19/19 (100.0%) |

| Feature | Passed |
|---|---|
| `batch.check` | 22/22 (100.0%) |
| `compass.ask` | 24/24 (100.0%) |
| `compass.paths` | 13/13 (100.0%) |
| `compass.plan` | 14/14 (100.0%) |
| `compass.portrait` | 14/14 (100.0%) |
| `discover.directions` | 13/13 (100.0%) |
| `discover.venues` | 28/28 (100.0%) |
| `insights.ask` | 21/21 (100.0%) |
| `research.draft` | 15/15 (100.0%) |
| `research.rank` | 23/23 (100.0%) |
| `review.precheck` | 18/18 (100.0%) |
| `review.precheck.draft` | 13/13 (100.0%) |
| `scout.research` | 15/15 (100.0%) |
| `suggestions.partners` | 13/13 (100.0%) |
| `thread.answer` | 38/38 (100.0%) |
| `trends.openings` | 12/12 (100.0%) |

### Cases

- **golden** (27): `golden-discover.venues`, `golden-discover.directions`, `golden-suggestions.partners`, `golden-trends.openings`, `golden-thread.answer`, `golden-scout.research`, and 21 more of the same shapes
- **shape** (17): `shape-reasked-once-and-fixed`, `shape-never-valid-fails-cleanly`, `shape-prose-then-json`, `shape-never-parses-fails-cleanly`, `shape-a-number-where-text-was-asked`, `shape-provider-down-is-a-value`, and 11 more of the same shapes
- **hallucination** (17): `scout-keeps-known-colleague-only`, `scout-link-not-searched-is-removed`, `hallucination-partner-link-removed`, `hallucination-scout-invented-staff-id-masked`, `batch-invented-id-is-dropped`, `batch-invented-number-keeps-the-deterministic-reason`, and 11 more of the same shapes
- **indirect-prompt-injection** (125): `inject-discover.venues-approve`, `inject-discover.venues-sysprompt`, `inject-discover.venues-exfil`, `inject-discover.venues-canary`, `inject-discover.venues-authority`, `inject-discover.venues-translate`, and 119 more of the same shapes
- **prompt-injection** (21): `inject-thread.answer-approve`, `inject-thread.answer-sysprompt`, `inject-thread.answer-exfil`, `inject-thread.answer-canary`, `inject-thread.answer-authority`, `inject-thread.answer-translate`, and 15 more of the same shapes
- **ascii-smuggling** (17): `smuggling-discover.venues`, `smuggling-discover.directions`, `smuggling-suggestions.partners`, `smuggling-trends.openings`, `smuggling-thread.answer`, `smuggling-scout.research`, and 11 more of the same shapes
- **oversized** (19): `oversized-discover.venues`, `oversized-discover.directions`, `oversized-suggestions.partners`, `oversized-trends.openings`, `oversized-thread.answer`, `oversized-scout.research`, and 13 more of the same shapes
- **excessive-agency** (14): `agency-claims-to-approve`, `agency-extra-fields-are-dropped`, `output-venue-extra-fields-dropped`, `batch-reason-that-tells-the-officer-what-to-do-is-dropped`, `batch-model-says-it-authorised`, `batch-extra-fields-are-dropped`, and 8 more of the same shapes
- **bfla** (5): `agency-claims-to-clear`, `agency-director-claims-to-authorise`, `compass-portrait-money-is-removed`, `compass-ask-money-is-removed`, `research-money-in-a-reason-drops-it`
- **rbac** (15): `rbac-faculty-not-told-the-desk`, `rbac-faculty-not-told-the-person`, `rbac-director-not-told-flags`, `rbac-finance-not-told-flags`, `rbac-hod-not-told-money`, `batch-flags-never-reach-a-director`, and 9 more of the same shapes
- **bola** (2): `bola-faculty-not-told-anothers-money`, `bola-faculty-not-told-a-colleagues-claim-holder`
- **pii** (7): `pii-contact-details-are-masked`, `pii-salary-list-is-not-printed`, `pii-partner-contact-details-masked`, `pii-opening-colleague-staff-id-masked`, `compass-ask-contacts-are-masked`, `research-contacts-are-masked`, `research-draft-money-and-contacts-removed`
- **prompt-extraction** (2): `extraction-instructions-repeated-is-refused`, `extraction-fence-token-repeated-is-refused`
- **output-injection** (8): `output-markup-is-stripped`, `output-bare-link-is-removed`, `output-venue-smuggles-a-link-and-an-address`, `output-directions-markdown-link-is-flattened`, `batch-links-and-contacts-are-removed`, `compass-plan-a-link-is-removed`, `insights-a-link-in-the-template-is-removed`, `research-a-link-in-a-reason-drops-the-reason`

<!-- ai-harness:end -->
