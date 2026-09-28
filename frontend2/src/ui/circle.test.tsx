import { describe, expect, it } from "vitest"
import { circleLayout, shortName, type CirclePerson } from "@/ui/circle"

const person = (i: number, hop: 0 | 1 | 2, together = 1, inside = i % 3 === 0): CirclePerson => ({
  key: `k${i}`,
  user_id: inside ? `u${i}` : null,
  name: `Person ${i}`,
  department: inside ? "CSE" : null,
  institution: inside ? "Saveetha" : `Inst ${i % 7}`,
  is_college_member: inside,
  hop,
  papers: together + 2,
  together,
})

const people = [
  person(0, 0, 0, true),
  ...Array.from({ length: 53 }, (_, i) => person(i + 1, 1, 1 + ((i * 7) % 4))),
  ...Array.from({ length: 6 }, (_, i) => person(100 + i, 2, 0)),
]
const links = people.slice(1).map((p) => ({ source: "k0", target: p.key, papers: p.together || 1 }))
links.push(...[100, 101, 102].map((i) => ({ source: "k5", target: `k${i}`, papers: 1 })))

describe("your circle layout", () => {
  for (const [w, h, compact] of [[1200, 560, false], [358, 560, false], [358, 360, true]] as const) {
    it(`never lets two faces overlap at ${w}x${h}`, () => {
      const placed = circleLayout(people, links, w, h, { compact })
      for (let i = 0; i < placed.length; i++)
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i]
          const b = placed[j]
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r - 0.5)
        }
      for (const p of placed) {
        expect(p.x - p.r).toBeGreaterThanOrEqual(0)
        expect(p.x + p.r).toBeLessThanOrEqual(w)
      }
    })
  }

  it("keeps you in the middle and draws the same picture every time", () => {
    const one = circleLayout(people, links, 800, 500)
    expect(one.find((p) => p.hop === 0)).toMatchObject({ x: 400, y: 250 })
    expect(circleLayout(people, links, 800, 500)).toEqual(one)
  })

  it("puts people you share more papers with nearer and bigger", () => {
    const placed = circleLayout(people, links, 1000, 600).filter((p) => p.hop === 1)
    const dist = (p: { x: number; y: number }) => Math.hypot((p.x - 500) / 1.9, p.y - 300)
    const strong = placed.filter((p) => p.together === 4)
    const weak = placed.filter((p) => p.together === 1)
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(avg(strong.map(dist))).toBeLessThan(avg(weak.map(dist)))
    expect(Math.min(...strong.map((p) => p.r))).toBeGreaterThan(Math.max(...weak.filter((p) => !p.is_college_member).map((p) => p.r)))
  })

  it("names people without their titles", () => {
    expect(shortName("Dr.G.Venkatesan")).toBe("G. Venkatesan")
    expect(shortName("Mr. S. Joyal Isac")).toBe("S. Joyal Isac")
    expect(shortName("Nizam Mohideen Mohamed Malarkodi", 20)).toHaveLength(20)
  })
})
