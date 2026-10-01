# Jobs (`/jobs`)

## Who and why
The super admin only. "Did the background work finish, and is the worker alive?" Opened when something looks stale, after a backup or an import, and from Home when a job has failed.

## What it showed before
![before](shots/jobs-before-1440.png)

On the real data: 250 jobs on record, 100 shown. The page was 10,000 px tall at 1440 px.
- Every row read "Stalled monthly runs recovery, Finished" (82 of the last 100), so a hundred rows said the same thing and the one that failed, if any, would have sat among them.
- No figure at the top: nothing said "0 failed" or whether the worker was alive. The two questions the page exists for had to be found by scanning.
- "Running now" and "Waiting to run" were two headed sections that were nearly always empty, each with a sentence, above the long list.
- "Running for 3 min" showed a job state word to people.
- The failed filter was a button pair ("All", "Failed") that reloaded the list; the retry button was "Run again" while the dialog and toast talked about queuing.
- Two grey dots with no words for success and failure, next to the word.

## What changed
- Title and the question as the sub line.
- The answer, four figures: failed jobs (link to the failed list), in progress now, waiting to run, and whether the worker is alive (the last job finished N minutes ago; "Quiet" in red after three hours, because the scheduled jobs run every few minutes).
- Failed jobs come first when there are any: name, when it started, the last line of the error, and **Retry job** where the server says it is safe, otherwise "This one is not safe to repeat. Run it again from its own page."
- "What has run" groups the runs by name: Job, Runs, Failed, Last run, Usually takes. The 82 identical rows are one line.
- "Show every run (100)" keeps the full list one click away.
- The button, dialog and toast use the same verb (Retry job / Retry job? / queued again). "Running" became "In progress" (the clarity baseline entry for jobs.tsx is removed).

## Evidence after
- `shots/jobs-after-1440.png` (800 px tall), `shots/jobs-after-390.png`.
- Tests: `src/pages/jobs-running.test.tsx`.
- API: `/api/admin/jobs?limit=100` 170 ms; a second call for the failed list is made only when there are failed jobs.
