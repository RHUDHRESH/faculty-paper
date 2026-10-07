import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { MessagesChat } from "@/pages/messages"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

const RAVI = { id: "u-ravi", name: "Ravi Kumar", initials: "RK", photo_url: null, department: "Physics", designation: "Professor" }
const ME_BRIEF = { id: FACULTY.id, name: FACULTY.name, initials: "AM", photo_url: null }

describe("the inbox after sending", () => {
  it("shows the message just sent instead of 'No messages yet'", async () => {
    let sentBody: string | null = null
    const now = new Date().toISOString()
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/people/": () => ({ inside: [] }),
        "/api/dm": () => ({
          results: [
            {
              id: "t1",
              kind: "dm",
              is_group: false,
              title: "Ravi Kumar",
              people: [RAVI],
              unread: 0,
              updated_at: now,
              last: sentBody ? { body: sentBody, at: now, mine: true } : null,
            },
          ],
        }),
        "/api/dm/t1": () => ({
          id: "t1",
          is_group: false,
          title: "Ravi Kumar",
          people: [RAVI],
          participants: [
            { ...RAVI, me: false, last_read_at: null },
            { ...ME_BRIEF, me: true, last_read_at: now },
          ],
          messages: [],
          may_post: true,
        }),
        "/api/dm/t1/messages": () => {
          sentBody = "Hello Ravi"
          return { id: "m9", author: ME_BRIEF, kind: "HUMAN", body: "Hello Ravi", deleted: false, created_at: now, mine: true, collab: null }
        },
      })
    )
    renderWithProviders(
      <Routes>
        <Route path="/messages/c/:id" element={<MessagesChat />} />
      </Routes>,
      { route: "/messages/c/t1" }
    )
    const user = userEvent.setup()
    const inbox = await screen.findByRole("complementary", { name: "Conversations" })
    expect(await within(inbox).findByText("No messages yet")).toBeInTheDocument()

    await user.type(await screen.findByRole("textbox", { name: "Write a message" }), "Hello Ravi{Enter}")
    expect(await within(inbox).findByText("You: Hello Ravi")).toBeInTheDocument()
    expect(within(inbox).queryByText("No messages yet")).not.toBeInTheDocument()
  })
})
