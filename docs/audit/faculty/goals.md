# Faculty: Research goals (`/goals`)

`/goals` is a redirect to `/research?tab=me#this-year` (`app/nav.ts` `REDIRECTS`). The goal is set and read in the "This year" block on My research (`research.tsx` `ThisYear`), which is now the first block under "Present". The card for it is in `docs/audit/faculty/research.md`.

## 1. Who and why
Any faculty member who wants to know "am I on track this year?" (job 9). Research faculty also have a built-in target (the research threshold, in rupees, not papers); for them the block shows the quota ring and no editable target.

## 2. What it showed before
- A second place to set the same target lived on Your profile ("Your goals for 2026 / Set goals", empty for most people), a third on the old `goals.tsx` page (not imported anywhere and not routed; it also holds a head's department roll-up that nothing calls).
- The block that answered it was at the bottom of My research, under the ideas.

## 3. What changed
- One place to set it: the "This year" block on My research (pace sentence, ring, "Set a target, only you see it").
- Your profile no longer draws the goal card.
- `/goals` keeps redirecting, so bookmarks work; the palette finds it by "goals" and "target" (`nav.test.ts` asserts the keyword).

## 4. Evidence
- `frontend2/src/pages/research.test.tsx` (pace under Present); `app/nav.test.ts` still passes.
- Not done: `frontend2/src/pages/goals.tsx` is dead code (no importer). Deleting it is safe, but it also contains `/api/hod/goals` roll-up code another helper may want to reuse, so it was left alone (NEEDS: whoever owns the head's views decides).
