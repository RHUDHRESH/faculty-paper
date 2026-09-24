/**
 * Readiness -- one list of everything wrong with a claim, computed once.
 *
 * Moved out of `file-paper.tsx` with its rules intact. The wizard blocks a
 * step on exactly the `missing` problems whose `step` is that step, shows the
 * reason beside the field that owns it, and prices the `unpaid` ones in the
 * estimate panel -- so the kinds below are the whole contract.
 */
import { doiProblem, issnProblem, yearOf } from "./identifiers"
import type { AttachmentRow, CalcResult, CarriedEvidence, FilingRules, FormState } from "./types"

/**
 * Three kinds of problem, and the difference between the second and the third
 * is the whole point of the estimate panel.
 *
 * - `missing`  the server will refuse to file it. Must be fixed.
 * - `unpaid`   it will file perfectly well and pay **nothing**. The policy
 *              counts the publication and awards no money — for too many
 *              authors, or too few SEC-affiliated references.
 * - `check`    worth a second look but nobody is wrong: a possible earlier
 *              payment, a year that disagrees with the index.
 */
export type ProblemKind = "missing" | "unpaid" | "check"

export type Problem = {
  key: string
  kind: ProblemKind
  label: string
  detail?: string
  /**
   * Show this one whether or not the reader has reached the step that
   * answers it. A finding that only exists *because* a check ran -- Scopus
   * has no such paper, the paper's record names someone else -- cannot be
   * premature by construction.
   */
  always?: boolean
  /** The step that fixes it, so the reader can be sent straight there. */
  step: number
}

export const PROBLEM_STYLE: Record<ProblemKind, { tone: "critical" | "caution" | "info"; word: string }> = {
  missing: { tone: "critical", word: "Needed" },
  unpaid: { tone: "caution", word: "Pays nothing" },
  check: { tone: "info", word: "Worth checking" },
}

/**
 * The files on this form that are the same file twice.
 *
 * A file's own bytes say whether it has been seen before, so renaming it
 * changes nothing -- a scan saved twice comes out `scan.pdf` and
 * `scan (1).pdf` and looks like two pieces of evidence. Keyed on the later of
 * the pair, valued with what to call the earlier one, so the message points
 * at the copy the claimant is looking at.
 */
export function sameFileOnThisForm(rows: AttachmentRow[]): Map<string, string> {
  const firstByHash = new Map<string, AttachmentRow>()
  const out = new Map<string, string>()
  let referenceSeen = 0
  const nameFor = new Map<string, string>()

  for (const row of rows) {
    if (row.kind === "SEC_REFERENCE") referenceSeen += 1
    nameFor.set(
      row.url,
      row.kind === "PUBLISHED_PAPER"
        ? "the published paper"
        : (row.ref_number || "").trim()
          ? `reference ${(row.ref_number || "").trim()}`
          : `reference ${referenceSeen} in the list above`
    )
  }

  for (const row of rows) {
    const hash = (row.content_hash || "").trim()
    if (!hash) continue
    const first = firstByHash.get(hash)
    if (first) out.set(row.url, nameFor.get(first.url) || first.filename)
    else firstByHash.set(hash, row)
  }
  return out
}

/**
 * Why an estimate came out at zero, in the claimant's own terms. A bare "₹0"
 * is read as a bug and ignored.
 */
