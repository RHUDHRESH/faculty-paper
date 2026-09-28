/**
 * Filing a paper, as a claimant meets it.
 *
 * The product owner's two complaints were that pulling a paper from Scopus
 * did not work (production has no Scopus key) and that filing was hard to
 * use. These pin the answer to both from the outside: one box takes a DOI and
 * fills what it can, saying where each value came from and what is left to
 * check; each step says what is missing beside the field that is missing it;
 * the estimate stays in view; and the author step shows the claimant among
 * the authors rather than as a bare number.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { Route, Routes } from "react-router-dom"

import { api, ApiError } from "@/lib/api"
import { FilePaper } from "@/pages/file-paper"
import type { PaperLookup } from "@/pages/filing/lookup"
import { FACULTY, renderWithProviders } from "@/test/harness"

const DOI = "10.1038/s41598-026-99999-x"

const LOOKUP: PaperLookup = {
  ok: true,
  code: "ok",
  message: null,
  paper: {
    title: "A Sharded Ledger for Cloud Storage",
    doi: DOI,
    journal: "Scientific Reports",
    issns: ["2045-2322"],
    issn: "2045-2322",
    publication_date: "2026-05-20",
    publication_date_precision: "day",
    publication_year: 2026,
    document_type: "Journal article",
    publication_type: "Journal",
    citations: 7,
    open_access_url: "https://example.org/oa.pdf",
    is_retracted: false,
    total_authors: 3,
    authors: [
      { position: 1, name: "R. N. Kavitha", affiliations: ["Saveetha Engineering College"], is_claimant: false, college: "yes" },
      { position: 2, name: "Asha Menon", affiliations: ["Saveetha Engineering College"], is_claimant: true, college: "yes" },
      { position: 3, name: "C. Valli", affiliations: ["Anna University"], is_claimant: false, college: "no" },
    ],
  },
  claimant: { position: 2, name_on_paper: "Asha Menon", confidence: "likely", matched_on: "name", candidates: [2] },
  affiliation: { status: "yes", claimant_status: "yes", positions: [1, 2], text: null },
  metrics: {
    found: true,
    journal: "Scientific Reports",
    issn: "2045-2322",
    matched_by: "issn",
    quartile: "Q1",
    category: "Computer Science",
    sjr: 0.9,
    dataset_year: 2025,
    snip: 1.339,
    snip_year: 2025,
    engineering_class: "Engineering",
  },
  field_sources: { title: "OpenAlex", journal: "OpenAlex", quartile: "Our journal data", snip: "Our journal data" },
  sources: [
    { id: "openalex", label: "OpenAlex", ok: true, count: 1, detail: null, code: null },
    { id: "crossref", label: "Crossref", ok: true, count: 1, detail: null, code: null },
    { id: "scopus", label: "Scopus", ok: false, count: null, detail: "Scopus is not connected on this server.", code: "not_configured" },
    { id: "journals", label: "Our journal data", ok: true, count: 1, detail: null, code: null },
  ],
  scopus_status: "not_configured",
  warnings: [],
  to_check: [{ key: "position", text: "We matched you to author 2, “Asha Menon”, by name. Check that is you." }],
  already_filed: null,
  candidates: [],
}

type Call = { path: string; method: string; body: unknown }

function mount({
  lookup = LOOKUP,
  routed = false,
  route = "/papers/new",
  pull,
}: { lookup?: PaperLookup; routed?: boolean; route?: string; pull?: unknown } = {}) {
  const calls: Call[] = []
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((async (path: string, opts?: { method?: string; json?: unknown }) => {
    const method = (opts?.method || "GET").toUpperCase()
    calls.push({ path, method, body: opts?.json })
    if (path.startsWith("/api/auth/me")) return { ...FACULTY, scopus_author_url: "https://www.scopus.com/authid/detail.uri?authorId=1", designation: "Professor" }
    if (path === "/api/institution") return { college_name: "Saveetha Engineering College", sign_in_note: "", support_email: "" }
    if (path.startsWith("/api/meta/filing-rules")) {
      return {
        max_authors: 9,
        min_sec_references: 2,
        attachment_limits: { PUBLISHED_PAPER: 10, SEC_REFERENCE: 50 },
        max_upload_bytes: 10485760,
        why: { max_authors: "Over 9 authors pays nothing.", min_sec_references: "Two references are needed." },
        policy_version: 1,
      }
    }
    if (path.startsWith("/api/claims?status=DRAFT")) return { results: [] }
    if (path === "/api/admin/users/u-asha") {
      return { id: "u-asha", name: "Asha Menon", email: "asha@example.edu", department: "Mechanical" }
    }
    if (path === "/api/lookup/paper") return lookup
    if (path === "/api/me/scopus-pull" && pull) return pull
    if (path === "/api/calculate") {
      return { base: 73645, point: 0.5, remuneration: 36823, qf: 0, error: null, note: null, category_label: "Category I" }
    }
    if (path === "/api/prior/check") return { warning: false, matches: [] }
    if (path === "/api/claims" && method === "POST") return { id: "c1", status: "DRAFT", ticket_number: null, attachments: [] }
    if (path.startsWith("/api/claims/") && method === "PATCH") return { id: "c1", status: "DRAFT", ticket_number: null, attachments: [] }
    throw new ApiError(404, `No handler in this test for ${method} ${path}`)
  }) as unknown as typeof api)
  renderWithProviders(
    routed ? (
      // The two routes the app serves this page on, so the first save's
      // move from /papers/new to /papers/{id}/edit really happens.
      <Routes>
        <Route path="/papers/new" element={<FilePaper />} />
        <Route path="/papers/:id/edit" element={<FilePaper />} />
      </Routes>
    ) : (
      <FilePaper />
    ),
    { route }
  )
  return { user: userEvent.setup(), calls }
}

async function passTheGate(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { level: 1, name: "Confirm three things about this paper" })
  for (const box of await screen.findAllByRole("checkbox")) await user.click(box)
  await user.click(screen.getByRole("button", { name: "Start the claim" }))
}

/** Step 1 (paste, or by hand), then the three conditions, then the form. */
async function openForm(user: ReturnType<typeof userEvent.setup>, how: "doi" | "hand") {
  await screen.findByRole("heading", { level: 1, name: "Choose the paper" })
  if (how === "doi") {
    await pasteDoi(user)
    await user.click(screen.getByRole("button", { name: "Continue" }))
  } else {
    await user.click(await screen.findByRole("button", { name: "type the details in by hand" }))
  }
  await passTheGate(user)
  await screen.findByLabelText("Paper title")
}

