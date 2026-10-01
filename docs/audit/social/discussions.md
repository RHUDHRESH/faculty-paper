# Audit: Discussions (`/discussions`)

`frontend2/src/pages/feed.tsx` (the page, posts, tabs, moderation), `college-stream.tsx`, `for-you.tsx`, `follow-topics.tsx`, `reactions.tsx`. A private thread at `/discussions/:id` is audited in `docs/audit/shared/discussions.md`.

## 1. Who and why
Every faculty member and officer, several times a week. The job: stay in touch with the college's research, celebrate a colleague, ask a research question or answer one (docs/jtbd/social.md, jobs 3 to 6). Nothing here shows money.

## 2. What it showed before
Screenshots: `img/discussions-before-1440.png`, `img/discussions-before-390.png`, `img/discussions-before-threads-1440.png`, and the real data as it is today (no posts yet) `img/discussions-before-empty-1440.png`. The real data copy has 0 posts, so a few posts and one thread were seeded on the scratch copy to look at the populated page.

| Part | Problem |
|---|---|
| Congratulate and Comment (college stream) | Put a draft into the composer at the top of the page. On a page that was 2,600 px tall the reader pressed a button far down and nothing visibly happened. |
| Header | Title, a long sentence about audiences, and two more buttons (Find people, Messages) of the same weight as each other. Both are already in the sidebar or the People list. |
| Order and length | The whole page was one 700 px column: posts, then a horizontal strip of people that scrolled sideways on a phone (cards cut off at 390 px), then 12 papers of identical rows. |
| Post cards | Every post was a floating card with its own border, a hairline above the reactions and a grey bubble per comment: three container levels on one page. |
| Tabs | Corner radius 8 and 6 px, 28 px tall on a phone (under the 40 px tap rule). |
| Threads tab | A title and a grey line, no face, "0 replies" and "Answered" mixed into one dotted line. |
| For you | Cards again, and "filed a new paper" where the rest of the page says "published". |
| Empty feed | Honest, but "Write a post" and the composer sat on top of each other. Kept. |
| Moderation | Report, Hide, Show it again, Leave it up, Reported (n) tab. All work; unchanged. |
| Mention codes | Already rendered as linked names in posts and comments; the composer shows names and sends markup. No raw `@user:"..."` anywhere. |

Checked against data: `/api/feed/college` answers in about 40 ms; the paper counts on the people cards come from the same publication record as the leaderboard.

## 3. What changed
- **Congratulate and Comment open a note right under the paper.** The words are started (`Congratulations @Name on "Title" in Journal, 2026!`), the colleague is named, and one line says what will happen: "Everybody can read this on the feed, and X is told", with "send a message" for a private word. Post puts it on the feed and tells them; the note is replaced by "Posted to the feed, and X has been told. See your post". A failed post keeps what was typed. The two buttons toggle their own box; only one is open at a time.
- **One title and one sentence** in the kit's `PageHeader`; the two extra buttons are gone (Messages is in the sidebar, Find people is beside People to follow).
- **People to follow is a rail on wide screens** (a list with a face, department, paper count and Follow) instead of a sideways strip; on a phone it sits below the papers, and only on the Everyone tab.
- **New from the college shows 5 papers, then "Show 7 more papers"** (the count is real).
- **Flat posts.** A post is a row separated by a hairline; comments keep one tint. No card inside a card.
- **Tabs** use the control radius and are 40 px on a phone. Reaction buttons are 40 px on a phone (kit sizes).
- **Threads tab:** a face for who asked, "Asked by X", when it was last active, reply count on the right, and Answered (green, in words) or Open.
- **For you** uses the same flat rows and says "published a paper".
- Faces on every person (posts, comments, who reacted, people to follow, threads, suggestions); initials when there is no photo.

## 4. Evidence after
- Screenshots: `img/discussions-after-1440.png`, `img/discussions-after-390.png`, `img/discussions-after-threads-1440.png`, `img/discussions-after-foryou-1440.png`, `img/discussions-after-admin-1440.png` (Reported tab), the inline note before and after posting `img/discussions-inline-congratulate-1440.png`, `img/discussions-inline-congratulate-390.png`, `img/discussions-inline-posted-1440.png`. No horizontal overflow at 1440 or 390.
- Tests: `college-stream.test.tsx` (7: the note opens under that paper only, posts a real feed post with `mention_ids`, shows the confirmation, five papers then more), `feed.test.tsx` (11, including threads with faces and the People to follow rail), `social-plus.test.tsx`, `collaborate.test.tsx` all pass; `npx tsc -b` clean; `node audit/clarity.mjs` no new violations.
- API: `/api/feed` 33 ms, `/api/feed/college` 39 ms.

## Also changed for this job (backend, same branch)
- `/api/people/me/ego?limit=60` for an author with more than 59 co-authors returned only first-step people, so "co-authors' co-authors" never appeared (159 papers, 169 co-authors: 59 first step, 0 second step). A third of the seats is now kept for the second step (colleagues first, then the people reached through most of your co-authors, then most papers), and seats it does not need go back to first-step co-authors. Measured on the real data copy for the six most prolific authors: 39 first-step and 20 second-step people, 340 to 440 ms through the API (was 190 to 220 ms).
- `is_college_member` meant "has an account here". `has_account` (same meaning) and `at_college` (an author of the college, account or not) now come with it on co-authors, connection paths and the ego map; the old field stays. "Saveetha, not on this app" and the Message button read `has_account`; the "colleague" and outside grouping read `at_college`. Tests in `backend/core/test_ego_second_step.py` (8).

## NEEDS
- `frontend2/src/ui/circle.tsx` (kit): `atCollege` still computes `is_college_member || college_affiliated`; it can read `at_college` now.
- Discussions has no place to ask a research question to everybody except a post; a "Ask a question" that opens a public thread (`POST /api/threads`, `visibility: PUBLIC`) would fill the Threads tab.
