# Faculty: Home (/)

`frontend2/src/pages/home-faculty.tsx`. API `GET /api/me/home` (new), `/api/claims?mine=1`, `/api/me/payments`, `/api/me/next-payout`, `/api/me/assignments`, `/api/discover/next` (one suggestion).

## 1. Who and why
Every faculty member, most working days. The four questions of docs/jtbd/faculty.md (jobs 1, 2, 6): is anything needed from me, where are my claims and when does the money come, how is my research going, what should I do next (file an unfiled paper, write with someone).

## 2. What it showed before
Screenshots: `shots/home-before-1440.png`, `shots/home-before-390.png` (real copy, ECE, 145 papers, 89 payments, with a sent-back claim and a draft seeded).

| Element | Problem |
|---|---|
| "Good afternoon, Kanagamalliga" at 48 px, a picture of a desk, the designation | A poster, not an answer. Nothing said whether anything was needed. |
| Four figures: 145 papers, 540 citations, 12 h-index, "#2 in ECE" | Answers the "how am I doing" question first, and the rank cost the server 0.8 s (it works out the whole department). Not what a claimant opens Home for. |
| A big search box | The same search as the top bar and Ctrl-K; it pushed the answer 300 px down. |
| Celebration card, four badges, each with a paper title | A large `panel-lead` above everything else, and the only "lead" panel on the page; re-read on every visit until closed. |
| "Needs you" card holding five kinds of thing (sent back, draft, 24 unfiled papers, three unfiled rows, "1 paper on the way") | Obligations and opportunities mixed; "on the way" is not a need. |
| "Fix and send again" | Went to the old edit form, not the fix view built for sent-back claims. |
| Unfiled rows | The same paper twice ("A ZIGBEE AND EMBEDDED..." is on the record twice), each with a clip-art picture, and a bare "File". The request behind it was `/api/me/publications`: 313 KB and 0.5 s to show three titles. |
| Money card | "Paid to you so far ₹3,96,703.75" first, then "Since 1 June 2026" and "On the way", but never when the money comes. A picture of an envelope. Two levels of container (a panel holding a rule and a definition list). |
| "On the way" | A second card per claim with a four-step Journey, and "ERP-RAW-3" printed as if it were a claim number. |
| Mobile | A fixed "File a paper" bar over the content, and the celebration card scrolled behind it. |
| Two requests for the record | `/api/me/summary` (rank, strip of ten years) and `/api/me/publications` in series with the claims. About 1.0 s before the first figure. |

## 3. What changes
- **One sentence answers, in the person's words:** "1 claim needs a fix from you and 1 draft is not filed; ₹2,000 is with the college, being checked." A claim already approved for payment adds ", expected in October" (from the college's payment pattern, `/api/me/next-payout`); before approval the college has not said it will pay, so it says "being checked". "about" is added when any amount is an estimate. With nothing to do: "Nothing needs you, and nothing is waiting to be paid." (`homeSentence`, tested.)
- **Needs you** holds only obligations: sent-back claims (reason, "Fix this claim" opens the fix view on the claim page), drafts ("Finish and file"), and work the head assigned (status changed in place, as before). It is not drawn when there is nothing; the sentence already said so.
- **Papers you can still file:** the newest three unfiled papers, one row per title, "File it" opens the filing form with the paper chosen; "All 24 unfiled papers" goes to My papers. The count is My papers' "Not claimed" count.
- **Your money:** three linked figures (paid so far, paid this academic year, on its way), the college's own payout sentence, and for research faculty the threshold card, from `ui/research-threshold`. No card around it.
- **Claims on the way:** four rows at most, longest waiting first: stage word, "Filed 91 days ago", "Taking longer than usual" past 14 days (words, not only colour), expected amount, the threshold sentence where it applies. Claim number only when it is a real "FP-" number. Links to the claim, and to My claims.
- **Your research:** one paper count (the count My papers, My research and `/api/me/summary` share), citations, h-index; each a link. If citations are unknown it says why and links to the profile.
- **One suggestion:** the colleague the record says is best to write with, with a face, and a reason; else a journal colleagues use. It is quiet when there is nothing to suggest or the request fails.
- **Celebrations** are one line ("New badge: First author and 3 more. See your badges") with a close button, not a card.
- **Removed:** the hero and its picture, the rank, the search box (top bar and Ctrl-K do it), the mobile bottom bar (the header button is in view), the clip-art per paper, the four-step journey per claim, the money picture.
- **Faster:** `GET /api/me/home` answers the record (count, citations, h-index, unfiled count and three rows) in one pass and is prefetched with the claims and payments the moment the session says who this is. The rank and the 313 KB paper list are gone from Home.
- **Welcome dialog:** the faculty intro now says what Home is for, and the "Find out where my claim is" guide points to Home and My claims in the college's stage words.

## 4. Evidence after
- Screenshots: `shots/home-after-1440.png`, `shots/home-after-390.png` (sent back, draft, unfiled, one claim moving), `shots/home-after-research-1440.png` (research faculty, threshold card). No horizontal overflow at 390; buttons are 40 px tall on the phone.
- Tests: `pages/home-faculty.test.tsx` (29: the sentence in every case, linked figures, one light record request and no summary or publications request, empty vs failed, unfiled rows and link, sent-back reason and the fix-view link, drafts, no desk named, no ERP number, threshold only for research faculty, one suggestion with a face, quiet celebration line, assignments). Backend: `core/test_me_home.py` (5: count equals `/me/summary` and `/me/publications`, unfiled equals My papers' "Not claimed", a title held twice is offered once, at most three rows, sign-in required).
- API on the real copy (145 papers): `/api/me/home` about 0.45 s cold; before, the record took `/api/me/summary` 0.8 to 1.0 s plus `/api/me/publications` 0.5 s and 313 KB, and now the first figure waits on 0.45 s and 0.8 KB. Claims 0.1 to 0.3 s, payments 0.07 s, next payout 0.04 s, all started together. The suggestion (`/api/discover/next`, 0.15 to 0.7 s) does not hold up the page.

## 5. Not done / needs
- `ui/celebrations.tsx` gained a `variant="line"`; the head's Home still uses the card. NEEDS: the base helper to decide whether every Home should use the line.
- Assignments carry no photo for the colleague ("with Dr Ravi Kumar" shows initials). NEEDS: the assignments API adding `partner_photo_url` (or `core/faces.py` naming the pair).
- `/api/me/summary` still computes the rank for its other callers; nothing on Home reads it now.
