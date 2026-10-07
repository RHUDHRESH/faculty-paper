import type { EventsPayload, HubEvent, Highlights, HighlightPaper, EventsSummary } from "@/pages/events-model"

/** A Wednesday. Every date in the events tests is counted from it, so no test depends on the clock. */
export const TODAY = "2026-10-07"

export function ev(over: Partial<HubEvent> = {}): HubEvent {
  return {
    id: "ev-1", title: "Power electronics for electric vehicles", kind: "SEMINAR", kind_label: "Seminar",
    starts_on: "2026-10-08", ends_on: null, starts_at: "15:00", ends_at: "16:00", all_day: false,
    description: null, venue: "Seminar Hall 2", speaker: "Dr Leela Nair", organiser: null, link: null,
    department: "ECE", visibility: "DEPARTMENT", created_by: "Dr Ravi Kumar", created_by_id: "u-ravi",
    going_count: 4, going: false, can_edit: false,
    ...over,
  }
}

export const SEMINAR = ev()
export const WORKSHOP = ev({
  id: "ev-2", title: "Writing for Q1 journals", kind: "WORKSHOP", kind_label: "Workshop", starts_on: "2026-10-10",
  starts_at: "09:30", ends_at: "12:30", venue: "Library, first floor", speaker: null, department: null, visibility: "PUBLIC",
  organiser: "The research office", description: "Bring a draft.\nWe will read it together.", link: "https://example.org/register",
  going_count: 12, going: true, can_edit: true,
})
export const CONFERENCE = ev({
  id: "ev-3", title: "ICICCT 2026", kind: "CONFERENCE", kind_label: "Conference", starts_on: "2026-10-22", ends_on: "2026-10-24",
  starts_at: null, ends_at: null, all_day: true, venue: "Convention Centre", speaker: null, department: null, visibility: "PUBLIC", going_count: 0,
})
export const CALL = ev({
  id: "ev-4", title: "Special issue on smart grids", kind: "CALL_FOR_PAPERS", kind_label: "Call for papers",
  starts_on: "2026-10-19", starts_at: null, ends_at: null, all_day: true, venue: null, speaker: null, department: null,
  visibility: "PUBLIC", organiser: "IEEE Access", link: "https://example.org/cfp", going_count: 0,
})
export const FDP = ev({
  id: "ev-5", title: "FDP on outcome-based education", kind: "FDP", kind_label: "Faculty development programme",
  starts_on: "2026-11-03", ends_on: "2026-11-07", starts_at: null, ends_at: null, all_day: true, venue: "Block B", speaker: null,
  department: null, visibility: "PUBLIC", going_count: 2,
})
export const PAST = ev({
  id: "ev-6", title: "Guest lecture on signal processing", starts_on: "2026-09-18", ends_at: "17:00", going_count: 9,
})

export const KINDS = [
  { key: "SEMINAR", label: "Seminar" },
  { key: "WORKSHOP", label: "Workshop" },
  { key: "CONFERENCE", label: "Conference" },
  { key: "FDP", label: "Faculty development programme" },
  { key: "CALL_FOR_PAPERS", label: "Call for papers" },
  { key: "OTHER", label: "Something else" },
]

export function listing(results: HubEvent[], over: Partial<EventsPayload> = {}): EventsPayload {
  const counts: Record<string, number> = {}
  for (const e of results) counts[e.kind] = (counts[e.kind] ?? 0) + 1
  return {
    today: TODAY, when: "upcoming", results, counts, kinds: KINDS, departments: ["CSE", "ECE", "Mechanical Engineering"],
    audiences: [
      { key: "DEPARTMENT", label: "My department (Mechanical Engineering)" },
      { key: "PUBLIC", label: "The whole college" },
    ],
    can_add: true, can_pick_department: false, seminars_this_year: 12,
    ...over,
  }
}

export function summary(upcoming: HubEvent[], over: Partial<EventsSummary> = {}): EventsSummary {
  return {
    today: TODAY, this_week: upcoming.slice(0, 3), this_week_count: Math.min(upcoming.length, 3),
    next: upcoming[0] ?? null, upcoming: upcoming.slice(0, 3), counts: {}, total: upcoming.length,
    ...over,
  }
}

export function paper(over: Partial<HighlightPaper> = {}): HighlightPaper {
  return {
    id: "p-1", title: "Quantum sensing at the edge", venue: "Quantum Letters", quartile: "Q1", date: "2026-09-30", year: 2026,
    citations: 0, authors: [{ id: "u-asha", name: "Asha Menon", department: "ECE" }], authors_more: 0,
    reason: "First Q1 paper for Asha Menon",
    ...over,
  }
}

export function highlights(over: Partial<Highlights> = {}): Highlights {
  return {
    period: "quarter", label: "Past 3 months", from: "2026-07-08", to: TODAY, windows: { days: 91, most_cited_days: 365 },
    department: null, departments: ["CSE", "ECE"],
    q1: [paper(), paper({ id: "p-2", title: "Sparse filters for radar", venue: "Signal Journal", reason: "In Signal Journal, a Q1 journal",
      authors: [{ id: "u-ravi", name: "Ravi Kumar", department: "ECE" }, { id: "u-meera", name: "Meera Pillai", department: "CSE" }] })],
    first_papers: [paper({ id: "p-3", title: "Fatigue life of lattice struts", venue: "Fatigue Journal", quartile: null,
      reason: "The college's first paper in Fatigue Journal" })],
    most_cited: [paper({ id: "p-4", title: "Graph kernels in practice", venue: "Signal Journal", quartile: "Q3", citations: 12,
      reason: "Cited 12 times since it came out in Jun 2026" })],
    new_names: [paper({ id: "p-5", title: "My first paper", venue: "Fresh Journal", quartile: null,
      authors: [{ id: "u-nila", name: "Nila Sen", department: "CSE" }], reason: "First paper on the college record for Nila Sen" })],
    by_department: [{ department: "ECE", papers: 20, q1: 3 }, { department: "CSE", papers: 10, q1: 1 }],
    counts: { q1: 2, first_papers: 1, most_cited: 1, new_names: 1 },
    totals: { papers: 28, q1: 3, people: 30 },
    empty: false,
    ...over,
  }
}

export const NOTHING_NEW = highlights({
  q1: [], first_papers: [], most_cited: [], new_names: [], by_department: [],
  counts: { q1: 0, first_papers: 0, most_cited: 0, new_names: 0 }, totals: { papers: 0, q1: 0, people: 0 }, empty: true,
})
