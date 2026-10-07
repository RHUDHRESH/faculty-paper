import type { Role } from "@/app/auth"

/**
 * Short task guides, written from each role's real jobs (docs/jtbd). One
 * source for the Help page, the first-sign-in welcome, the printable quick
 * guide and the hints under empty states, so the four never disagree.
 */
export type Guide = {
  id: string
  title: string
  /** One plain sentence: when you would do this. */
  when: string
  steps: string[]
  /** The page that does it. */
  to: string
  cta: string
  /** Honest notes that belong beside the steps (the filing conditions). */
  notes?: string[]
}

const FILE: Guide = {
  id: "file-a-paper",
  title: "File a paper",
  when: "You have a journal paper that is in Scopus and you want the college incentive for it.",
  steps: [
    "Open File a paper.",
    "Pick the paper from your Scopus list, or search for it by title or DOI.",
    "Read the three conditions below and tick each one only if it is true.",
    "Attach the published article PDF and the cited reference PDFs, each with its reference number.",
    "Check the estimate and press File it. You get a claim number straight away.",
  ],
  notes: [
    "The paper must already be indexed in Scopus and show on your own Scopus author profile. If it is not indexed yet, wait: a claim filed early cannot be processed and has to be filed again.",
    "Nobody may have claimed this paper before, you or a co-author here. Duplicates are found against the paid ledger and sent back.",
    "You need the article PDF and the college-affiliated cited references the policy asks for. The form tells you how many. Too few references means the claim is recorded but pays nothing, so gather them first. The form saves as you type.",
  ],
  to: "/papers/new",
  cta: "File a paper",
}

const TRACK: Guide = {
  id: "where-is-my-claim",
  title: "Find out where my claim is",
  when: "You filed a paper and want to know if it is moving, or when the money comes.",
  steps: [
    "Open Home for the short answer, or My claims for every claim.",
    "Each claim shows its stage (Submitted, Being checked, Approved for payment, Paid), how long ago you filed it, and what, if anything, is needed from you.",
    "If a claim says Sent back, open it, read what to change, fix each item and send it again.",
    "You get a notification when it is paid. Nothing else is needed from you.",
  ],
  to: "/papers/claims",
  cta: "Open My claims",
}

const STATEMENT: Guide = {
  id: "payment-statement",
  title: "Get my payment statement for tax",
  when: "You are filing your income tax return and need what the college paid you in a financial year (April to March).",
  steps: [
    "Open Payment statement.",
    "Choose the financial year.",
    "Press Print for a PDF, or Download for a spreadsheet.",
  ],
  to: "/papers/statement",
  cta: "Open payment statement",
}

const APPRAISAL: Guide = {
  id: "appraisal-list",
  title: "Make my publication list for appraisal",
  when: "You are filling the PBAS or CAS promotion form, or checking PhD supervisor eligibility.",
  steps: [
    "Open Publication list.",
    "Set the year range the form asks for.",
    "Tick Journal papers only if you are counting papers for supervisor recognition.",
    "Print it to PDF or download it as a spreadsheet.",
  ],
  to: "/papers/appraisal",
  cta: "Open publication list",
}

const CLEAR: Guide = {
  id: "clear-a-claim",
  title: "Clear a claim",
  when: "A faculty claim is waiting at the research office desk.",
  steps: [
    "Open Clearing. The oldest claim is at the top.",
    "Open a claim. Compare what the faculty member wrote with what the record says: Scopus indexing, quartile for that year, college affiliation and author position.",
    "If everything matches, press Clear. It moves to the Principal.",
    "If something is wrong but fixable, press Send back and write the reason in one plain sentence. The faculty member sees it.",
    "Your own claims never appear here. Somebody else clears them.",
  ],
  to: "/clearing",
  cta: "Open clearing",
}

const DUPES: Guide = {
  id: "duplicates",
  title: "Stop a double payment",
  when: "The same paper may have been claimed twice, or by two co-authors here.",
  steps: [
    "Open Duplicates.",
    "Each pair shows both claims and whether either has been paid.",
    "Confirm the duplicate to reject it, or dismiss it if they are different papers.",
  ],
  to: "/duplicates",
  cta: "Open duplicates",
}