async function pasteDoi(user: ReturnType<typeof userEvent.setup>) {
  // Pasted, as a claimant does it — and typing a 40-character URL one key
  // at a time is most of what made this file slow under a busy machine.
  await user.click(await screen.findByLabelText("Paste the DOI or link"))
  await user.paste(`https://doi.org/${DOI}`)
  await user.keyboard("{Enter}")
  await screen.findByText(/Found it/)
}

afterEach(() => {
  vi.useRealTimers()
})

// These walk a real page through several steps; the default five seconds is
// a whole-suite budget on a quiet machine, not on one running four suites.
describe("filing a paper", { timeout: 20_000 }, () => {
  it("opens on one box for the DOI or link", async () => {
    const { user } = mount()
    await openForm(user, "hand")
    expect(await screen.findByLabelText("Paste the DOI or link")).toBeInTheDocument()
  })

  it("fills the paper from a pasted DOI and says where each part came from", async () => {
    const { user, calls } = mount()
    await openForm(user, "doi")

    const lookup = calls.find((c) => c.path === "/api/lookup/paper")
    expect(lookup?.body).toMatchObject({ query: `https://doi.org/${DOI}` })

    expect(screen.getByLabelText("Paper title")).toHaveValue("A Sharded Ledger for Cloud Storage")
    const card = screen.getByRole("region", { name: /Found it/ })
    expect(within(card).getAllByText("OpenAlex").length).toBeGreaterThan(0)
    expect(within(card).getAllByText("Our journal data").length).toBeGreaterThan(0)
    expect(within(card).getByText(/Scopus is not connected/)).toBeInTheDocument()
    // What the person still has to look at, in the server's own words.
    expect(within(card).getByText(/We matched you to author 2/)).toBeInTheDocument()
  })

  it("says what is missing beside the field, and stays on the step", async () => {
    const { user } = mount()
    await openForm(user, "hand")
    await user.click(await screen.findByLabelText("Paper title"))
    await user.paste("A paper typed by hand")
    await user.click(screen.getByRole("button", { name: "Continue" }))

    const date = screen.getByLabelText("Date published")
    expect(date).toHaveAttribute("aria-invalid", "true")
    expect(screen.getAllByText("Enter the date it was published").length).toBeGreaterThan(0)
    expect(screen.getByLabelText("Paste the DOI or link")).toBeInTheDocument()
  })

  it("keeps the estimate in view", async () => {
    const { user } = mount()
    await openForm(user, "doi")
    await waitFor(() => expect(screen.getAllByText("₹36,823").length).toBeGreaterThan(0))
    const estimate = screen.getAllByRole("region", { name: /estimate/i })
    expect(estimate.length).toBeGreaterThan(0)
  })

  it("prices the paper before the references are attached, and says what it assumed", async () => {
    // The references are attached on step four. Pricing steps one to three
    // with none attached showed ₹0 and offered to file it "for the record" —
    // telling somebody their paper is worthless before they reach the step
    // that makes it worth something.
    const { user, calls } = mount()
    await openForm(user, "doi")
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/calculate").at(-1)?.body).toMatchObject({ sec_reference_count: 2 })
    )
    expect(screen.getAllByText(/Estimate, with 2 references/).length).toBeGreaterThan(0)
  })

  it("keeps the form in place when the first save gives the draft its address", async () => {
    // The first autosave moves the page to /papers/{id}/edit. It used to
    // fetch the draft it had just written, put a skeleton where the form
    // was, and then overwrite the form with the server's copy.
    const { user, calls } = mount({ routed: true })
    await openForm(user, "hand")
    await user.click(await screen.findByLabelText("Paper title"))
    await user.paste("A paper typed by hand")
    await waitFor(
      () => expect(calls.some((c) => c.method === "POST" && c.path === "/api/claims")).toBe(true),
      { timeout: 8000 }
    )
    await new Promise((r) => setTimeout(r, 300))
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/claims/c1")).toEqual([])
    expect(screen.getByLabelText("Paste the DOI or link")).toBeInTheDocument()
    expect(screen.getByLabelText("Paper title")).toHaveValue("A paper typed by hand")
    // Still the same job: a paper being filed, not "edit your draft".
    expect(screen.getByRole("heading", { level: 1, name: "Add the details" })).toBeInTheDocument()
  })

  it("remembers whose paper it is after the first save, when filing for someone", async () => {
    const { calls } = mount({ routed: true, route: "/papers/new?for=u-asha" })
    await screen.findByRole("heading", { level: 1, name: "The details, for Asha Menon" })
    const user = userEvent.setup()
    await user.click(await screen.findByLabelText("Paper title"))
    await user.paste("Filed by the office")
    await waitFor(
      () => expect(calls.some((c) => c.method === "POST" && c.path === "/api/claims")).toBe(true),
      { timeout: 8000 }
    )
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/claims")?.body).toMatchObject({ owner_id: "u-asha" })
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.getByRole("heading", { level: 1, name: "The details, for Asha Menon" })).toBeInTheDocument()
    expect(screen.getByText("Filing on behalf of Asha Menon")).toBeInTheDocument()
  })

  it("shows the claimant among the authors on the author step", async () => {
    const { user } = mount()
    await openForm(user, "doi")
    await user.click(screen.getByRole("button", { name: "Continue" }))
    await user.click(await screen.findByLabelText("Yukthi ID"))
    await user.paste("NA")
    await user.click(screen.getByRole("button", { name: "Continue" }))

    const me = await screen.findByRole("radio", { name: /2\. Asha Menon/ })
    expect(me).toBeChecked()
    await user.click(screen.getByRole("radio", { name: /1\. R\. N\. Kavitha/ }))
    expect(screen.getByRole("radio", { name: /1\. R\. N\. Kavitha/ })).toBeChecked()
  })
})

