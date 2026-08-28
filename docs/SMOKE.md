# Smoke checklist, by role

A person walking this should be able to do it without asking anybody what a
button is called. Every line names something to click and something that must
then be true; where a line only says "it loads", that is deliberate — those
screens are swept automatically and the check here is that the sweep is not
lying.

**Where.** Locally, the app is `http://localhost:5174` and the API is
`http://localhost:8000` — the app proxies `/api` and `/media`, so you only ever
type the first one. In production, see `docs/OPS.md`: the Vercel origin, with
`GET /api/health` answering `ok`, `db` and `media_persistent`.

**What the automated suite already covers.** `cd frontend2 && npm run e2e`
walks every route for all six roles, the five-desk payment chain, the same
chain done in bulk, a ticket sent back and re-filed, the reference-number
refusal, sign-out, phone widths, and the rule that a head of department is
shown no amount anywhere. Do not spend a smoke run re-doing those. Spend it on
the things a browser test cannot judge: whether a screen reads sensibly,
whether a number looks right, and whether the words on a refusal tell you what
to do next.

**Ticket numbers** are `FP-YYYY-NNNNNN` (six digits, e.g. `FP-2026-000042`) and
a ticket keeps its number for life — a paper sent back and filed again comes
back wearing the same one.

---

## Everybody, whatever the role

- [ ] **Sign in** at `/` with email and password. The password field has an eye
      to read it back; passwords here are issued on paper, so this is on
      purpose. "Continue with Google" appears only when a client id is
      configured, and signing in that way never creates an account.
- [ ] **Sidebar** shows Home and Search first, then only the groups this role
      has ("Research", "Look at", "Set up"). Nothing in it leads to
      "No page at this address" or "Not open to this account".
- [ ] **Search** (`/search`, second in the sidebar, offered to every role).
      Empty box reads "Search for anything" — *not* "no results". Type a paper
      title, a DOI, a journal name or a colleague's name and you get grouped
      results: literature, journals, people, and "Claims filed here".
      - [ ] A source that is down is named as down, and the results are marked
            incomplete rather than presented as the whole answer.
      - [ ] A journal we resolved against our own tables shows its quartile and
            metrics. One we only have a name for shows no number at all.
- [ ] **Command palette** — `Ctrl K` (`⌘K`) opens it and can reach any page the
      sidebar offers.
- [ ] **Account menu** (top right, named "Account: <your name>") offers
      **Your profile** and **Sign out**.
- [ ] **Sign out** returns you to the sign-in form, and pressing Back does
      *not* get the session back.
- [ ] **A bad address** — type `/this-is-not-a-page`. You get "No page at this
      address", and the URL is left as you typed it.
- [ ] **On a phone** (375px wide): the sidebar becomes a **Menu** drawer, the
      drawer carries the same account menu, and no page scrolls sideways.

---

## Faculty

The only role that can file anything.

- [ ] **Home** shows your own summary — what is filed, what is moving, what
      needs you.
- [ ] **My papers** (`/papers`) lists your tickets. The search box is "Search
      your papers". Statuses read in your words, not the system's: *Draft*,
      *Awaiting check*, *Checked*, *Approved*, *Authorised*, *Paid*, *Sent
      back*.

### Filing one

- [ ] **File a paper** (`/papers/new`) opens the **eligibility gate** first —
      "Confirm before you start", three checkboxes. Pressing **Start the claim**
      with any unticked says which are outstanding and what to do about each;
      it does not simply sit there disabled.
- [ ] Tick all three → the form opens, one question per screen, in five phases
      (the paper, the journal, you and the claim, the proof, check and file).
- [ ] **Which paper is this?** — paste a DOI or search the title. A Scopus hit
      fills several answers at once and says on screen which ones it filled;
      questions it answered are then stepped over rather than shown as
      pre-filled boxes.
- [ ] **Autosave** — type a title, wait ~2.5s, and the status line says
      *Saved*. Nothing here is saved by pressing a button.
- [ ] **It refuses to move on** with something missing, and names what: leave
      the publication type and date empty and press **Continue** — you are told
      "Choose what kind of publication this is" and "Enter the date it was
      published", and you stay on that screen.
- [ ] **The estimate is on screen the whole way down**, not just at the end,
      including "this will pay ₹0" while there is still something to do about
      it.
- [ ] **Attach the cited SEC references** — each one needs the number it
      carries in your reference list, typed beside the file. The tally under
      them says how many of the attached files actually count.
- [ ] **Check and file** lists everything outstanding, each with a link that
      takes you to the screen that fixes it and brings you back.
- [ ] **File this paper** → confirm → a ticket number appears.
- [ ] **When it cannot be auto-confirmed** (no Scopus match, missing quartile),
      you are told so and offered a note: write 10+ characters and **Send
      anyway, with this note**. The button says how many more characters are
      needed until it is usable.
- [ ] **Filing with references that carry no numbers is refused**, and the
      refusal says how many were counted, what to attach, where the number
      comes from, that it would otherwise be worked out as ₹0, and that you can
      file it as a publication count instead. *(See "Known gaps" below — a
      first-time claimant currently gets a blunter message.)*

### After it is filed

- [ ] **The ticket page** (`/papers/<id>`) shows the five-step tracker, who is
      holding it, the amount and how it was worked out, and its history.
- [ ] **Sent back** — the reason is a red callout at the very top of the page,
      above the back link, in the words the research cell wrote, with their
      name and the time. An **Edit** button is offered beside it.
- [ ] **Edit** opens the form on your ticket (titled "Edit ticket FP-…"), with
      no eligibility gate in the way. File it again and it keeps the same
      ticket number.
