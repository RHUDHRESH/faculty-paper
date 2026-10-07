import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

vi.mock("@/app/google", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/google")>()
  return { ...actual, loadGoogleIdentity: vi.fn() }
})

import { loadGoogleIdentity, type GoogleIdentity } from "@/app/google"
import { api } from "@/lib/api"
import { Profile } from "@/pages/profile"
import { failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The account page, as the product owner put it: every account has an email
 * and a password; Google can be linked for sign-in; some details you change
 * yourself and the rest go to the research office as a request.
 */

function me(over: Record<string, unknown> = {}) {
  return {
    id: "u-faculty",
    email: "asha@example.edu",
    name: "Dr Asha Menon",
    role: "FACULTY",
    department: "Mechanical Engineering",
    employee_id: null,
    staff_id: "STF-1",
    biometric_id: "BIO-1",
    designation: "Assistant Professor",
    scopus_author_url: "",
    scopus_author_id: "5710",
    faculty_type: "REGULAR",
    research_quota: null,
    research_quota_note: null,
    must_change_password: false,
    active: true,
    portal: "faculty",
    phone: null,
    google: null,
    ...over,
  }
}

const COUNTS = {
  counts: { draft: 0, filed: 0, checked: 0, approved: 0, authorised: 0, paid: 0, sent_back: 0, all: 0 },
}

function mount(account = me(), extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => account,
      "/api/auth/profile/corrections": () => ({ results: [] }),
      "/api/auth/profile/correction": () => ({ ok: true }),
      "/api/auth/profile/self": () => ({ ...account, phone: "+91 98400 12345" }),
      "/api/auth/google/config": () => ({
        enabled: true,
        client_id: "client-id.apps.googleusercontent.com",
        hosted_domain: "example.edu",
      }),
      "/api/auth/google/link": () => ({
        google: { email: "asha.personal@gmail.com", linked_at: "2026-03-05T10:00:00+05:30" },
      }),
      "/api/meta/departments": () => ["Mechanical Engineering", "Physics"],
      "/api/claims/counts": () => COUNTS,
      "/api/me/summary": () => ({ papers: 145, unclaimed: 24, returned: 0, money: { to_date: 396703.75 } }),
      "/api/dashboard": () => ({ total_paid: 0 }),
      "/api/me/interests": () => ({ domains: [] }),
      "/api/meta/research-domains": () => ({ domains: [] }),
      ...extra,
    })
  )
  renderWithProviders(<Profile />, { route: "/me" })
  return userEvent.setup()
}

function writes(path: string, method = "POST") {
  return vi
    .mocked(api)
    .mock.calls.filter(
      ([p, options]) => p === path && (options as { method?: string } | undefined)?.method === method
    )
    .map(([, options]) => (options as { json?: unknown }).json)
}

/** The row for one detail: its label, its value and what can be done about it. */
async function row(label: string) {
  const term = await screen.findByText(label, { selector: "dt" })
  return term.closest("[data-detail]") as HTMLElement
}

/** A stand-in for Google Identity Services: renders a button that hands back a token. */
function fakeGoogle() {
  let callback: ((response: { credential: string }) => void) | undefined
  const google: GoogleIdentity = {
    accounts: {
      id: {
        initialize: vi.fn((options) => {
          callback = options.callback
        }),
        renderButton: vi.fn((parent: HTMLElement) => {
          const button = document.createElement("button")
          button.textContent = "Continue with Google"
          button.onclick = () => callback?.({ credential: "id-token-from-google" })
          parent.appendChild(button)
        }),
      },
    },
  }
  vi.mocked(loadGoogleIdentity).mockResolvedValue(google)
  return google
}

