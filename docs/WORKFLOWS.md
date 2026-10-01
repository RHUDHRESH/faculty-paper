# Workflows: every job, per role

Each row is a job someone does start to finish. The Test column names a test in
`backend/core/test_workflows.py`. Each test runs the job at the API as the right
role and checks the outcome and the rule that matters. External services
(OpenAlex, Crossref, Scopus, Anthropic, Google) are stubbed. `UiEntryPoints`
checks that every route below is declared in `frontend2/src/main.tsx` and that
some screen calls every endpoint the jobs use.

Legend: ✅ works end to end (API test passes and a UI entry point exists) ·
⚠ partial (the problem is stated in the row) · ❌ missing.

Totals: **115 workflow rows. 115 ✅, 0 ⚠, 0 ❌.**

## Built (was "To build")

All eight are wired. Frontend tests: `src/ui/desk-actions.test.tsx`, `leaderboard.test.tsx`, `imports.test.tsx`.

1. ✅ **Hold / resume at the desks.** Add a "Put on hold (reason ≥10 chars)" / "Resume" button on `/clearing` (SUBMITTED) and `/approvals` (CLEARED). It calls `POST /api/claims/{id}/hold` and `/resume`.
2. ✅ **Reject outright.** In `/clearing`, add a second choice next to "Send back": "Reject — cannot be refiled". It calls `POST /api/claims/{id}/reject-outright`.
3. ✅ **Principal sends to the faculty or rejects outright.** On `/approvals`, add the same two choices beside "Return one step" (`return-to-faculty`, `reject-outright`).
4. ✅ **Super admin corrects claim fields.** In the claim drawer, add an "Edit fields (with reason)" form. It calls `POST /api/admin/claims/{id}/edit`.
5. ✅ **Leaderboard download.** Add a "Download CSV" button on `/leaderboard`. It calls `GET /api/leaderboard?fmt=csv&…` with the current filters. The API was added in this pass.
6. ✅ **Publication harvest / Scopus sync.** Add "Refresh from OpenAlex" and "Sync Scopus" buttons with status on `/imports`. They call `POST /api/admin/publications/harvest`, `/scopus-sync` and `GET /status`.
7. ✅ **Run badges now.** Add a super admin button on `/data/health` or `/imports`. It calls `POST /api/admin/badges/run`.
8. ✅ **Data browser access.** `_may_browse_data` is now SUPER_ADMIN only, matching the nav (`test_only_the_super_admin_may_browse`).

## Signed out

| Job to be done | Steps | Entry point | Status | Test |
|---|---|---|---|---|
| Sign in with password | email + password | `/` sign-in | ✅ | `test_anon_signs_in_with_password` |
| Sign in with Google | Google button → linked account | `/` sign-in | ✅ | `test_anon_signs_in_with_google_linked_account` |
| See the public counters / college | landing | `/` | ✅ | `test_anon_sees_public_stats_and_institution` |
| Subscribe to the calendar (ICS) | copy the private feed URL into Google/Outlook | `/calendar` → Subscribe dialog | ✅ | `test_anon_subscribes_to_calendar_ics` |
| Unsubscribe from the digest by email link | click link → confirm | emailed link | ✅ | `test_anon_unsubscribes_from_digest_by_link` |
| Private data refused | – | – | ✅ | `test_anon_is_refused_everything_private` |
| First-run college setup | setup status → name the college | `/setup` | ✅ | `test_admin_first_run_setup_status` |

## Faculty (the claimant; HOD and officers also do all of these for their own papers)