export function zeroReason(calc: CalcResult, problems: Problem[]): string {
  const unpaid = problems.filter((p) => p.kind === "unpaid")
  if (unpaid.length > 0) {
    return `${unpaid.map((p) => p.detail || p.label).join(" ")}${
      calc.note ? ` The formula's own note: ${calc.note}` : ""
    }`
  }
  return (
    calc.note ||
    "The policy prices this paper at nothing. That is usually a journal we hold no SNIP or quartile for, or a publication type the scheme does not pay for. The paper is still recorded."
  )
}

export function readiness(
  form: FormState,
  rules: FilingRules,
  opts: {
    calc: CalcResult | null
    calcFailed: boolean
    priorWarning: boolean
    indexedYear: number | null
    /** Which source that year came from, said in the sentence: "OpenAlex
     *  says 2025" is a different claim from "Scopus says 2025". */
    indexedYearSource?: string | null
    /** What the server currently holds in proof_url / sec_proof_url /
     *  sec_refs — the three values that let a claim file and pay nothing. */
    carried: CarriedEvidence
    scimagoQuartile: string | null
    scopusConfirmed: boolean
    /** From the pre-submission check. `null` means it was not run, or ran
     *  with no author ID — which is not the same as "not linked". */
    linkedToAuthor: boolean | null
    /** `false` only when the check ran and Scopus did not hold the paper. */
    verifiedIndexed: boolean | null
    /** Where the paper's own record puts the claimant, when the lookup was
     *  sure enough to say. */
    lookupPosition?: number | null
    /** What the paper's record says about the college, from the lookup. */
    lookupAffiliation?: {
      status: string
      claimant_status: string | null
      text: string | null
    } | null
    collegeName?: string
  }
): Problem[] {
  const out: Problem[] = []
  const add = (p: Problem) => out.push(p)
  const college = opts.collegeName || "the college"
  // A count-only filing is never paid, so "this pays nothing" is not news
  // about it — the eligibility warnings below downgrade to a note.
  const paid = form.claimReason !== "COUNT_ONLY"
  const unpaidKind: ProblemKind = paid ? "unpaid" : "check"
  // Short of `min_sec_references` numbered references, a paid claim is
  // *refused* at submission rather than ticketed at zero, so these block. A
  // count-only filing is exempt on the server, so it stays a note there.
  const refusedKind: ProblemKind = paid ? "missing" : "check"

  /* ---- step 0: the paper ---- */
  if (!form.paperTitle.trim())
    add({ key: "title", kind: "missing", label: "The paper needs a title", step: 0 })
  if (!form.publicationType)
    add({ key: "type", kind: "missing", label: "Choose what kind of publication this is", step: 0 })
  if (!form.publicationDate)
    add({ key: "date", kind: "missing", label: "Enter the date it was published", step: 0 })

  const doiIssue = doiProblem(form.doi)
  if (doiIssue) add({ key: "doi", kind: "missing", label: doiIssue, step: 0 })

  const enteredYear = yearOf(form.publicationDate)
  if (enteredYear && opts.indexedYear && enteredYear !== opts.indexedYear) {
    add({
      key: "year",
      kind: "check",
      label: `You entered ${enteredYear}; ${opts.indexedYearSource || "the index"} says ${opts.indexedYear}`,
      detail:
        "The research cell checks the year against the index, and a mismatch is what sends a paper back. Online-first and print dates often differ — use the one the index carries if you can.",
      step: 0,
    })
  }

  // The server refuses a student-project claim that names no team, and the
  // team has to already exist. Asked on the first step, beside the reason.
  if (form.claimReason === "STUDENT_PROJECT" && !form.teamCode.trim())
    add({
      key: "team",
      kind: "missing",
      label: "A student project claim has to name the team",
      detail:
        "Enter the code from the project sheet and check the students it brings back. The team has to exist already — this claim cannot create one.",
      step: 0,
    })

  /* ---- step 1: the journal ---- */
  if (!form.journalTitle.trim())
    add({ key: "journal", kind: "missing", label: "The journal needs a title", step: 1 })
  const issnIssue = issnProblem(form.issn)
  if (!form.issn.trim())
    add({ key: "issn", kind: "missing", label: "Enter the journal's ISSN", step: 1 })
  else if (issnIssue)
    add({ key: "issn", kind: "missing", label: issnIssue, step: 1 })
  if (form.indexing.length === 0)
    add({ key: "indexing", kind: "missing", label: "Select at least one indexing level", step: 1 })
  if (form.indexing.includes("AU Annexure") && !form.auAnnexureRef.trim())
    add({
      key: "au",
      kind: "missing",
      label: "AU Annexure needs its reference number (NA if there is none)",
      step: 1,
    })
  if (form.indexing.includes("UGC Care") && !form.ugcCareRef.trim())
    add({
      key: "ugc",
      kind: "missing",
      label: "UGC Care needs its reference number (NA if there is none)",
      step: 1,
    })
  if (!form.yukthiId.trim())
    add({ key: "yukthi", kind: "missing", label: "Enter the Yukthi ID, or NA", step: 1 })

  // Not "missing": the server's refusal for a quartile it cannot confirm is
  // the contestable kind, so a note gets the claim through.
  if (!form.selfReportedQuartile && !opts.scimagoQuartile)
    add({
      key: "quartile",
      kind: "check",
      label: "No journal quartile — filing will be refused without one",
      detail:
        "Filing looks the journal up in Scimago. If it finds no ranking, the claim is refused unless you send it with a short note. Run “Check Scimago” on this step to find out now rather than at the end.",
      step: 1,
    })

  /* ---- step 2: the authors ---- */
  if (!form.scopusAuthorUrl.trim())
    add({ key: "scopus", kind: "missing", label: "Add your Scopus author profile link", step: 2 })
  // Indexed, but not against their author ID. Not `missing` — the fix is at
  // Scopus's end, not on this form, so refusing to file would only trap them.
  else if (opts.linkedToAuthor === false)
    add({
      key: "linkage",
      kind: "check",
      always: true,
      label: "The article is indexed, but not on your Scopus author profile",
      detail:
        "The rules require the paper to sit on your own profile, and the research cell checks it against the same source. Merge or link it with the Scopus Author Feedback Wizard before you file, or correct the profile link above if this is not your ID.",
      step: 2,
    })
  if (!form.totalAuthors || form.totalAuthors < 1)
    add({ key: "authors", kind: "missing", label: "Enter how many authors the paper has", step: 2 })
  else if (form.authorPosition < 1 || form.authorPosition > form.totalAuthors)
    add({
      key: "position",
      kind: "missing",
      label: `Your position must be between 1 and ${form.totalAuthors}`,
      step: 2,
    })
  else if (form.totalAuthors > rules.max_authors)
    add({
      key: "author-cap",
      kind: "unpaid",
      label: `${form.totalAuthors} authors is over the limit of ${rules.max_authors}`,
      detail: rules.why.max_authors,
      step: 2,
    })
  if (opts.lookupPosition && opts.lookupPosition !== form.authorPosition)
    add({
      key: "position-found",
      kind: "check",
      always: true,
      label: `The paper lists you as author ${opts.lookupPosition}; this claim says ${form.authorPosition}`,
      detail:
        "Your position is part of the amount, and the research cell checks it against the paper. Pick the right name in the author list.",
      step: 2,
    })
  if (!form.affiliationOk)
    add({
      key: "affiliation",
      kind: "missing",
      label: "Confirm the article is affiliated to the college",
      step: 2,
    })
  const found = opts.lookupAffiliation
  if (found) {
    const label =
      found.status === "other"
        ? `The paper names “${found.text}”, not ${college}`
        : found.status === "no"
          ? `The paper's affiliations do not name ${college}`
          : found.claimant_status === "no" || found.claimant_status === "other"
            ? `${college} is on the paper, but not beside your name`
            : null
    if (label)
      add({
        key: "affiliation-found",
        kind: "check",
        always: true,
        label,
        detail:
          "Read from the paper's published record. The affiliation printed on the article has to read the college's own name, and a different form of it is what the research cell sends papers back for.",
        step: 2,
      })
  }

  /* ---- step 3: the proof ---- */
  const papers = form.attachments.filter((a) => a.kind === "PUBLISHED_PAPER")
  const refs = form.attachments.filter((a) => a.kind === "SEC_REFERENCE")
  // The count the money is worked out from: the payout formula counts
  // SEC_REFERENCE attachments that carry a `ref_number` and nothing else.
  const numbered = refs.filter((r) => (r.ref_number || "").trim()).length

  if (papers.length === 0) {
    if (opts.carried.proofUrl)
      add({
        key: "paper-file",
        kind: "check",
        label: "The published paper is a link on the claim, not an attached file",
        detail:
          "That is enough to file — the submission check accepts either. Attach the article itself if you have it, so the research cell is not chasing a link.",
        step: 3,
      })
    else
      add({
        key: "paper-file",
        kind: "missing",
        label: "Attach the full-length published paper",
        step: 3,
      })
  }

  // The server applies two separate checks satisfied by different things:
  // one wants evidence to exist (an attachment OR a URL), the other a
  // non-empty `sec_refs` string. Only when BOTH pass while no attachment
  // carries a number does a claim file and pay nothing -- so they are tested
  // apart here.
  const passesEvidenceGate = refs.length > 0 || Boolean(opts.carried.secProofUrl)
  const passesNumberGate = numbered > 0 || Boolean(opts.carried.secRefs)

  if (!passesEvidenceGate) {
    add({
      key: "refs-none",
      kind: "missing",
      label: "Attach at least one cited reference with SEC affiliation",
      step: 3,
    })
  } else if (!passesNumberGate) {
    add({
      key: "ref-numbers",
      kind: "missing",
      label:
        refs.length === 0
          ? "Attach the cited SEC references themselves — a link carries no reference numbers"
          : "Every cited reference needs its reference number",
      detail:
        "The number is not a label on the file. It is the only thing that makes the file count towards the amount, and the claim is refused without at least one.",
      step: 3,
    })
  } else if (numbered === 0) {
    if (refs.length === 0)
      add({
        key: "refs-url-only",
        kind: refusedKind,
        label: "Your SEC references are a link, not attached files",
        detail:
          "A link carries no reference numbers, and the amount is counted only from attached reference files that have one. The submission check no longer accepts a link in their place — it would file a claim that priced at nothing. Attach each cited SEC reference and give it the number it has in your reference list.",
        step: 3,
      })
    else
      add({
        key: "ref-numbers-zero",
        kind: refusedKind,
        label: "No attached reference carries a reference number",
        detail: `Reference numbers left on the claim from an earlier version (${opts.carried.secRefs}) no longer stand in for the files themselves — they are a note, and nobody can check a number against a file that was never attached. The amount counts only the files attached here that carry a number, and none of them do. Put each reference's number from your reference list beside its file.`,
        step: 3,
      })
  } else if (numbered < refs.length) {
    add({
      key: "ref-numbers-some",
      kind: unpaidKind,
      label: `${refs.length - numbered} of ${refs.length} attached references have no reference number`,
      detail:
        "A reference with no number files perfectly well and is priced as though it were not attached. Give each one the number it has in your reference list.",
      step: 3,
    })
  }

  if (numbered > 0 && numbered < rules.min_sec_references)
    add({
      key: "refs-few",
      kind: refusedKind,
      label: `${numbered} numbered SEC reference${numbered === 1 ? "" : "s"} counted; the policy needs ${rules.min_sec_references}`,
      detail: `${rules.why.min_sec_references} Below that the claim is refused rather than filed, because filing it would work out at ₹0. If you have no more to cite, file it as a publication count instead.`,
      step: 3,
    })

  const twice = sameFileOnThisForm(form.attachments)
  const twiceRow = form.attachments.find((a) => twice.has(a.url))
  if (twiceRow)
    add({
      key: twiceRow.kind === "SEC_REFERENCE" ? "file-twice-ref" : "file-twice",
      kind: "check",
      label: `“${twiceRow.filename}” is the same file as ${twice.get(twiceRow.url)}`,
      detail:
        "The same document is attached twice — a file's own bytes say so, whatever it was renamed to. Remove one of the two, or attach the file that should have gone there.",
      step: 3,
    })

  // The other thing a matching fingerprint means: this file is on somebody's
  // other ticket. A warning, because one paper genuinely cited on two claims
  // is a real thing.
  const dupFile = form.attachments.find((a) => a.duplicateOf)
  if (dupFile?.duplicateOf)
    add({
      key: dupFile.kind === "SEC_REFERENCE" ? "file-dup-ref" : "file-dup",
      kind: "check",
      label: `“${dupFile.filename}” is already attached to another paper`,
      detail: dupFile.duplicateOf.same_owner
        ? `It is on ${dupFile.duplicateOf.ticket_number || "another of your papers"}. That is allowed — the same reference can be cited by two papers — but attaching the same evidence twice is what a duplicate-payment check looks for, so make sure it is deliberate.`
        : `It is on ${dupFile.duplicateOf.ticket_number || "a claim"} filed by ${dupFile.duplicateOf.owner_name}. That is allowed if the same paper is genuinely cited again; the research cell sees the same fingerprint from its side.`,
      step: 3,
    })

  /* ---- step 4: what it comes to ---- */
  if (opts.priorWarning)
    add({
      key: "prior",
      kind: "check",
      label: "This paper may already have been paid for",
      detail: "Look at the matches before filing. You can still go ahead once you have.",
      step: 4,
    })
  // A recently published paper is very often not in the index yet, and the
  // refusal that follows reads like a rejection. Saying so first makes the
  // note it asks for an expected step rather than a setback.
  const published = form.publicationDate ? Date.parse(form.publicationDate) : NaN
  const recentlyPublished =
    Number.isFinite(published) && Date.now() - published < 150 * 24 * 60 * 60 * 1000
  const notIndexed = opts.verifiedIndexed === false
  if (!opts.scopusConfirmed && (notIndexed || recentlyPublished))
    add({
      key: "not-indexed",
      kind: "check",
      always: notIndexed,
      label: notIndexed
        ? "Scopus has no record of this paper"
        : "Recently published — the index may not have it yet",
      detail: notIndexed
        ? "A claim filed before the article is indexed cannot be processed. Filing checks again and asks for a short note if it still cannot confirm the paper — but the usual answer is to wait until the record appears and file then."
        : "Filing checks the publication index again. If it still cannot confirm the paper, you will be asked for a short note and it goes through with that. For a paper this new that is normal, not a rejection.",
      step: 0,
    })

  if (opts.calcFailed)
    add({
      key: "calc-failed",
      kind: "check",
      label: "The estimate could not be worked out",
      detail:
        "The server did not answer the pricing request. There is no figure because of that, not because the paper is worth nothing — filing is unaffected.",
      step: 4,
    })
  else if (opts.calc?.error)
    add({ key: "calc", kind: "check", label: opts.calc.error, step: 4 })
  else if (
    opts.calc &&
    opts.calc.remuneration === 0 &&
    form.claimReason === "INCENTIVE" &&
    !out.some((x) => x.kind === "unpaid")
  )
    add({
      key: "zero",
      kind: "unpaid",
      label: "This works out to nothing",
      detail:
        opts.calc.note ||
        "We may hold no SNIP or quartile for this journal. The research cell verifies it separately, and the figure can change.",
      step: 4,
    })

  return out
}
