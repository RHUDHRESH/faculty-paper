# Audit: Discover

Route `/discover` (`?tab=directions|venues|people|papers`). `frontend2/src/pages/discover.tsx`, `discover-feed.tsx`; API `/api/discover/for-you`, `/next`, `/status`, `/dismiss`, `/api/follows/topics`. (`for-you.tsx` and `follow-topics.tsx` are parts of the Discussions page and belong to that view's owner.)

## 1. Who and why
Every faculty member, weekly: "What should I write about next, where could it go, who should I meet?" Jobs: docs/jtbd/social.md 1, 2 and 6.

## 2. What it showed before
Screenshots: `img/discover-before-1440.png`, `img/discover-before-390.png`, `img/discover-venues-before-1440.png`.

| Element | Problem |
|---|---|
| Header | Sentence "This week: 9 directions, 12 fresh papers, 6 people near your work." was the answer, but nothing in it could be opened. A "+ Topic" button and a "Change" link beside "Tuned to:" did the same thing. |
| For you | One grid of about 30 cards of four kinds with equal weight, different heights and gaps: the "SaaS card grid of identical boxes" docs/ux/17 rules out. The reader had to scroll a page of 3,700 px to learn it was four lists. |
| Tabs | Round pills with icons, unlike the tabs on Leaderboard and Who to work with; names ("Directions", "Venues") were the system's, not the job's. |
| Venues tab | For a faculty member, a yellow alert: "The model service is not answering. No local model service is answering on http://127.0.0.1:11434. Start Ollama and reload. On the machine running this server: ollama serve". An operator's fix shown to a lecturer, in the main flow (docs/ux/06 forbids it). |
| Sheet | Called "Tune Discover"; a dash in its help text. |

Checked against data: the four figures (9, 6, 6, 12) equal the counts in `/api/discover/for-you`; faces come from `photo_url` on people and paper authors. The feed call takes 240 to 400 ms warm and about 1 s on the first call after the 30 s aggregate cache expires.

## 3. What changes
- Standard header, one action ("Choose topics", hidden while the page has nothing to go on, when the empty state offers it), and four linked figures: directions, journals colleagues use, people near your work, new papers in your topics. Each opens its tab.
- "You follow" (or "From your papers") shows the topics as chips: a summary, with no second copy of the button.
- For you is four short sections: What to write about (a lead direction and two more), Where to publish (three journals as rows), Who to meet (three people with faces, Message and View), New at the college (four papers with the faces of their authors). Each says how many there are and "See all 12".
- Tabs are underlined like the rest of the app and named for the job: For you, What to write about, Where to publish, Who to meet, New at the college.
- On Venues a lecturer sees one calm line ("The venue finder is not available right now. These venues are counted from where colleagues publish on your topics."); only a super admin sees the service message and its fix.
- Sheet title "Choose your topics".

## 4. Evidence after
- Screenshots: `img/discover-after-1440.png`, `img/discover-after-390.png`, `img/discover-venues-after-1440.png`.
- Tests: `frontend2/src/pages/discover.test.tsx`, 9 pass (the answer strip links to the tabs; no model wording for a lecturer).
- API: for-you 240 to 400 ms warm (unchanged). NEEDS: none in the kit.
