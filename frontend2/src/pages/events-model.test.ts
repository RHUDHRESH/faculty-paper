import { describe, expect, it } from "vitest"

import {
  clock,
  countdown,
  dayRange,
  dayWords,
  eventsPath,
  groupByMonth,
  nextWorkingDay,
  showcaseSentence,
  startsIn,
  tile,
  timeSpan,
  whenWords,
  type HubEvent,
} from "@/pages/events-model"

function ev(over: Partial<HubEvent> = {}): HubEvent {
  return {
    id: "e1", title: "Seminar", kind: "SEMINAR", kind_label: "Seminar",
    starts_on: "2026-10-08", ends_on: null, starts_at: null, ends_at: null, all_day: true,
    description: null, venue: null, speaker: null, organiser: null, link: null, department: null,
    visibility: "PUBLIC", created_by: "Office", created_by_id: "u-office", going_count: 0, going: false, can_edit: false,
    ...over,
  }
}

describe("saying a time and a day the way a person does", () => {
  it("says a clock time with the hour, and the minutes only when there are some", () => {
    expect(clock("15:00")).toBe("3 pm")
    expect(clock("09:30")).toBe("9:30 am")
    expect(clock("00:00")).toBe("12 am")
    expect(clock("12:15")).toBe("12:15 pm")
  })

  it("says a stretch of time once, not twice, when both ends are in the same half of the day", () => {
    expect(timeSpan("15:00", "16:00")).toBe("3 to 4 pm")
    expect(timeSpan("11:00", "13:30")).toBe("11 am to 1:30 pm")
    expect(timeSpan("15:00", null)).toBe("3 pm")
  })

  it("names the weekday, the day and the month", () => {
    expect(dayWords("2026-10-08")).toBe("Thursday 8 Oct")
    expect(dayWords("2026-10-08", { year: true })).toBe("Thursday 8 Oct 2026")
  })

  it("gives a run of days as one phrase, naming the month once when it is the same", () => {
    expect(dayRange(ev({ starts_on: "2026-10-22", ends_on: "2026-10-24" }))).toBe("22 to 24 Oct")
    expect(dayRange(ev({ starts_on: "2026-10-30", ends_on: "2026-11-02" }))).toBe("30 Oct to 2 Nov")
    expect(dayRange(ev())).toBe("Thursday 8 Oct")
  })

  it("puts the day, the time and the place in one sentence, as people say it", () => {
    expect(whenWords(ev({ starts_at: "15:00", venue: "Seminar Hall 2" }))).toBe("Thursday 8 Oct, 3 pm, Seminar Hall 2")
    expect(whenWords(ev())).toBe("Thursday 8 Oct")
    expect(whenWords(ev({ starts_on: "2026-10-22", ends_on: "2026-10-24", venue: "Main hall" }))).toBe("22 to 24 Oct, Main hall")
    expect(whenWords(ev({ kind: "CALL_FOR_PAPERS" }))).toBe("Closes Thursday 8 Oct")
  })

  it("makes the date tile: weekday, day, month", () => {
    expect(tile(ev())).toEqual({ weekday: "Thu", day: "8", month: "Oct" })
    expect(tile(ev({ starts_on: "2026-10-22", ends_on: "2026-10-24" }))).toEqual({ weekday: "Thu", day: "22–24", month: "Oct" })
  })
})

describe("how long to go", () => {
  const call = (starts_on: string) => ev({ kind: "CALL_FOR_PAPERS", starts_on })

  it("counts down to a call for papers, in days", () => {
    expect(countdown(call("2026-10-19"), "2026-10-07")?.text).toBe("12 days left")
    expect(countdown(call("2026-10-08"), "2026-10-07")?.text).toBe("1 day left")
    expect(countdown(call("2026-10-07"), "2026-10-07")?.text).toBe("Closes today")
    expect(countdown(call("2026-10-01"), "2026-10-07")?.text).toBe("Closed")
  })

  it("turns more urgent as the deadline comes in, and says so in words and not only colour", () => {
    expect(countdown(call("2026-10-19"), "2026-10-07")?.tone).toBe("neutral")
    expect(countdown(call("2026-10-10"), "2026-10-07")?.tone).toBe("caution")
    expect(countdown(call("2026-10-07"), "2026-10-07")?.tone).toBe("critical")
    expect(countdown(call("2026-10-01"), "2026-10-07")?.tone).toBe("quiet")
  })

  it("is only for a call for papers", () => {
    expect(countdown(ev(), "2026-10-07")).toBeNull()
  })

  it("says how far off an event is, and when one has already started", () => {
    expect(startsIn(ev({ starts_on: "2026-10-07" }), "2026-10-07")).toBe("Today")
    expect(startsIn(ev({ starts_on: "2026-10-08" }), "2026-10-07")).toBe("Tomorrow")
    expect(startsIn(ev({ starts_on: "2026-10-10" }), "2026-10-07")).toBe("In 3 days")
    expect(startsIn(ev({ starts_on: "2026-10-05", ends_on: "2026-10-09" }), "2026-10-07")).toBe("On until 9 Oct")
    expect(startsIn(ev({ starts_on: "2026-10-01" }), "2026-10-07")).toBe("Over")
  })
})

