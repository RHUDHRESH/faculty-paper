import { describe, expect, it } from "vitest"

import { filterRows, nextAfter } from "./use-rail"
import type { RailClaim } from "./types"

const row = (id: string, extra: Partial<RailClaim> = {}): RailClaim => ({
  id,
  ticket_number: `FP-2026-00000${id}`,
  paper_title: `Paper ${id}`,
  journal_title: "Nature",
  owner_name: "Asha Rao",
  owner_department: "CSE",
  waiting_days: 3,
  remuneration: 1000,
  ...extra,
})

describe("nextAfter", () => {
  const rows = [row("1"), row("2"), row("3")]
  it("opens the next claim down", () => {
    expect(nextAfter(rows, "1")?.id).toBe("2")
    expect(nextAfter(rows, "2")?.id).toBe("3")
  })
  it("falls back to the one above when the last is done", () => {
    expect(nextAfter(rows, "3")?.id).toBe("2")
  })
  it("has nothing left when the queue held only this claim", () => {
    expect(nextAfter([row("1")], "1")).toBeNull()
  })
  it("starts from the top when the claim is not in the list", () => {
    expect(nextAfter(rows, "zzz")?.id).toBe("1")
  })
})

describe("filterRows", () => {
  const rows = [row("1", { owner_name: "Meera Iyer" }), row("2", { journal_title: "Lancet" })]
  it("finds by claim number, claimant or journal", () => {
    expect(filterRows(rows, "000002").map((r) => r.id)).toEqual(["2"])
    expect(filterRows(rows, "meera").map((r) => r.id)).toEqual(["1"])
    expect(filterRows(rows, "lancet").map((r) => r.id)).toEqual(["2"])
  })
  it("keeps everything for an empty filter", () => {
    expect(filterRows(rows, "  ")).toHaveLength(2)
  })
})
