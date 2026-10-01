import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

// pdf.js needs a real browser (canvas, workers). The viewer is exercised in
// the browser; here it is a marker that says which file it was asked to open.
vi.mock("./viewer/pdf-view", () => ({
  default: ({ filename }: { filename: string }) => <div data-testid="pdf">{filename}</div>,
}))

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

import { ReviewWorkspace } from "./review-workspace"

const CELL: Me = { id: "u-cell", email: "cell@example.edu", name: "R Cell", role: "RESEARCH_CELL", department: null }
const FACULTY_ME: Me = { id: "u-fac", email: "fac@example.edu", name: "Asha", role: "FACULTY", department: "CSE" }

const hex = (c: string) => `/media/claims/${c.repeat(32)}.pdf`

function claim(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    ticket_number: `FP-2026-00000${id.slice(-1)}`,
    paper_title: `Paper ${id}`,
    journal_title: "Nature",
    doi: null,
    issn: null,
    publication_year: 2026,
    status: "SUBMITTED",
    owner_id: "u-owner",
    owner_name: "Meera Iyer",
    owner_email: "meera@example.edu",
    owner_department: "CSE",
    remuneration: 55000,
    remuneration_is_estimate: false,
    remuneration_category: null,
    remuneration_note: null,
    calc_error: null,
    qf_amount: null,
    base_amount: null,
    snip: 1,
    snip_source: "SCOPUS",
    self_reported_snip: 1,
    quartile: "Q1",
    quartile_source: "SCIMAGO",
    self_reported_quartile: "Q3",
    scimago_sjr: null,
    scimago_dataset_year: null,
    author_position: 1,
    total_authors: 2,
    affiliation_ok: false,
    verification_ok: true,
    verification_snapshot_json: null,
    duplicate_warning: false,
    duplicate_matches_json: null,
    override_duplicate: null,
    override_reason: null,
    override_by_name: null,
    waiting_days: 3,
    attachments: [
      { id: "a1", kind: "PUBLISHED_PAPER", url: hex("a"), filename: "paper.pdf", size_bytes: 1000 },
      { id: "a2", kind: "SEC_REFERENCE", url: hex("b"), filename: "ref.pdf", size_bytes: 1000, ref_number: "27" },
    ],
    actions: [],
    confirmations: [
      { id: "k1", text: "I am the author.", ticked_at: "2026-09-29T08:30:00Z", user_name: "Meera Iyer" },
    ],
    ...over,
  }
}

const QUEUE = ["c1", "c2", "c3"].map((id) => ({ ...claim(id), attachments: [] }))

function bundle(id: string, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { claim: claim(id, over), review: { flags: [], file_checks: [] }, own: false, role: "RESEARCH_CELL", ...extra }
}

/** Shows where the router has been sent, so a test can see a claim open. */
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

function mount(
  route = "/review/c1",
  table: ApiTable = {},
  me: Me = CELL,
  /** Sees every call first; return undefined to let the table answer. */
  spy?: (path: string, init?: { json?: unknown }) => unknown
) {
  const answer = fakeApi({
      "/api/auth/me": () => me,
      "/api/claims/c1/workspace": () => bundle("c1"),
      "/api/claims/c2/workspace": () => bundle("c2"),
      "/api/claims/c1/review": () => ({ flags: [], file_checks: [] }),
      "/api/admin/clearing-queue": () => QUEUE,
      "/api/threads": () => ({ results: [] }),
      ...table,
    })
  vi.mocked(api).mockImplementation(((path: string, init?: { json?: unknown }) => {
    const seen = spy?.(path, init)
    return seen !== undefined ? Promise.resolve(seen) : answer(path)
  }) as typeof api)
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/review/:claimId" element={<ReviewWorkspace />} />
      </Routes>
      <Where />
    </>,
    { route }
  )
}

