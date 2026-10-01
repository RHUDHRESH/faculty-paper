# Product

<!-- impeccable:product-schema 1 -->

Register: **product** (impeccable's Operate mode). Every screen is a tool somebody uses to finish a
job. The sign-in page is the one brand surface (Persuade, lightly). Visual decisions live in
DESIGN.md; the rationale and the options considered live in docs/design/art-direction.md.

## Platform

web (responsive; phones at 390 px are first-class, because most faculty use the app on a phone)

## Users

Saveetha Engineering College, Thandalam, Chennai: an autonomous college affiliated to Anna
University. About 412 teaching staff in 22 departments, the officers who handle their claims, and
the administrators who keep the system right.

| Who | Situation | The job in one line |
|---|---|---|
| **Faculty** (every teacher; research faculty are faculty with a yearly rupee threshold) | On a phone between classes, or at a desk once a month | Get paid for a paper with the least effort, know where the claim is, keep my record right, show it for appraisal. |
| **Head of department** | A faculty member first, plus a department to watch (never sees money) | See how my department is doing and who has papers waiting. |
| **Research cell and research coordinator** (the research office) | At a desk all day, clearing a queue of claims by keyboard | Check each claim on the facts and clear it or send it back, oldest first, without missing one. |
| **Principal** | Briefly, a few times a week | Approve the spend on claims the office cleared; know how the year is going. |
| **Director** | Briefly, with a signature | Authorise approved claims against the institution's position; sign the month's statement. |
| **Finance** | At a desk, in a monthly run | Pay what was authorised, once, at the right amount; keep the ledger honest. |
| **Super admin** | Keeping the whole thing running | Is anything broken or stuck; keep the people, the record, the money rules and the machinery right. |

The five views this redesign covers first: Faculty, Research faculty (the research office and the
research-faculty threshold), Admin, Principal, Director. Head of department and Finance share the
same kit.

## Product Purpose

File a published paper once and watch one claim travel a fixed chain of desks until the incentive
is paid: **Filed, Checked, Approved, Authorised, Paid.** The amount comes from a policy (Scopus
quartile and the claim's facts); research faculty are paid only above their threshold. Success is
a faculty member who never has to ask where their claim is, an office that never loses one, and
a Principal and Director who spend minutes, not hours.

## Positioning

A neighbouring product cannot truthfully copy these: the chain is the college's own (five named
steps, one person per step, no desk names shown to the claimant); the record is read from Scopus
and the college's ERP workbook, so a faculty member picks a paper and almost everything fills
itself; every amount is explained line by line from the policy version in force.

## Operating Context

- Papers come from Scopus and OpenAlex (monthly run) and from the ERP workbook the college already
  keeps (Publication_Processing_ERP).
- Claim numbers look like FP-2026-000001; imported ERP rows carry ERP-RAW-n and say so.
- Money is rupees in Indian grouping (₹1,09,265), by financial year (April to March), paid in a
  monthly run with a voucher and a ledger row.
- The office works from a queue (j/k, x, Enter) on a desktop; everyone else on a phone.
- The Principal and the Director each sign a piece of paper outside the app; the app prints the
  statement they sign.

## Capabilities and Constraints

- One vocabulary (docs/ux/19): paper, claim, incentive, Clear, Approve, Authorise, Pay, Send back,
  Reject. Sentence case, plain Indian English. No internal codes on screen.
- Faculty never see which desk holds a claim, only the stage and how long it has waited.
- Every view answers one question first, then holds the work, then offers detail one step away
  (docs/ux/22). Counts are real numbers, never "99+". A missing value says "Not recorded".
- Faces wherever a person appears. Photographs come from the server (`photo_url`); initials are the
  fallback, never a placeholder.
- Light and dark themes, printable statements (white paper, black ink), reduced motion respected.
- Stack: Vite, React 19, Tailwind v4, Radix primitives, Lucide icons, Inter and Brygada 1918
  (self-hosted, with a rupee subset of each).

## Brand Commitments

- The Saveetha emblem and wordmark appear only as supplied (`public/brand/`). The college's own
  colours are navy and a golden yellow.
- The owner asked that the app **look and feel like claude.ai**: warm paper, calm serif, one clay
  accent, hairlines instead of boxes. This is a pinned commitment; the art direction deepens it
  and does not abandon it.
- The owner asked for **faces everywhere** and for the **generated illustrations to be used**
  (213 drawings in `frontend2/public/illustrations/generated`, made on the owner's account in one
  hand: ink line, flat fills, navy, sage, clay, sand).
- The owner asked that the site be **elegant and look like an artwork**, while making every job
  easier and simpler.

## Evidence on Hand

- A copy of the college's real data (8,466 papers, 2,801 payments, real names and photos in
  `backend/media/avatars`) for screenshots; never commit it.
- docs/jtbd/* (jobs by role), docs/ux/* (page specs, vocabulary, clarity audit),
  docs/audit/final-sweep.md (658 routes by 8 roles, with screenshots).
- Not on hand and not to be invented: testimonials, the college's brand guidelines, a Tamil
  translation.

## Product Principles

1. **The answer first.** Each view's top says the one thing the person came to learn, in the
   biggest type on the page; the work is below; detail is one step away and says where it is.
2. **A person, not a row.** A name is always a face, and a decision is always about someone.
3. **Say what happens.** Buttons name their action and the toast uses the same verb; a zero says
   what it means; an empty state names the one next thing.
4. **Quiet by default, bold once.** Space, hairlines and weight do the work; boldness is spent on
   the type of the page's answer and on the picture of the chain.
5. **Ordinary for the first time user.** A lecturer on a phone completes the main job without
   reading anything.

## Anti-goals

- Not a dashboard of cards: no wall of equal tiles, no neon, no glass, no gradient text.
- Not a gamified app: badges and celebrations are rare, quiet and never block work.
- Not a stack of effects: one authored moment (the stamp on a decision), nothing that moves
  between pages.
- Not a costume of India: no rangoli wallpaper, no kitsch borders; local identity is the
  college's own colours, the rupee, the faces and the hand-drawn pictures.
- Not a rebrand: the emblem, the words and the chain stay exactly as the college has them.

## Accessibility & Inclusion

WCAG 2.2 AA. Text 4.5:1 on every surface step, large text 3:1, focus ring always visible, 40 px
minimum tap target on phones, no horizontal scroll at 390 px, keyboard-complete, reduced motion
honoured, status never by colour alone. Indian number grouping and en-IN dates throughout. The
faculty population includes people who are not comfortable with software; plain words beat
clever ones.
