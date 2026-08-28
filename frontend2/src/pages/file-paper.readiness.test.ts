/**
 * The wizard has to refuse what the server refuses.
 *
 * The original ₹0 trap was a disagreement between two rules: the submission
 * gate accepted a `sec_proof_url` or a leftover `sec_refs` string, and the
 * payout formula counted only attached reference files carrying a reference
 * number. A claim satisfied the first and failed the second, so it filed
 * cleanly and paid nothing.
 *
 * Closing it on the server moved the disagreement rather than removing it.
 * The server now refuses those claims, and for a while this form still called
 * them "this will file, and it will pay ₹0" and let the reader press Next --
 * the same broken promise pointed the other way. Only `kind: "missing"`
 * blocks a screen, so the kind is the whole fix and is what these pin.
 */
import { describe, expect, it } from "vitest"

import {
  NO_CARRIED_EVIDENCE,
  RULE_FALLBACK,
  emptyForm,
  readiness,
  type CarriedEvidence,
  type FormState,
  type Problem,
} from "./file-paper"

type Ref = { numbered: boolean }

function formWith(refs: Ref[], reason: FormState["claimReason"] = "INCENTIVE") {
  const form = emptyForm()
  form.claimReason = reason
  form.attachments = refs.map((r, i) => ({
    kind: "SEC_REFERENCE" as const,
    url: `/media/claims/${"a".repeat(32)}${i}.pdf`,
    filename: `reference-${i + 1}.pdf`,
    size_bytes: 1024,
    ref_number: r.numbered ? String(i + 1) : null,
  }))
  return form
}

function problems(form: ReturnType<typeof emptyForm>, carried: CarriedEvidence = NO_CARRIED_EVIDENCE) {
  return readiness(form, RULE_FALLBACK, {
    calc: null,
    calcFailed: false,
    priorWarning: false,
    indexedYear: null,
    carried,
    scimagoQuartile: null,
    scopusConfirmed: false,
    linkedToAuthor: null,
    verifiedIndexed: null,
  })
}

const blocking = (ps: Problem[]) => ps.filter((p) => p.kind === "missing").map((p) => p.key)
const find = (ps: Problem[], key: string) => ps.find((p) => p.key === key)

describe("the wizard blocks exactly what the server refuses", () => {
  it("blocks a paid claim whose references are a link rather than files", () => {
    // Both carried values, because `refs-url-only` is the case where the old
    // pair of gates *both* passed -- the link satisfying one and a leftover
    // reference string the other -- which is precisely how a claim used to
    // file and pay nothing. With `secRefs` empty the claim is stopped one
    // branch earlier by `ref-numbers`, which was already blocking.
    const carried = { ...NO_CARRIED_EVIDENCE, secProofUrl: "https://example.edu/refs", secRefs: "1, 2" }
    expect(blocking(problems(formWith([]), carried))).toContain("refs-url-only")
  })

  it("blocks a link-only claim with no leftover reference numbers either", () => {
    const carried = { ...NO_CARRIED_EVIDENCE, secProofUrl: "https://example.edu/refs" }
    expect(blocking(problems(formWith([]), carried))).toContain("ref-numbers")
  })

  it("blocks a paid claim whose attached references carry no numbers", () => {
    const ps = problems(formWith([{ numbered: false }, { numbered: false }]), {
      ...NO_CARRIED_EVIDENCE,
      secRefs: "1, 2",
    })
    expect(blocking(ps)).toContain("ref-numbers-zero")
  })

  it("blocks a paid claim one numbered reference short of the policy", () => {
    const ps = problems(formWith([{ numbered: true }]))
    expect(RULE_FALLBACK.min_sec_references).toBe(2)
    expect(blocking(ps)).toContain("refs-few")
  })

  it("lets a paid claim with enough numbered references through", () => {
    const ps = problems(formWith([{ numbered: true }, { numbered: true }]))
    for (const key of ["refs-url-only", "ref-numbers-zero", "refs-few"]) {
      expect(blocking(ps)).not.toContain(key)
    }
  })

  it("does not block a count-only filing, which the server exempts", () => {
    const ps = problems(formWith([{ numbered: false }], "COUNT_ONLY"), {
      ...NO_CARRIED_EVIDENCE,
      secRefs: "1",
    })
    for (const key of ["refs-url-only", "ref-numbers-zero", "refs-few"]) {
      expect(blocking(ps)).not.toContain(key)
    }
  })
})

describe("the wording no longer promises a filing that will be refused", () => {
  it("does not tell a blocked claimant their claim files without complaint", () => {
    const carried = { ...NO_CARRIED_EVIDENCE, secProofUrl: "https://example.edu/refs", secRefs: "1, 2" }
    const p = find(problems(formWith([]), carried), "refs-url-only")
    expect(p).toBeDefined()
    expect(`${p!.label} ${p!.detail ?? ""}`).not.toMatch(/files without complaint|this will pay/i)
  })

  it("does not claim a leftover sec_refs string is what lets the claim file", () => {
    const ps = problems(formWith([{ numbered: false }]), { ...NO_CARRIED_EVIDENCE, secRefs: "1" })
    const p = find(ps, "ref-numbers-zero")
    expect(p).toBeDefined()
    expect(p!.detail ?? "").not.toMatch(/lets it file at all/i)
  })

  it("tells a short claim it is refused rather than recorded at zero", () => {
    const p = find(problems(formWith([{ numbered: true }])), "refs-few")
    expect(p).toBeDefined()
    expect(p!.detail ?? "").toMatch(/refused/i)
    expect(p!.detail ?? "").not.toMatch(/the publication is recorded and the remuneration is/i)
  })
})