describe("the review workspace", () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it("loads the claim, its history and its flags in one request", async () => {
    mount()
    expect(await screen.findByText("Claimed and on record")).toBeInTheDocument()
    const paths = vi.mocked(api).mock.calls.map(([p]) => String(p))
    expect(paths.filter((p) => p === "/api/claims/c1/workspace")).toHaveLength(1)
    // Not the older three-request way: the claim, then its flags, then its history.
    expect(paths).not.toContain("/api/claims/c1")
  })

  it("has a tab for the paper and one for each reference, by its number", async () => {
    mount()
    const tabs = await screen.findAllByRole("tab", { name: /Published paper|Reference 27/ })
    expect(tabs.map((t) => t.textContent)).toEqual(["Published paper", "Reference 27"])
    expect(await screen.findByTestId("pdf")).toHaveTextContent("paper.pdf")

    await userEvent.setup().click(screen.getByRole("tab", { name: "Reference 27" }))
    expect(await screen.findByText("ref.pdf")).toBeInTheDocument()
  })

  it("puts the claim against the record and marks what differs", async () => {
    mount()
    await screen.findByText("Claimed and on record")
    expect(screen.getByText("This college is not on the paper")).toBeInTheDocument()
    // Once in the table, and again as a hint under the checklist row it belongs to.
    expect(screen.getAllByText("The claimant gave a different quartile from the record.")).toHaveLength(2)
    expect(screen.getByText(/Ticked .*by Meera Iyer/)).toBeInTheDocument()
  })

  it("offers the five decisions on a claim at this desk", async () => {
    mount()
    const bar = await screen.findByRole("region", { name: "Decision" })
    for (const name of [/^Clear/, /^Send back/, /^Hold/, "Reject outright", "Flag"]) {
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument()
    }
  })

  it("offers no decision on the reviewer's own claim, and says why", async () => {
    mount("/review/c1", {
      "/api/claims/c1/workspace": () => bundle("c1", { status: undefined }, { own: true, review: null }),
    })
    const bar = await screen.findByRole("region", { name: "Decision" })
    expect(within(bar).getByText(/This is your own claim/)).toBeInTheDocument()
    expect(within(bar).queryByRole("button", { name: /^Clear/ })).toBeNull()
    expect(within(bar).queryByRole("button", { name: /^Send back/ })).toBeNull()
    expect(screen.queryByText("Flags", { exact: false })).toBeNull()
  })

  it("does not offer a decision once the claim has left this desk", async () => {
    mount("/review/c1", { "/api/claims/c1/workspace": () => bundle("c1", { status: "CLEARED" }) })
    const bar = await screen.findByRole("region", { name: "Decision" })
    expect(within(bar).queryByRole("button", { name: /^Clear/ })).toBeNull()
    expect(within(bar).getByText(/Checked/)).toBeInTheDocument()
  })

  it("moves down the queue with j and back up with k", async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByText("Claimed and on record")
    await waitFor(() => expect(screen.getByText("1 of 3")).toBeInTheDocument())

    await user.keyboard("j")
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/review/c2"))
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([p]) => p === "/api/claims/c2/workspace")).toBe(true))

    await user.keyboard("k")
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/review/c1"))
  })

  it("writes the send-back reason from the checklist, and keeps it editable", async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByText("Your checklist")

    const affiliation = screen.getByRole("group", { name: "Affiliation: your finding" })
    await user.click(within(affiliation).getByRole("button", { name: "Issue" }))
    await user.click(screen.getByLabelText("Note for Affiliation"))
    await user.paste("The college is not in the byline.")

    await user.click(within(screen.getByRole("region", { name: "Decision" })).getByRole("button", { name: /^Send back/ }))
    const reason = (await screen.findByLabelText("Reason")) as HTMLTextAreaElement
    expect(reason.value).toContain("The college is not in the byline.")

    await user.click(reason)
    await user.paste(" Please attach the first page.")
    expect(reason.value).toContain("Please attach the first page.")
  })

  it("sends the reason it shows to the server, then opens the next claim", async () => {
    const user = userEvent.setup()
    const sent: unknown[] = []
    mount("/review/c1", {}, CELL, (path, init) => {
      if (path === "/api/claims/c1/reject") {
        sent.push(init?.json)
        return {}
      }
      return undefined
    })

    await screen.findByText("Your checklist")
    await user.keyboard("s")
    const reason = await screen.findByLabelText("Reason")
    await user.click(reason)
    await user.paste("Attach the first page showing the affiliation.")
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Send back" }))

    await waitFor(() => expect(sent).toEqual([{ note: "Attach the first page showing the affiliation." }]))
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/review/c2"))
  })

  it("says so, and offers no retry, when the account may not open it", async () => {
    mount("/review/c1", { "/api/claims/c1/workspace": failing(403, "no") }, FACULTY_ME)
    expect(await screen.findByText("This claim is not open to this account")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull()
  })
})
