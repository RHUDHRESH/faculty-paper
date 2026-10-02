import { fireEvent, screen, waitFor } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { CrashGuard } from "@/pages/crash"
import { Help } from "@/pages/help"
import { NotFound, RoleGate } from "@/pages/not-found"
import { BadgeStrip } from "@/pages/person-social"
import { Privacy } from "@/pages/privacy"
import { Setup } from "@/pages/setup"
import { FACULTY, FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

/**
 * The shared views (docs/audit/shared): what a faculty member must not be shown
 * (the chain of offices), what every screen must have (a way out of a crash,
 * a real setup step), and the small changes that keep long lists short.
 */

const mockedApi = vi.mocked(api)

const badge = (n: number) => ({
  id: `b${n}`,
  kind: "PAPERS_5",
  key: `k${n}`,
  label: `Badge ${n}`,
  description: "",
  detail: "",
  earned_on: "2025-01-01",
  evidence: { title: `Paper ${n}`, journal: "J", year: 2025 },
  claim_id: null,
})

beforeEach(() => {
  mockedApi.mockReset()
})

describe("Help", () => {
  it("shows a faculty member only their own guides, not the other offices'", async () => {
    mockedApi.mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY }) as typeof api)
    renderWithProviders(<Help />, { route: "/help?role=DIRECTOR" })
    expect(await screen.findByRole("heading", { name: "File a paper" })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: /Director/ })).toBeNull()
    expect(screen.queryByRole("tab", { name: /Finance/ })).toBeNull()
    // The asked-for role is ignored: the Director's guides never draw.
    expect(screen.queryByText(/authorise/i, { selector: "h2" })).toBeNull()
    expect(screen.getByRole("link", { name: /Ask the research office/ })).toHaveAttribute("href", "/messages/office")
  })

  it("lets an office read the other offices' guides", async () => {
    mockedApi.mockImplementation(fakeApi({ "/api/auth/me": () => FINANCE }) as typeof api)
    renderWithProviders(<Help />, { route: "/help" })
    expect(await screen.findByRole("tab", { name: /Director/ })).toBeInTheDocument()
  })
})

describe("RoleGate", () => {
  it("answers a faculty member at an office page with the plain screen, and never names the office", async () => {
    mockedApi.mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY }) as typeof api)
    renderWithProviders(
      <Routes>
        <Route element={<RoleGate />}>
          <Route path="/payments" element={<p>The payments page</p>} />
          <Route path="/papers" element={<p>My papers</p>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>,
      { route: "/payments" }
    )
    expect(await screen.findByText("Not open to this account")).toBeInTheDocument()
    expect(screen.queryByText("The payments page")).toBeNull()
    expect(screen.queryByText(/Payments is a real page/)).toBeNull()
    expect(screen.getByText(/Ask the research office/)).toBeInTheDocument()
  })

  it("lets the office through", async () => {
    mockedApi.mockImplementation(fakeApi({ "/api/auth/me": () => FINANCE }) as typeof api)
    renderWithProviders(
      <Routes>
        <Route element={<RoleGate />}>
          <Route path="/payments" element={<p>The payments page</p>} />
        </Route>
      </Routes>,
      { route: "/payments" }
    )
    expect(await screen.findByText("The payments page")).toBeInTheDocument()
  })
})

describe("CrashGuard", () => {
  it("draws a way out instead of a blank page, and says reload for a stale build", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    function Broken(): never {
      throw new Error("Failed to fetch dynamically imported module: /assets/x.js")
    }
    renderWithProviders(
      <CrashGuard>
        <Broken />
      </CrashGuard>
    )
    expect(await screen.findByText("This page has been updated")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload the page" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/")
    spy.mockRestore()
  })

  it("names an ordinary failure and keeps the words plain", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    function Broken(): never {
      throw new Error("x is undefined")
    }
    renderWithProviders(
      <CrashGuard>
        <Broken />
      </CrashGuard>
    )
    expect(await screen.findByText("This page could not be drawn")).toBeInTheDocument()
    expect(screen.getByText(/Something on this page failed/)).toBeInTheDocument()
    spy.mockRestore()
  })
})

describe("BadgeStrip", () => {
  it("shows the newest three and opens the rest on request", async () => {
    mockedApi.mockImplementation(
      fakeApi({ "/api/auth/me": () => FACULTY, "/api/users/u-x/badges": () => ({ badges: [1, 2, 3, 4, 5].map(badge) }) }) as typeof api
    )
    renderWithProviders(<BadgeStrip userId="u-x" />)
    expect(await screen.findByText("Badge 1")).toBeInTheDocument()
    expect(screen.queryByText("Badge 4")).toBeNull()
    expect(screen.getByText("5 earned")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Show all 5 badges" }))
    expect(screen.getByText("Badge 5")).toBeInTheDocument()
  })

  it("draws nothing on somebody else's page when there are none", async () => {
    mockedApi.mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY, "/api/users/u-x/badges": () => ({ badges: [] }) }) as typeof api)
    const { container } = renderWithProviders(<BadgeStrip userId="u-x" />)
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/api/users/u-x/badges"))
    expect(container.querySelector("#badges")).toBeNull()
  })
})

describe("Privacy", () => {
  it("does not spell out the order offices see a claim in", async () => {
    mockedApi.mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY, "/api/institution": () => ({ college_name: "Saveetha" }) }) as typeof api)
    renderWithProviders(<Privacy />)
    expect(await screen.findByRole("heading", { name: "Who sees it" })).toBeInTheDocument()
    expect(screen.queryByText(/Principal/)).toBeNull()
    expect(screen.queryByText(/Director/)).toBeNull()
    expect(screen.queryByText(/Finance pays/)).toBeNull()
  })
})

describe("Setup", () => {
  it("has a review step, so the third of three steps is not blank", async () => {
    mockedApi.mockImplementation(fakeApi({ "/api/setup/status": () => ({ needs_setup: true }) }) as typeof api)
    renderWithProviders(<Setup />, { route: "/setup" })
    const name = await screen.findByLabelText("College name")
    fireEvent.change(name, { target: { value: "Test College" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(await screen.findByLabelText("Administrator name"), { target: { value: "Asha Rao" } })
    fireEvent.change(screen.getByLabelText("Administrator email"), { target: { value: "asha@test.edu" } })
    const pw = screen.getAllByLabelText(/password/i)
    fireEvent.change(pw[0], { target: { value: "a-long-password-1" } })
    fireEvent.change(pw[1], { target: { value: "a-long-password-1" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(await screen.findByText("Check and create")).toBeInTheDocument()
    expect(screen.getByText("Test College")).toBeInTheDocument()
    expect(screen.getByText("asha@test.edu")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create the system" })).toBeEnabled()
  })
})