const MONTH_REPORT: Guide = {
  id: "month-report",
  title: "Report the month to the Principal",
  when: "It is the end of the month and the Principal wants to know how many claims came in and how fast they moved.",
  steps: [
    "Open Reports.",
    "Pick the month.",
    "Download the processing report as PDF or spreadsheet.",
  ],
  to: "/reports",
  cta: "Open reports",
}

const QUOTA: Guide = {
  id: "research-quota",
  title: "Set a research threshold",
  when: "A research faculty member's first incentives each year are part of their duty and are not paid.",
  steps: [
    "Tick research faculty on the person's page in People.",
    "Open Research faculty and set their threshold in rupees a year, with a short note.",
    "Their claims then show what counts against the threshold, and only what is above it is paid.",
  ],
  to: "/research-faculty",
  cta: "Open research faculty",
}

const APPROVE: Guide = {
  id: "approve-claims",
  title: "Approve cleared claims",
  when: "The research office has checked claims and they are waiting for you.",
  steps: [
    "Open Approvals. The oldest claim is first.",
    "Open a claim to see what the research office checked and the amount.",
    "Press Approve, or Send back with a reason, or Hold if you need to ask something.",
  ],
  to: "/approvals",
  cta: "Open approvals",
}

const BRIEF: Guide = {
  id: "council-brief",
  title: "Download the council brief",
  when: "The governing council or trustees want the year's research in one or two pages.",
  steps: [
    "Open Year brief.",
    "Choose the year.",
    "Press Print for an A4 PDF with the college header, or download the spreadsheet for the department table.",
  ],
  to: "/reports/brief",
  cta: "Open year brief",
}

const NAAC: Guide = {
  id: "naac",
  title: "Get the NAAC and NIRF figures",
  when: "The IQAC needs papers per teacher and the per-paper list for Criterion 3.",
  steps: [
    "Open Accreditation.",
    "Choose the assessment years.",
    "Download the sheet. It is already in the NAAC column order.",
  ],
  to: "/accreditation",
  cta: "Open accreditation",
}

const AUTHORISE: Guide = {
  id: "authorise-the-month",
  title: "Authorise the month",
  when: "The Principal has approved claims and they need your authorisation before Finance can pay.",
  steps: [
    "Open Authorisations. The total and what is left in the budget are at the top.",
    "Tick the claims you authorise, or all of them.",
    "Press Authorise. Finance can now pay exactly these, and nothing else.",
  ],
  to: "/authorisations",
  cta: "Open authorisations",
}

const SIGN_STATEMENT: Guide = {
  id: "payout-statement",
  title: "Sign the monthly payment statement",
  when: "The month's payments are done and the accounts need a signed statement.",
  steps: [
    "Open Statements.",
    "Pick the month.",
    "Print it on A4. It carries the college header, department subtotals, the total in words and a signature block.",
  ],
  to: "/statements",
  cta: "Open statements",
}

const BUDGET: Guide = {
  id: "budget",
  title: "Check the budget",
  when: "You want to know how much of this year's allocation is paid, committed and left.",
  steps: ["Open Budget.", "Read the top line: paid, committed, left.", "The chart shows spend by month for the financial year."],
  to: "/budget",
  cta: "Open budget",
}

const PAY: Guide = {
  id: "pay-claims",
  title: "Pay authorised claims",
  when: "The Director has authorised claims and they are ready to pay.",
  steps: [
    "Open Payments. Only authorised claims appear.",
    "Check the batch total against the statement.",
    "Enter the voucher and press Pay, for one claim or the confirmed batch.",
    "Download the bank file for the month if you pay through NEFT or payroll.",
  ],
  to: "/payments",
  cta: "Open payments",
}

const LEDGER: Guide = {
  id: "reconcile",
  title: "Reconcile with the accounts",
  when: "You want every paid claim to have exactly one ledger row for the same amount.",
  steps: [
    "Open Ledger.",
    "Filter to the month.",
    "Download it and match it against your accounts. A mismatch goes to the super admin; Finance cannot undo a payment.",
  ],
  to: "/ledger",
  cta: "Open ledger",
}

const DEPT: Guide = {
  id: "department-target",
  title: "See if my department is on target",
  when: "You want to know if the department is ahead or behind for this year, and who needs a push.",
  steps: [
    "Open Department.",
    "The top line says how many papers against the target, at this point in the year.",
    "The list below shows each teacher with this year's papers. Those with none are at the top.",
  ],
  to: "/department",
  cta: "Open department",
}