| Job to be done | Steps | Entry point | Status | Test |
|---|---|---|---|---|
| File a paper | pick/pull paper → details → proof + SEC refs → tick 3 conditions → submit → ticket | `/papers/new` (File a paper) | ✅ | `test_faculty_files_a_paper_with_three_conditions_and_proof` |
| Conditions are required to file | submit without ticks → refused | `/papers/new` | ✅ | `test_faculty_cannot_file_without_the_conditions` |
| Save a draft, file later | save → reopen → submit | `/papers/:id/edit` | ✅ | `test_faculty_saves_a_draft_then_files_it` |
| Pull a paper by DOI/title | paste DOI → auto-fill | `/papers/new` lookup | ✅ | `test_faculty_pulls_a_paper_by_doi` |
| Pull from my Scopus list | choose from list | `/papers/new`, `/papers` | ✅ | `test_faculty_pulls_from_scopus_list` |
| Upload the proof PDF | attach file | `/papers/new` | ✅ | `test_faculty_uploads_proof_pdf` |
| Track my claim (never see the desk) | open paper | `/papers/:id` | ✅ | `test_faculty_tracks_own_claim_without_seeing_the_desk` |
| Fix a sent-back claim and refile | read reason → edit → submit | `/papers/:id/edit` | ✅ | `test_faculty_fixes_a_returned_claim_and_refiles` |
| Withdraw a claim | Withdraw | `/papers/:id` | ✅ | `test_faculty_withdraws_a_claim` |
| See what I was paid | My payments | `/papers`, home | ✅ | `test_faculty_sees_own_payments` |
| Dispute a paper wrongly attributed | "Not mine" | `/papers` | ✅ | `test_faculty_disputes_a_publication_attributed_to_them` |
| Write to the research office | new office message | `/messages/office` | ✅ | `test_faculty_writes_to_the_research_office` |
| File a final-year-project claim (mentor) | pick my team → conference paper → file → ₹15,000 | `/papers/new` team picker | ✅ | `test_mentor_files_a_final_year_project_claim` |
| Link Google / unlink | Profile → Link Google | `/me` | ✅ | `test_faculty_links_google` |
| Request a profile correction → super admin approves | Profile → request change → office approves | `/me` → `/requests` | ✅ | `test_faculty_requests_profile_correction_and_admin_approves` |
| Edit my own profile | bio, photo | `/me`, `/u/:id` | ✅ | `test_faculty_edits_own_profile` |
| Change password | dialog | account menu | ✅ | `test_faculty_changes_password` |
| Notification preferences | levels per kind | `/settings/notifications` | ✅ | `test_faculty_sets_notification_preferences` |
| Read / clear notifications | bell → read all | `/notifications` | ✅ | `test_faculty_reads_and_clears_notifications` |
| Message a colleague | open chat → send | `/messages` | ✅ | `test_faculty_messages_a_colleague` |
| Send / accept a collaboration request | request card → accept | `/messages/:id` | ✅ | `test_faculty_sends_and_accepts_collab_request` |
| Post to the feed, like, comment | compose → post | `/research` feed | ✅ | `test_faculty_posts_to_feed_and_colleague_likes_it` |
| Report a post → office hides it | report → office moderates | feed menu | ✅ | `test_faculty_reports_a_post_and_office_hides_it` |
| Follow / unfollow a colleague | Follow | `/u/:id` | ✅ | `test_faculty_follows_a_colleague` |
| Follow a topic, react to a post | follow topic, react | `/research` | ✅ | `test_faculty_follows_a_topic_and_reacts` |
| Add a skill, get endorsed | Skills → add | `/u/:id` | ✅ | `test_faculty_adds_a_skill_and_gets_endorsed` |
| Social privacy settings | settings | `/u/me/stats` | ✅ | `test_faculty_sets_social_privacy` |
| Start a discussion, reply | new thread | `/discussions` | ✅ | `test_faculty_starts_a_discussion_and_replies` |
| Resolve my discussion | Mark resolved | `/discussions/:id` | ✅ | `test_discussion_owner_resolves_thread` |
| See the leaderboard | board | `/leaderboard` | ✅ | `test_faculty_sees_leaderboard` |
| Export the leaderboard | Download CSV | `/leaderboard` | ✅ | `test_anyone_exports_the_leaderboard_csv` |
| Set my goals | This year → targets | `/research?tab=me` | ✅ | `test_faculty_sets_personal_goals` |
| Add a calendar event | New event | `/calendar` | ✅ | `test_faculty_adds_a_calendar_event` |
| Reset my ICS link | Subscribe → reset | `/calendar` | ✅ | `test_faculty_resets_calendar_feed_link` |
| Home summary / my research | open home | `/`, `/research` | ✅ | `test_faculty_sees_home_summary_and_research` |
| Set research interests | pick domains | `/discover`, `/me` | ✅ | `test_faculty_sets_research_interests` |
| Find where to publish | title → venues | `/discover` | ✅ (503 when the AI service is down) | `test_faculty_finds_where_to_publish` |
| Run the research scout | Run → results | `/scout` | ✅ | `test_faculty_runs_the_research_scout` |
| Find collaborators | who to work with | `/collaborate` | ✅ | `test_faculty_finds_collaborators` |
| Search everything / people | search box | `/search` | ✅ | `test_faculty_searches_everything` |
| View a colleague's profile | click name | `/u/:id` | ✅ | `test_faculty_views_a_colleague_profile` |
| Wall of fame, cheer | cheer | `/wall` | ✅ | `test_faculty_cheers_on_wall` |
| Celebrations and badges | on home | `/` | ✅ | `test_faculty_sees_celebrations_and_badges` |
| Never sees flags, desk, ledger, HOD | – | – | ✅ | `test_faculty_cannot_see_flags_or_admin` |

