# Audit: Messages with the research office (`/messages/office`, `/messages/o/:id`)

Built in `messages/index.tsx` and the thread page in `discussions.tsx`. Read as a faculty member (the asker) and as the research cell (the answerer).

## 1. Who and why
A faculty member asks "why was my claim sent back?" and waits. The research cell answers. For the asker it is the one place to ask; for the cell it is a queue.

## 2. What it showed before
Screenshots: `img/office-thread-before-1440.png` (faculty), `img/messages-office-before-1440.png` (cell).

| Part | Problem |
|---|---|
| The cell's view | Titled "Research office", with an "Ask the research office" button and the note "Ask the research office anything about your claims": the cell was being told to ask itself. Threads listed the asker as text only, no face. |
| Faculty wording | "Whoever is on duty in the research cell": a faculty-facing sentence naming the cell (vocabulary: "research office"). "They usually reply within 2 working days": a promise nothing in the system keeps. |
| Rows | "Open" beside a thread the office had already replied to. Boxed rows. |
| The thread | Two back arrows stacked ("Research office" and "The office"). Refresh, Follow, "0 following" and "Checked just now" on a private conversation with two people. A chip and a note both said it was with the office. No faces on posts. A reply from the office showed the name of the person on duty. |

## 3. What changed
- The cell sees "Questions from faculty": no Ask button, no instructions, each row led by the asker's face and name, "Waiting for an answer" or "Answered". The server now sends the face with each thread and post (`core/faces.py` fills `created_by_*` and `author_*`).
- Faculty see "Research office", "Whoever is on duty at the research office", and "The answer appears here and you get a notification".
- Inside the thread: one back link, no Refresh (it checks every 12 s by itself), no Follow or follower count on a private thread, one note instead of note plus chip.
- Faces on every post. To the asker, an office reply is "The research office" with the office icon; the cell sees the real names.

## 4. Evidence after
- Screenshots: `img/office-thread-after-1440.png`, `img/office-thread-after-390.png`, `img/messages-office-cell-after-1440.png`.
- Tests: `backend/core/test_faces.py::test_posts_and_threads_get_the_face_of_whoever_wrote_or_opened_them`.