const DEPT_REPORT: Guide = {
  id: "department-report",
  title: "Report the department to the Principal",
  when: "It is the monthly review and you need a one-page account.",
  steps: ["Open Reports.", "Choose your department and the year.", "Print the A4 report or download the spreadsheet."],
  to: "/reports",
  cta: "Open reports",
}

const PEOPLE: Guide = {
  id: "people-and-roles",
  title: "Add a person or change a role",
  when: "Somebody joined, left, or took over a desk this term.",
  steps: [
    "Open People and search for the person, or press Add.",
    "Change the role, reset the password or deactivate them. Their papers always stay on record.",
    "Every change is written to the audit log.",
  ],
  to: "/people",
  cta: "Open people",
}

const IMPORT: Guide = {
  id: "imports",
  title: "Import a file",
  when: "You have an ERP export or a payment history to load.",
  steps: ["Open Imports.", "Upload the file and read the preview. Nothing is saved yet.", "Press Import if the preview is right, or fix the file."],
  to: "/imports",
  cta: "Open imports",
}

const HEALTH: Guide = {
  id: "data-health",
  title: "Check data health and backups",
  when: "You want to know that nothing is broken and a recent backup exists.",
  steps: ["Open Data health.", "Run a named fix for any problem it lists.", "Take a backup now and download it."],
  to: "/data/health",
  cta: "Open data health",
}

const AUDIT: Guide = {
  id: "audit",
  title: "Find out who changed what",
  when: "Somebody asks who touched a claim or a person, and when.",
  steps: ["Open Audit.", "Filter by person, claim or dates.", "Download the result for the auditor."],
  to: "/audit",
  cta: "Open audit",
}

export const ALL_GUIDES: Guide[] = [
  FILE, TRACK, STATEMENT, APPRAISAL, CLEAR, DUPES, MONTH_REPORT, QUOTA, APPROVE, BRIEF, NAAC,
  AUTHORISE, SIGN_STATEMENT, BUDGET, PAY, LEDGER, DEPT, DEPT_REPORT, PEOPLE, IMPORT, HEALTH, AUDIT,
]

const CLAIMANT = [FILE, TRACK, STATEMENT]

/** Per role, most-done first. The first three are the welcome. */
export const ROLE_GUIDES: Record<Role, Guide[]> = {
  FACULTY: [FILE, TRACK, STATEMENT, APPRAISAL],
  HOD: [DEPT, DEPT_REPORT, FILE, TRACK, APPRAISAL],
  RESEARCH_CELL: [CLEAR, DUPES, MONTH_REPORT, ...CLAIMANT],
  RESEARCH_COORDINATOR: [CLEAR, QUOTA, MONTH_REPORT, ...CLAIMANT],
  PRINCIPAL: [APPROVE, BRIEF, NAAC, ...CLAIMANT],
  DIRECTOR: [AUTHORISE, SIGN_STATEMENT, BUDGET, ...CLAIMANT],
  FINANCE: [PAY, LEDGER, BUDGET, ...CLAIMANT],
  SUPER_ADMIN: [PEOPLE, IMPORT, HEALTH, AUDIT],
}

/** One line on what this role is for, at the top of the welcome and the print sheet. */
export const ROLE_INTRO: Record<Role, string> = {
  FACULTY: "Home tells you in one sentence whether anything is needed from you and when your money is due. You file your papers here and can always see how far each claim has come.",
  HOD: "You see how your department is doing against its target, and you file your own papers like anyone else.",
  RESEARCH_CELL: "You are the first desk. You check each claim against the record before it goes to the Principal.",
  RESEARCH_COORDINATOR: "You clear claims at the research office, and you own the research threshold and final-year project rules.",
  PRINCIPAL: "You approve claims the research office has cleared, and you report the college's research upward.",
  DIRECTOR: "You authorise approved claims against the budget, so Finance can pay them.",
  FINANCE: "You pay what the Director authorised and keep the ledger matching the accounts.",
  SUPER_ADMIN: "You keep people, data and money right, and the system running.",
}

export function guidesFor(role: Role | undefined): Guide[] {
  return role ? ROLE_GUIDES[role] : []
}

export function guideById(id: string): Guide | undefined {
  return ALL_GUIDES.find((g) => g.id === id)
}
