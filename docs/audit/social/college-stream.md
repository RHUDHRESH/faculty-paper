# Audit: The college stream (New from the college, People to follow)

Shown on `/discussions` (`frontend2/src/pages/college-stream.tsx`, drawn by `feed.tsx`); API `GET /api/feed/college`. The Discussions page itself (posts, tabs, composer, "For you", follow topics) belongs to the shared-pages helper; only this component is audited here.

## 1. Who and why
Everyone, whenever they open Discussions and nobody has posted, or beside the posts: "What has the college just published, and who should I follow?" Jobs: docs/jtbd/social.md 3 and 5.

## 2. What it showed before
Screenshots: `img/college-stream-before-1440.png`, `img/college-stream-before-390.png`.

| Element | Problem |
|---|---|
| Both headings | Set at 14 px semibold, smaller than the section headings elsewhere. |
| People to follow | Faces and Follow, but the department was cut off ("S&H-ENGL...") and the card was a third box style (12 px radius with its own border). |
| New from the college | Face, name, paper, journal, Congratulate, Comment. Co-authors were in the API and not shown. |
| A failed load | Drawn as nothing at all, the same as "no new papers". |
| Subtitle | "Papers colleagues filed lately": the college publishes, colleagues do not "file" for a stream. |

Checked against data: `/api/feed/college` returns 12 papers and 6 people, each with `photo_url`; the counts on the cards (10 papers, 7 papers) come from the same publication record as the leaderboard.

## 3. What changes
- Both headings use the section heading; people cards use the panel; the whole department is shown on its own line.
- Each paper lists its co-authors as links ("With Dr Lila Rao and Dr Joe Paul").
- A failed load says "Could not load the college's new papers." with Retry, so it is never taken for an empty stream.
- Subtitle: "Papers colleagues have published lately".

## 4. Evidence after
- Screenshots: `img/college-stream-after-1440.png`, `img/college-stream-after-390.png`.
- Tests: new `frontend2/src/pages/college-stream.test.tsx`, 3 pass; `feed.test.tsx` still passes.
- API: `/api/feed/college` about 90 ms.

## Not audited, and why
- `/gallery` is the design-system gallery and only exists in development builds (`import.meta.env.DEV`); no user can reach it.
- There is no separate impact-card page. `/impact` redirects to My research (faculty helper). The share plate is used only on the Wall of fame (see `wall.md`).
- NEEDS (Discussions owner): the Congratulate and Comment buttons put a drafted post into the composer at the top of the page; on a long page the reader does not see it happen.