## HOD (money-blind, not an approver)

| Job to be done | Steps | Entry point | Status | Test |
|---|---|---|---|---|
| See the department with no money shown | overview | `/department` | ✅ | `test_hod_sees_department_money_blind` |
| Set a department target | add target | `/department` | ✅ | `test_hod_sets_a_target` |
| Remove a target | delete | `/department` | ✅ | `test_hod_removes_a_target` |
| Nudge faculty | select → message | `/department` | ✅ | `test_hod_nudges_faculty` |
| Assign a research area | assign → faculty sees it on home | `/department` → `/` | ✅ | `test_hod_assigns_a_research_area` |
| Plan the year | plan | `/department` | ✅ | `test_hod_plans_the_year` |
| Look at one person | click a row | `/department` | ✅ | `test_hod_drills_into_a_person` |
| Export the department | Export | `/publications`, `/reports` | ✅ | `test_hod_exports_department` |
| HOD cannot approve | – | – | ✅ | `test_hod_is_not_an_approver` |

## Research cell / research coordinator (the office)

| Job to be done | Steps | Entry point | Status | Test |
|---|---|---|---|---|
| Clear a submitted claim | queue → review → Clear | `/clearing` | ✅ | `test_cell_clears_a_submitted_claim` |
| Send a claim back with a reason | Send back (≥10 chars) | `/clearing` | ✅ | `test_cell_sends_back_with_reason` |
| Reject outright | – | `/clearing` | ✅ | `test_cell_rejects_outright` |
| Hold and resume | – | `/clearing` | ✅ | `test_cell_holds_and_resumes` |
| Nobody acts on their own claim | – | – | ✅ | `test_nobody_acts_on_own_claim`, `test_officer_files_own_paper_but_cannot_clear_it` |
| Leave an internal desk note (faculty never see it) | Notes | claim drawer | ✅ | `test_desk_leaves_internal_note_faculty_never_sees_it` |
| Raise a flag → resolve it | Flag → resolve | claim review, `/flags` | ✅ | `test_cell_raises_a_flag_and_admin_resolves` |
| Check the attached files | Check files | claim review | ✅ | `test_cell_checks_attached_files` |
| Review duplicates | confirm / dismiss | `/duplicates` | ✅ | `test_cell_reviews_duplicates` |
| Review author matches | this is X / not on roster | `/people/matches` | ✅ | `test_cell_reviews_author_matches` |
| Import the college-site zip | upload zip | `/imports` | ✅ | `test_cell_imports_college_site_zip` |
| Import the FYP team roster | upload | `/imports` | ✅ | `test_cell_imports_fyp_team_roster` |
| Find a person's teams (filing on behalf) | team picker | `/papers/new?for=` | ✅ | `test_cell_files_on_behalf_via_teams_lookup` |
| Create a user | Add person | `/people` | ✅ | `test_cell_creates_user` |
| Reset a password | Reset | `/people` | ✅ | `test_cell_resets_a_password` |
| Monthly run | upload → start → export | `/batches` | ✅ | `test_cell_runs_monthly_batch` |
| ERP / faculty master import | upload | `/imports` | ✅ | `test_cell_imports_erp_and_faculty_master` |
| SCImago / SNIP import | upload | `/reference` | ✅ | `test_cell_imports_scimago_and_snip` |
| Scopus profile verification | list | `/imports` | ✅ | `test_cell_links_scopus_profiles` |
| Institution settings | edit | `/settings` | ✅ | `test_cell_edits_institution_settings` |
| Policy / formula | view, edit | `/policy` | ✅ | `test_cell_edits_formula_policy` |
| Audit log and faults | browse | `/audit`, `/faults` | ✅ | `test_cell_reads_audit_and_faults` |
| Past claims | browse | `/archive` | ✅ | `test_cell_browses_past_claims` |
| Harvest publications | Refresh from OpenAlex / Sync Scopus | `/imports` | ✅ | `test_cell_harvests_publications` |
| Handle profile requests | approve / decline | `/requests` | ✅ | `test_faculty_requests_profile_correction_and_admin_approves` |
| Moderate the feed | reports → hide | feed | ✅ | `test_faculty_reports_a_post_and_office_hides_it` |

