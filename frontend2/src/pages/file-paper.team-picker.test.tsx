import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { RULE_FALLBACK, emptyForm, type FormState } from "@/pages/file-paper"
import { TeamPicker, useMyTeams } from "@/pages/filing/team"
import { FACULTY, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The student-project reason, as the mentor meets it.
 *
 * The final-year project scheme pays a fixed amount per team per conference
 * paper, once per team, and only the team's mentor may claim it. So the
 * claimant does not type a team code any more: they pick from the teams the
 * roster says they mentor, see the students on each, and a team already
 * claimed is shown with the ticket that holds it rather than offered and
 * then refused by the server.
 */

const team = (code: string, over: Record<string, unknown> = {}) => ({
  id: `t-${code}`,
  code,
  title: `Project ${code}`,
  department: "Chemical",
  academic_year: "2025-26",
  mentor_id: FACULTY.id,
  mentor_name: FACULTY.name,
  active: true,
  members: [
    { id: `${code}-1`, name: "Mohamed Ahamed Meeran", register_number: "212222210012",
      programme: null, year_of_study: null, mentor_name: null },
    { id: `${code}-2`, name: "Basith Ali A", register_number: "212222210013",
      programme: null, year_of_study: null, mentor_name: null },
  ],
  claimed_by: null,
  ...over,
})

function mount(
  teams: unknown[],
  form: Partial<FormState> = {},
  over: ApiTable = {},
  props: { ownerId?: string | null; claimId?: string | null } = {}
) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/teams?mine=true": () => ({ results: teams }),
      ...over,
    })
  )
  const patchForm = vi.fn()
  const state = { ...emptyForm(), claimReason: "STUDENT_PROJECT" as const, ...form }
  renderWithProviders(
    <Harness
      code={state.teamCode}
      onCode={(teamCode) => patchForm({ teamCode })}
      ownerId={props.ownerId}
      claimId={props.claimId}
    />
  )
  return { patchForm }
}

function Harness(p: {
  code: string
  onCode: (c: string) => void
  ownerId?: string | null
  claimId?: string | null
}) {
  const teams = useMyTeams(p.ownerId)
  return <TeamPicker teams={teams} code={p.code} onCode={p.onCode} rules={RULE_FALLBACK} claimId={p.claimId} />
}

describe("the mentor's team picker", () => {
  it("lists the mentor's own teams with the students on each", async () => {
    mount([team("PR26CH0001"), team("PR26CH0002")])
    expect(await screen.findByRole("radio", { name: /PR26CH0001/ })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /PR26CH0002/ })).toBeInTheDocument()
    expect(screen.getAllByText(/Mohamed Ahamed Meeran/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/212222210012/).length).toBeGreaterThan(0)
  })

  it("chooses a team by its id", async () => {
    const user = userEvent.setup()
    const { patchForm } = mount([team("PR26CH0001")])
    await user.click(await screen.findByRole("radio", { name: /PR26CH0001/ }))
    expect(patchForm).toHaveBeenCalledWith({ teamCode: "PR26CH0001" })
  })

  it("shows a claimed team with the ticket that holds it, and does not offer it", async () => {
    mount([
      team("PR26CH0001", {
        claimed_by: { claim_id: "c1", ticket_number: "SEC-2026-0042", status: "SUBMITTED" },
      }),
    ])
    const held = await screen.findByRole("radio", { name: /PR26CH0001/ })
    expect(held).toBeDisabled()
    expect(screen.getByText(/SEC-2026-0042/)).toBeInTheDocument()
  })

  it("states the fixed amount and the conference-only rule", async () => {
    mount([team("PR26CH0001")])
    const region = await screen.findByRole("group", { name: /your final-year project teams/i })
    expect(within(region).getByText(/₹15,000/)).toBeInTheDocument()
    expect(within(region).getAllByText(/conference papers only/i).length).toBeGreaterThan(0)
  })

  it("lists the mentor's teams when the office files on their behalf", async () => {
    mount([], {}, { "/api/teams?mine=true&owner_id=u-mentor": () => ({ results: [team("PR26CH0009")] }) }, {
      ownerId: "u-mentor",
    })
    expect(await screen.findByRole("radio", { name: /PR26CH0009/ })).toBeInTheDocument()
    expect(
      vi.mocked(api).mock.calls.some(([p]) => p === "/api/teams?mine=true&owner_id=u-mentor")
    ).toBe(true)
  })

  it("does not show the claim being edited as blocked by itself", async () => {
    mount(
      [
        team("PR26CH0001", {
          claimed_by: { claim_id: "c-own", ticket_number: "SEC-2026-0042", status: "REJECTED" },
        }),
      ],
      { teamCode: "PR26CH0001" },
      {},
      { claimId: "c-own" }
    )
    const own = await screen.findByRole("radio", { name: /PR26CH0001/ })
    expect(own).toBeEnabled()
    expect(screen.queryByText(/already claimed/i)).toBeNull()
  })

  it("says why when the person mentors no team", async () => {
    mount([])
    expect(await screen.findByText(/not the mentor of any final-year project team/i)).toBeInTheDocument()
  })
})