- [ ] **A paid ticket** reads "Settled." and the tracker is on step 5 of 5.
- [ ] **Withdraw** is offered while it is still yours to withdraw.

---

## Research cell (and research coordinator, and super admin)

- [ ] **Clearing queue** (`/clearing`) lists submitted tickets with the paper,
      the claimant, the amount and how long it has been waiting. Rows over a
      week old are marked.
- [ ] `j` / `k` move down and up the list, `x` selects, `Enter` opens.
- [ ] **Open a ticket** → the sheet shows the evidence, the verification, and
      how the amount was reached.
- [ ] **Clear** → the dialog recalculates first, and the confirm button carries
      the figure: **"Clear — ₹…"**. Nothing is cleared at an unnamed amount.
- [ ] **Set verified values** saves a SNIP or quartile by hand, with a source
      note, and recalculates.
- [ ] **Send it back** → a reason is required (the button stays unusable under
      10 characters, and says "At least 10 characters."). The claimant sees
      that sentence at the top of their ticket.
- [ ] **Bulk clear** — tick several rows; the bar says how many are selected
      and what they come to, and stays there when a filter hides one of them.
      **Clear N tickets** → confirm at **"Clear — ₹…"** → a report saying
      "Cleared N of N", listing by name any row it skipped and why. A row whose
      amount moved is skipped, never cleared at the wrong figure.
- [ ] **People** (`/people`) — create an account, reset a password (which also
      unlocks a locked one).
- [ ] **Profile requests**, **Imports**, **Reference data**, **Monthly runs**,
      **Faults**, **Duplicates** all load and are not empty for no reason.
- [ ] **Audit log** (`/audit`) shows what happened, to what, by whom, with the
      detail expandable and the filters working.

---

## Principal

- [ ] **Approvals** (`/approvals`) holds everything cleared and not yet
      approved. Search is "Search the queue"; there are department, sort and
      waiting-time filters, and the totals are over everything the filter
      matched, not just the page.
- [ ] **Approve** → confirm button reads **"Approve — ₹…"**, the same figure
      the research cell cleared.
- [ ] **Send back** returns it to the research cell with a required reason —
      and that reason is readable afterwards on the ticket, not silently
      dropped.
- [ ] **Bulk approve** — select several, **Approve N tickets**, confirm at
      **"Approve — ₹…"**, and read the report. Rows that will still need a
      second signature are called out before you press, not after.

---

## Director

- [ ] **Authorisations** (`/authorisations`) holds everything the Principal has
      approved. It is a list, not a table.
- [ ] **Authorise** → confirm at **"Authorise ₹…"**, the same figure again.
- [ ] **Send back to the Principal** requires a reason.
- [ ] **Bulk authorise** — "Select all N on this page", then **Authorise N** →
      the dialog shows the total being released and across how many claims,
      warns about any still needing a second signature, takes an optional note,
      and confirms at **"Authorise ₹…"**.
- [ ] **Ledger** (`/ledger`) is reachable and its month and department pickers
      work.

---

## Finance

- [ ] **Payment orders** (`/payments`) lists what is authorised and payable.
      Below `md` the same rows become cards — check that on a phone.
- [ ] A claim needing a **second signature** shows as such and its **Pay**
      button and its checkbox are both disabled. It cannot be paid or selected
      into a batch.
- [ ] **Pay** → confirm at **"Pay — ₹…"**, with a voucher number.
- [ ] **Bulk pay** — select several, **Pay N claims** → a review table with one
      row per claim, its own voucher box and its own amount, and a confirm
      button reading **"Pay N — ₹…"**. Afterwards the dialog says "Paid N of
      N"; a skipped row keeps the voucher you typed and says why it was
      skipped.
- [ ] **Processed payments** (`/payments/done`) lists what has gone out, at the
      figures confirmed. **Void** writes a reversing ledger row rather than
      deleting anything.
- [ ] **Ledger** month/department pickers and CSV export; **Reports** Excel
      export.

---

## Head of department

The strongest rule in the product: **a head of department is never shown an
amount, anywhere, by any route.**

- [ ] **My department** (`/department`) has real content on it — targets,
      people, standing, publications — and not one rupee sign.
- [ ] **Publications**, **Reports**, **Journals** load, carry figures (counts,
      quartiles, SNIP), and no money.
- [ ] **Search** a paper your department has already filed: you find the claim,
      you see its stage, and there is no amount beside it.
- [ ] There is no Clearing queue, no Approvals, no Payments and no Ledger in
      the sidebar, and typing `/payments` says "Not open to this account" —
      which is a different sentence from "no such page", and correct.

---

## Known gaps, so a walker does not report them twice

These are open at the time of writing. Confirm they are still true rather than
raising them again; if one of them is fixed, delete the line.

- **`/search` returns nothing for anybody.** The page ships in every role's
  sidebar but `GET /api/search` is not registered — every query answers
  "The search did not run · Request failed (404)". Every search line above is
  blocked on this.
- **A first-time claimant gets the wrong refusal.** Filing with references that
  carry no numbers is correctly refused, but a claimant who has never entered a
  reference number on that claim is refused with "Complete these before
  submitting: Reference numbers with SEC affiliation" — the name of a field
  that is not on the form — instead of the message that says what to attach and
  why. The good message only appears once a number has been entered on that
  claim before.
- **A failing test run can kill the dev server.** Vite watches
  `frontend2/e2e/.artifacts/`, where Playwright writes traces; on Windows the
  open trace file gives `EBUSY` and the watcher takes the dev server down with
  it. Every test after that point fails with `ECONNREFUSED`. Run with
  `--trace off` if you are chasing something else.