describe("Profile — what you change and what the office keeps", () => {
  it("splits the details into the two kinds", async () => {
    mount()
    expect(await screen.findByRole("heading", { name: "Details you can change" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Details the research office keeps" })).toBeInTheDocument()
    expect(screen.getByLabelText("Phone")).toBeInTheDocument()

    const staff = await row("Staff ID")
    expect(within(staff).getByText("STF-1")).toBeInTheDocument()
    expect(within(staff).queryByRole("textbox")).toBeNull()
    expect(within(staff).getByRole("button", { name: /Request a change/ })).toBeInTheDocument()
  })

  it("says in one sentence how complete the profile is, not with the record's figures", async () => {
    mount()
    const box = await screen.findByTestId("profile-readiness")
    expect(box).toHaveTextContent(/of \d are set/)
    // The paper count and the money are Home's job, not this page's.
    expect(screen.queryByRole("group", { name: "At a glance" })).toBeNull()
    expect(within(box).getByText("A phone number").closest("li")).toHaveTextContent("not set yet")
  })

  it("lets the person add a photo from this page", async () => {
    mount()
    expect(await screen.findByRole("button", { name: "Add a photo" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1, name: "Your profile" })).toBeInTheDocument()
  })

  it("keeps the few details a person may want to fix in view and folds the rest", async () => {
    const user = mount()
    await row("Scopus author ID")
    expect(screen.queryByText("Biometric ID", { selector: "dt" })).toBeNull()
    await user.click(screen.getByRole("button", { name: /Show more details/ }))
    expect(await screen.findByText("Biometric ID", { selector: "dt" })).toBeInTheDocument()
  })

  it("saves a phone number through the self-service route", async () => {
    const user = mount()
    await user.type(await screen.findByLabelText("Phone"), "+91 98400 12345")
    await user.click(screen.getByRole("button", { name: "Save details" }))
    await waitFor(() => expect(writes("/api/auth/profile/self", "PATCH")).toHaveLength(1))
    expect(writes("/api/auth/profile/self", "PATCH")[0]).toEqual({ phone: "+91 98400 12345" })
  })

  it("shows the server's reason when a number is refused", async () => {
    const user = mount(me(), {
      "/api/auth/profile/self": failing(400, "That does not look like a phone number."),
    })
    await user.type(await screen.findByLabelText("Phone"), "call me")
    await user.click(screen.getByRole("button", { name: "Save details" }))
    expect(await screen.findByText("That does not look like a phone number.")).toBeInTheDocument()
  })

  it("shows a pending request on the detail it is about", async () => {
    mount(me(), {
      "/api/auth/profile/corrections": () => ({
        results: [
          {
            id: "r-1",
            field: "staff_id",
            label: "Staff ID",
            current_value: "STF-1",
            proposed_value: "STF-2",
            note: "",
            status: "PENDING",
            decision_note: "",
            created_at: "2026-03-05T10:00:00+05:30",
            decided_at: null,
            decided_by: null,
          },
        ],
      }),
    })
    const staff = await row("Staff ID")
    expect(await within(staff).findByText(/Pending/)).toBeInTheDocument()
    expect(within(staff).getByText(/STF-2/)).toBeInTheDocument()
    expect(within(staff).getByRole("button", { name: /Change your request/ })).toBeInTheDocument()
  })

  it("asks for a role as a request, never as an edit", async () => {
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /Show more details/ }))
    const role = await row("Role")
    expect(within(role).getByText("Faculty")).toBeInTheDocument()
    await user.click(within(role).getByRole("button", { name: /Request a change/ }))

    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByLabelText("Proposed role"))
    await user.click(within(dialog).getByRole("option", { name: "Head of department" }))
    await user.click(within(dialog).getByRole("button", { name: "Send request" }))

    await waitFor(() => expect(writes("/api/auth/profile/correction")).toHaveLength(1))
    expect(writes("/api/auth/profile/correction")[0]).toMatchObject({ field: "role", proposed: "HOD" })
  })

  it("shows research faculty their rupee threshold", async () => {
    mount(me({ faculty_type: "RESEARCH" }), {
      "/api/me/research-threshold": () => ({
        research: true,
        threshold: 300000,
        unset: false,
        year: "2026-27",
        used: 120000,
        on_the_way: 0,
        on_the_way_above: 0,
        left: 180000,
        message:
          "You are research faculty. Your threshold this year is ₹3,00,000; ₹1,20,000 used, ₹1,80,000 before incentives are paid.",
      }),
    })
    const threshold = await row("Research threshold")
    expect(within(threshold).getByText("₹3,00,000 a year")).toBeInTheDocument()
    expect(within(threshold).getByText(/₹1,80,000 before incentives are paid/)).toBeInTheDocument()
    // The old papers-a-year quota is not something to ask about any more.
    expect(within(threshold).queryByRole("button", { name: /Request a change/ })).toBeNull()
  })
  it("offers the password change beside Google", async () => {
    mount()
    expect(await screen.findByRole("heading", { name: "Sign-in methods" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Change password" })).toBeInTheDocument()
  })

  it("draws no Google row, and no explanation, when Google is off and nothing is linked", async () => {
    mount(me(), {
      "/api/auth/google/config": () => ({ enabled: false, client_id: null, hosted_domain: null }),
    })
    expect(await screen.findByRole("heading", { name: "Sign-in methods" })).toBeInTheDocument()
    await screen.findByRole("button", { name: "Change password" })
    expect(screen.queryByText(/not available on this server/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Link Google account" })).toBeNull()
  })

  it("saves the phone and the ORCID iD together, sending only what changed", async () => {
    const user = mount()
    await user.type(await screen.findByLabelText("Phone"), "+91 98400 12345")
    await user.type(screen.getByLabelText("ORCID iD"), "0000-0002-1825-0097")
    await user.click(screen.getByRole("button", { name: "Save details" }))
    await waitFor(() => expect(writes("/api/auth/profile/self", "PATCH")).toHaveLength(1))
    expect(writes("/api/auth/profile/self", "PATCH")[0]).toEqual({
      phone: "+91 98400 12345",
      orcid_id: "0000-0002-1825-0097",
    })
  })

  it("keeps Save details off until something has changed", async () => {
    mount()
    expect(await screen.findByRole("button", { name: "Save details" })).toBeDisabled()
  })

  it("links a Google account — any domain — with the token Google hands back", async () => {
    const google = fakeGoogle()
    const user = mount()
    expect(await screen.findByText("Not linked")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Link Google account" }))

    await user.click(await screen.findByRole("button", { name: "Continue with Google" }))
    await waitFor(() => expect(writes("/api/auth/google/link")).toHaveLength(1))
    expect(writes("/api/auth/google/link")[0]).toEqual({ credential: "id-token-from-google" })

    // A personal Gmail must be choosable: no domain hint goes to Google.
    const options = vi.mocked(google.accounts.id.initialize).mock.calls[0][0]
    expect(options.client_id).toBe("client-id.apps.googleusercontent.com")
    expect(options).not.toHaveProperty("hd")
    expect(options).not.toHaveProperty("hosted_domain")
  })

  it("says why a link was refused", async () => {
    fakeGoogle()
    const user = mount(me(), {
      "/api/auth/google/link": failing(
        409,
        "That Google account already belongs to another account here, so it cannot be linked to this one."
      ),
    })
    await user.click(await screen.findByRole("button", { name: "Link Google account" }))
    await user.click(await screen.findByRole("button", { name: "Continue with Google" }))
    expect(await screen.findByText(/already belongs to another account here/)).toBeInTheDocument()
  })

  it("shows which Google account is linked and since when, and unlinks it", async () => {
    const user = mount(
      me({ google: { email: "asha.personal@gmail.com", linked_at: "2026-03-05T10:00:00+05:30" } }),
      { "/api/auth/google/link": () => ({ google: null }) }
    )
    expect(
      await screen.findByText(/Linked to asha\.personal@gmail\.com since 5 Mar 2026/)
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Unlink" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }))
    await waitFor(() => expect(writes("/api/auth/google/link", "DELETE")).toHaveLength(1))
  })
})

describe("what you work on, from your papers", () => {
  const RESEARCH = { topics: [{ id: "mg", label: "Microgrids", papers: 6, recent: 2 }, { id: "bs", label: "Battery storage", papers: 3, recent: 1 }] }

  it("offers your paper topics in one click when nothing is chosen, and saves through the interests endpoint", async () => {
    const user = mount(me(), {
      "/api/me/research": () => RESEARCH,
      "/api/me/interests": () => ({ domains: [] }),
    })
    const group = await screen.findByRole("group", { name: "From your papers" })
    await user.click(within(group).getByRole("button", { name: "Add Microgrids" }))
    await waitFor(() => expect(writes("/api/me/interests", "PUT")).toEqual([{ domains: ["Microgrids"] }]))
  })

  it("adds them all at once", async () => {
    const user = mount(me(), { "/api/me/research": () => RESEARCH })
    const group = await screen.findByRole("group", { name: "From your papers" })
    await user.click(within(group).getByRole("button", { name: "Add all" }))
    await waitFor(() =>
      expect(writes("/api/me/interests", "PUT")).toEqual([{ domains: ["Microgrids", "Battery storage"] }])
    )
  })
})
