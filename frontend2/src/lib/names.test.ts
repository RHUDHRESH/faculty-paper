import { describe, expect, it } from "vitest"

import { deptLabel, firstName, paperTitle } from "./names"

describe("deptLabel", () => {
  it("title-cases shouted whole words of five letters or more", () => {
    expect(deptLabel("TRAINING")).toBe("Training")
    expect(deptLabel("CIVIL")).toBe("Civil")
    expect(deptLabel("S&H-ENGLISH")).toBe("S&H-English")
  })
  it("keeps short codes and mixed-case names as written", () => {
    expect(deptLabel("CSE")).toBe("CSE")
    expect(deptLabel("ECE")).toBe("ECE")
    expect(deptLabel("S&H-ENG")).toBe("S&H-ENG")
    expect(deptLabel("Mechanical Engineering")).toBe("Mechanical Engineering")
  })
  it("returns empty text for a missing name", () => {
    expect(deptLabel(null)).toBe("")
  })
})

describe("paperTitle", () => {
  it("reads placeholders as Untitled", () => {
    expect(paperTitle("-")).toBe("Untitled")
    expect(paperTitle(null)).toBe("Untitled")
  })
  it("brings a shouted title down to sentence case and keeps known short forms", () => {
    expect(paperTitle("THE IMPACT OF GROUP DISCUSSION TASKS")).toBe("The impact of group discussion tasks")
    expect(paperTitle("AN IOT BASED SECURITY MONITORING WITH CNN")).toBe("An IOT based security monitoring with CNN")
  })
  it("leaves an ordinary or short title alone", () => {
    expect(paperTitle("A Sharded Ledger for Cloud Storage")).toBe("A Sharded Ledger for Cloud Storage")
    expect(paperTitle("DNA")).toBe("DNA")
  })
})

describe("firstName", () => {
  it("skips titles and leading initials", () => {
    expect(firstName("Dr. R. Subhashini")).toBe("Subhashini")
    expect(firstName("Mr.V. Balasundaram")).toBe("Balasundaram")
    expect(firstName("Dr.A.Tajuddin")).toBe("Tajuddin")
  })
  it("keeps a first name followed by an initial", () => {
    expect(firstName("Srigitha S")).toBe("Srigitha")
    expect(firstName("Prof. Karthik Raja M")).toBe("Karthik")
  })
  it("falls back when there is nothing better", () => {
    expect(firstName("R. S.")).toBe("R")
    expect(firstName("")).toBe("")
    expect(firstName(undefined)).toBe("")
  })
})