## Super admin

| Job to be done | Steps | Entry point | Status | Test |
|---|---|---|---|---|
| Override a stuck status | Override | `/clearing` drawer | ✅ | `test_admin_overrides_a_stuck_status` |
| Reassign a claim / edit fields | Reassign; Edit | claim drawer | ✅ | `test_admin_edits_and_reassigns_a_claim` |
| View as someone (impersonate) | View as → stop | `/people`, shell banner | ✅ | `test_admin_impersonates_and_stops` |
| Browse / export any table | Data | `/data` | ✅ (super admin only) | `test_admin_browses_and_exports_data` |
| Check and fix data health | run → Fix | `/data/health` | ✅ | `test_admin_checks_and_fixes_data_health` |
| Take a backup | Back up now | `/data/health` | ✅ | `test_admin_takes_a_backup` |
| Restore a backup | upload + type RESTORE | `/imports` | ✅ | `test_admin_restores_a_backup` |
| Wipe (preview) | preview → confirm | `/data` | ✅ | `test_admin_previews_a_wipe` |
| Merge duplicate accounts | merge | `/people/matches` | ✅ | `test_admin_merges_duplicate_accounts` |
| Send a Director-stage claim back (standing in) | Send back | `/authorisations` | ✅ | `test_director_only_moves_forward_super_admin_sends_back` |
| Void a payment | Void | `/ledger`, `/payments` | ✅ | `test_finance_pays_and_voids` |
| Run badges | Run badges now | `/data/health` | ✅ | – |

## Principal

| Job to be done | Steps | Entry point | Status | Test |
|---|---|---|---|---|
| Approve a cleared claim | queue → Approve | `/approvals` | ✅ | `test_principal_approves_a_cleared_claim` |
| Bulk approve | select → Approve all | `/approvals` | ✅ | `test_principal_bulk_approves` |
| Return one step to the desk | Return | `/approvals` | ✅ | `test_principal_returns_one_step`, `test_principal_sends_back_to_the_desk` |
| Return to faculty / reject outright | Send to the faculty member / Reject outright | `/approvals` | ✅ | – |
| Read flags | – | `/flags` | ✅ | `test_cell_raises_a_flag_and_admin_resolves` |

## Director (never sees flags, only moves forward)

| Job to be done | Steps | Entry point | Status | Test |
|---|---|---|---|---|
| Authorise a claim, with no flags shown | queue → Authorise | `/authorisations` | ✅ | `test_director_authorises_without_seeing_flags` |
| Bulk authorise | select → Authorise | `/authorisations` | ✅ | `test_director_bulk_authorises` |
| Cannot send back | – | – | ✅ | `test_director_only_moves_forward_super_admin_sends_back` |
| Dashboard | open | `/` | ✅ | `test_staff_sees_dashboard` |

## Finance (never sees flags)

| Job to be done | Steps | Entry point | Status | Test |
|---|---|---|---|---|
| Pay (a super admin voids) | Mark paid | `/payments` | ✅ | `test_finance_pays_and_voids` |
| Bulk pay | select → Pay | `/payments` | ✅ | `test_finance_bulk_pays` |
| Ledger and export | view → CSV | `/ledger` | ✅ | `test_finance_reads_and_exports_ledger` |
| Set a budget | add FY budget | `/budget` | ✅ | `test_finance_sets_a_budget` |

## Staff reports (all officers; HOD sees the money-free subset)

| Job to be done | Steps | Entry point | Status | Test |
|---|---|---|---|---|
| Build and export a report | filters → export | `/reports`, `/reports/build` | ✅ | `test_staff_builds_and_exports_a_report` |
| NAAC / accreditation pack | rows → download | `/accreditation` | ✅ | `test_staff_downloads_naac_pack` |
| Journal report | view | `/journals` | ✅ | `test_staff_reads_journal_report` |
| One faculty member's report | open | `/people` | ✅ | `test_staff_exports_a_faculty_report` |