describe("the showcase's one sentence", () => {
  const h = (totals: { papers: number; q1: number; people: number }, over: { department?: string | null; label?: string } = {}) => ({
    label: over.label ?? "Past 3 months",
    department: over.department ?? null,
    totals,
  })

  it("says how many papers, how many in Q1 journals, and by how many people", () => {
    expect(showcaseSentence(h({ papers: 28, q1: 3, people: 30 }))).toBe(
      "28 new papers in the past 3 months, 3 of them in Q1 journals, by 30 colleagues."
    )
  })

  it("leaves out the Q1 clause when there is none, and keeps singular and plural right", () => {
    expect(showcaseSentence(h({ papers: 28, q1: 0, people: 30 }))).toBe("28 new papers in the past 3 months, by 30 colleagues.")
    expect(showcaseSentence(h({ papers: 5, q1: 1, people: 4 }))).toBe("5 new papers in the past 3 months, 1 of them in a Q1 journal, by 4 colleagues.")
    expect(showcaseSentence(h({ papers: 1, q1: 0, people: 1 }, { label: "Past month" }))).toBe("1 new paper in the past month, by 1 colleague.")
  })

  it("does not say 'of them' when every paper is Q1", () => {
    expect(showcaseSentence(h({ papers: 4, q1: 4, people: 6 }))).toBe("4 new papers in the past 3 months, all in Q1 journals, by 6 colleagues.")
    expect(showcaseSentence(h({ papers: 1, q1: 1, people: 2 }))).toBe("1 new paper in the past 3 months, in a Q1 journal, by 2 colleagues.")
  })

  it("names the department when one was asked for, and says nothing when there are no papers", () => {
    expect(showcaseSentence(h({ papers: 20, q1: 3, people: 14 }, { department: "ECE" }))).toBe(
      "20 new papers from ECE in the past 3 months, 3 of them in Q1 journals, by 14 colleagues."
    )
    expect(showcaseSentence(h({ papers: 0, q1: 0, people: 0 }))).toBeNull()
  })

  it("groups thousands the Indian way", () => {
    expect(showcaseSentence(h({ papers: 1276, q1: 86, people: 306 }, { label: "Past year" }))).toBe(
      "1,276 new papers in the past year, 86 of them in Q1 journals, by 306 colleagues."
    )
  })
})

describe("grouping and asking", () => {
  it("groups by month in the order given, naming each month and year", () => {
    const groups = groupByMonth([
      ev({ id: "a", starts_on: "2026-10-19" }),
      ev({ id: "b", starts_on: "2026-10-22" }),
      ev({ id: "c", starts_on: "2026-11-03" }),
    ])
    expect(groups.map((g) => [g.label, g.events.map((e) => e.id)])).toEqual([
      ["October 2026", ["a", "b"]],
      ["November 2026", ["c"]],
    ])
  })

  it("starts a new event on the next working day, never a weekend", () => {
    expect(nextWorkingDay("2026-10-07")).toBe("2026-10-08") // Wednesday to Thursday
    expect(nextWorkingDay("2026-10-09")).toBe("2026-10-12") // Friday to Monday
    expect(nextWorkingDay("2026-10-10")).toBe("2026-10-12") // Saturday to Monday
    expect(nextWorkingDay("2026-10-11")).toBe("2026-10-12") // Sunday to Monday
  })

  it("builds the request from what is chosen and leaves out what is not", () => {
    expect(eventsPath("upcoming", {}, 200)).toBe("/api/events?when=upcoming&limit=200")
    expect(eventsPath("week", { kind: "WORKSHOP", department: "ECE", q: " power " })).toBe(
      "/api/events?when=week&kind=WORKSHOP&department=ECE&q=power"
    )
  })
})
