import { describe, expect, it } from "vitest"

import { buildRunBody, emptyDefinition, readDefinition } from "@/pages/report-studio/model"

describe("a report whose files end with a Total and an Average", () => {
  it("keeps the choice from a template into the run and the export", () => {
    const def = readDefinition({ dataset: "payments", columns: ["paper", "amount"], totals: true })
    expect(def.totals).toBe(true)
    expect(buildRunBody(def, undefined).totals).toBe(true)
  })

  it("says nothing about totals when the report did not ask, or is a summary", () => {
    expect("totals" in buildRunBody(emptyDefinition("payments"), undefined)).toBe(false)
    const summary = readDefinition({ dataset: "payments", group_by: ["month"], aggregates: [{ field: "amount", fn: "sum" }], totals: true })
    expect("totals" in buildRunBody(summary, undefined)).toBe(false)
  })
})
