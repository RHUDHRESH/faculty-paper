# Faculty: Your profile (`/me`, also reached as "profile")

`frontend2/src/pages/profile.tsx`; data `/api/auth/me`, `/api/auth/profile/*`, `/api/me/summary`, `/api/me/interests`, `/api/people/me/photo`. Job 6 in docs/jtbd/faculty.md (keep my record right: Scopus ID, ORCID, photo, research areas) plus account safety.

## 1. Who and why
Every signed-in person, a few times a year: to add an ORCID or a phone number, to pick research areas, to ask for a Scopus ID or a name to be corrected, to change the password, or (new) to put a face on their name.

## 2. What it showed before
Screenshots: `img/before_d_me.png`, `img/before_m_me.png`; full page seen at 1440 (2,679 px tall).

| Element | Problem |
|---|---|
| Title "Your account" | The sidebar and Ctrl-K call the page "Your profile". |
| The photo | Initials only. There was no way to add a photo on this page; it lived in a dialog on the public profile (`/u/me`), which the owner did not find. The record page for the person even said "a photo can only be added by the person themself". |
| "Your record": Filed 4, In review 1, Paid 3, Sent back 0, Drafts 0, Total received ₹3,96,703.75 | Counted claims by stage. For a person with 145 papers on record, 119 of them paid, this said "Paid 3" beside ₹3.96 lakh received. It disagreed with Home, My papers and My research. It sat below eleven locked rows. |
| Eleven locked detail rows, each with "Request a change" | Nine identical buttons, most for things nobody asks to change (biometric ID, employee ID, role, faculty type). The Scopus author link and the Scopus author ID were two rows for one fact. |
| Sign-in methods | A paragraph of instructions about a password issued on paper, then "Google sign-in is not available on this server." |
| "No profile has been imported for Scopus ID 56884761200 yet. The research office loads them from the Scopus profile workbook." | Office process spoken to a teacher. |
| "Your goals for 2026 / Set goals" | A second, empty, place to set the yearly target that already lives on My research. |
| Badges | Kept, at the bottom. |
| "The research cell reactivates an account" | Staff word to a faculty member (docs/ux/19). |
| Length | Twice the phone height of what a person opens it for. |

## 3. What changes
- Standard header: "Your profile", one line, one action (See your public profile).
- The face, with "Add a photo" or "Change photo" and "Remove photo" right under the name, through the same endpoint the public profile uses.
- The answer replaces the old record block: papers on your record, papers ready to claim, money received (not for a head, who sees no money), read from `/api/me/summary`, the service Home uses, each linking to its list. One paper count.
- The details a person plausibly wants to fix stay in view: name, staff ID, Scopus author ID (with "Open your Scopus author page"), department, designation, and the research threshold for research faculty. Email, biometric ID, employee ID, role, faculty type and the Scopus link fold behind "Show more details (6)", which opens by itself when one of them has a request in flight or turned down.
- The yearly goal block goes (set it on My research). Sign-in text is shorter. The Scopus line says what is true for the teacher.
- The unused stage counts, and the code behind them, are removed.

## 4. Evidence after
- Screenshots: `img/after-profile-1440.png`, `img/after-profile-390.png` (no horizontal scroll at 390).
- Tests: `frontend2/src/pages/profile.test.tsx` and `profile.scopus.test.tsx`, 16 pass (new: the record figures agree with Home's summary, add a photo, details fold and open).
- API: `/api/me/summary` 0.5 s on the full local data (shared with Home, cached); `/api/auth/me` and corrections under 100 ms.

## Not done
- The photo file for this test person is missing from the local media folder, so the screenshot shows initials even though a photo is on file; the fallback works as designed.
- `app/nav.ts` still describes "Your stats" as "Your papers, citations and claims in numbers"; the page is about profile views and posts (NEEDS: shell).