const PULL = {
  count: 2,
  unclaimed: 1,
  papers: [
    {
      publication_id: "p1", title: "A Sharded Ledger for Cloud Storage", venue: "Scientific Reports", issn: "2045-2322",
      year: 2025, date: "2025-03-01", type: "Journal", doi: DOI, eid: "2-s2.0-85000000001", citations: 3,
      author_position: 2, total_authors: 3, authors: ["R. N. Kavitha", "Asha Menon", "S. Rao"],
      already_claimed: false, claim_id: null, claim_status: null,
    },
    {
      publication_id: "p2", title: "An Older Paper Already Filed", venue: "IEEE Access", issn: null,
      year: 2024, date: null, type: "Journal", doi: "10.1109/x.1", eid: null, citations: 0,
      author_position: 1, total_authors: 1, authors: ["Asha Menon"],
      already_claimed: true, claim_id: "c9", claim_status: "SUBMITTED",
    },
  ],
}

async function pickAndContinue(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("radio", { name: /A Sharded Ledger/ }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled())
  await user.click(screen.getByRole("button", { name: "Continue" }))
  await screen.findByRole("heading", { level: 1, name: "Confirm three things about this paper" })
}

describe("choosing the paper and confirming the conditions", { timeout: 20_000 }, () => {
  it("pulls from my record first, and keeps claimed papers apart", async () => {
    mount({ pull: PULL })
    await screen.findByRole("heading", { level: 1, name: "Choose the paper" })
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Pull from my Scopus record/ })).toHaveAttribute("aria-checked", "true")
    )
    const picker = await screen.findByRole("radiogroup", { name: "Pick the paper to file" })
    expect(within(picker).getByText("A Sharded Ledger for Cloud Storage")).toBeInTheDocument()
    expect(within(picker).queryByText("An Older Paper Already Filed")).toBeNull()
    expect(screen.getByText("Already claimed (1)")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled()
  })

  it("shows all three conditions unticked about this article, and Change clears the ticks", async () => {
    const { user } = mount({ pull: PULL })
    await pickAndContinue(user)
    const boxes = screen.getAllByRole("checkbox")
    expect(boxes).toHaveLength(3)
    boxes.forEach((b) => expect(b).not.toBeChecked())
    expect(screen.getAllByText("I confirm this is true for this article")).toHaveLength(3)
    expect(screen.getByText("0 of 3 confirmed")).toBeInTheDocument()
    expect(screen.getByText(/2-s2.0-85000000001/)).toBeInTheDocument()

    await user.click(boxes[0])
    await user.click(boxes[1])
    expect(screen.getByText("2 of 3 confirmed")).toBeInTheDocument()
    // Start with one outstanding names it, and the form stays shut.
    await user.click(screen.getByRole("button", { name: "Start the claim" }))
    expect(await screen.findByText(/One of these is not confirmed yet/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Paper title")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Change" }))
    await screen.findByRole("heading", { level: 1, name: "Choose the paper" })
    await user.click(screen.getByRole("button", { name: "Continue" }))
    await screen.findByRole("heading", { level: 1, name: "Confirm three things about this paper" })
    screen.getAllByRole("checkbox").forEach((b) => expect(b).not.toBeChecked())
  })

  it("opens straight on the conditions for ?publication=, as if picked", async () => {
    mount({ pull: PULL, route: "/papers/new?publication=p1" })
    await screen.findByRole("heading", { level: 1, name: "Confirm three things about this paper" })
    expect(screen.getAllByText("A Sharded Ledger for Cloud Storage").length).toBeGreaterThan(0)
    screen.getAllByRole("checkbox").forEach((b) => expect(b).not.toBeChecked())
  })

  it("never remembers the rules as read", async () => {
    localStorage.setItem("claim-rules-read", "1")
    const { user } = mount({ pull: PULL })
    await pickAndContinue(user)
    expect(screen.getAllByRole("checkbox")).toHaveLength(3)
    expect(screen.getByText("No incentive claim has been filed for this article before")).toBeVisible()
    localStorage.removeItem("claim-rules-read")
  })
})
