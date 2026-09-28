import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Profile } from "@/pages/profile"
import { FACULTY, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/** A person's own Scopus figures, from the office's profile import. */

const PROFILE = {
  scopus_id: "57983494200",
  url: "https://www.scopus.com/authid/detail.uri?authorId=57983494200",
  author_name: null,
  affiliation: null,
  publications: 26,
  citations: 166,
  h_index: 8,
  publications_by_year: {},
  documents_listed: 26,
  source_sheet: "Mr. S. Joyal Isac",
  imported_at: "2026-09-23T08:00:00Z",
}

function mount(scopus: unknown, over: ApiTable = {}) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => ({ ...FACULTY, active: true, must_change_password: false }),
      "/api/auth/profile/corrections": () => ({ results: [] }),
      "/api/meta/departments": () => [],
      "/api/claims/counts": () => ({
        counts: {
          draft: 0, filed: 0, checked: 0, approved: 0, authorised: 0, paid: 0,
          sent_back: 0, all: 0,
        },
      }),
      "/api/dashboard": () => ({ total_paid: 0 }),
      "/api/me/interests": () => ({ domains: [] }),
      "/api/meta/research-domains": () => ({ domains: [] }),
      "/api/me/scopus": () => scopus,
      ...over,
    })
  )
  return renderWithProviders(<Profile />, { route: "/me" })
}

describe("your Scopus profile", () => {
  it("shows the figures with a link to the profile on Scopus", async () => {
    mount({ scopus_ids: ["57983494200"], profile: PROFILE })
    const region = await screen.findByRole("region", { name: /your scopus profile/i })
    expect(await within(region).findByRole("link", { name: /57983494200/ })).toHaveAttribute(
      "href",
      PROFILE.url
    )
    expect(within(region).getByText("166")).toBeInTheDocument()
  })

  it("says why there is none when the account carries no Scopus id", async () => {
    mount({ scopus_ids: [], profile: null })
    const region = await screen.findByRole("region", { name: /your scopus profile/i })
    expect(await within(region).findByText(/carries no scopus id/i)).toBeInTheDocument()
  })
})
