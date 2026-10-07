import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { ApiError, api } from "@/lib/api"
import { AdminStart } from "@/pages/admin-start"
import { MediaImport, type MediaImportReport } from "@/pages/media-import"
import { fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

const ADMIN: Me = { id: "u-admin", email: "a@x.edu", name: "Suresh Admin", role: "SUPER_ADMIN", department: null }

const REPORT: MediaImportReport = {
  added: 794,
  replaced: 0,
  skipped: 6,
  rejected: [
    { name: "avatars/me.jpg", why: "The name is not one this app uses." },
    { name: "claims/notes.txt", why: "Only JPG, PNG, WebP, GIF and PDF files are kept." },
  ],
  rejected_count: 2,
  bytes: 12_373_000,
}

const zip = () => new File(["PK"], "media-2026-10-07.zip", { type: "application/zip" })

function mountImport(handler: (path: string, init?: unknown) => unknown, onDone?: () => void) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(((path: string, init?: unknown) => {
    try {
      return Promise.resolve(handler(path, init))
    } catch (err) {
      return Promise.reject(err)
    }
  }) as typeof api)
  renderWithProviders(<MediaImport onDone={onDone} />)
}

const posted = () => {
  const call = vi.mocked(api).mock.calls.find((c) => c[0] === "/api/admin/media-import")
  return call as [string, { method: string; body: FormData }] | undefined
}

describe("Photos and files: the media zip", () => {
  it("says what it is for in one sentence and cannot be pressed until a zip is chosen", () => {
    mountImport(() => REPORT)
    expect(
      screen.getByText("Upload the media zip from the project folder so faces and claim files appear.")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add the files" })).toBeDisabled()
    expect(screen.getByText("Choose the zip first.")).toBeInTheDocument()
    expect(screen.getByLabelText("Media zip")).toHaveAttribute("accept", expect.stringContaining(".zip"))
  })

  it("leaves 'Overwrite files that already exist' off, and sends the zip with overwrite false", async () => {
    const done = vi.fn()
    mountImport(() => REPORT, done)
    const box = screen.getByRole("checkbox", { name: /Overwrite files that already exist/ })
    expect(box).not.toBeChecked()
    await userEvent.upload(screen.getByLabelText("Media zip"), zip())
    await userEvent.click(screen.getByRole("button", { name: "Add the files" }))
    await waitFor(() => expect(posted()).toBeDefined())
    const [, init] = posted()!
    expect(init.method).toBe("POST")
    expect((init.body.get("file") as File).name).toBe("media-2026-10-07.zip")
    expect(init.body.get("overwrite")).toBe("false")
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  })

  it("sends overwrite true once the box is ticked", async () => {
    mountImport(() => REPORT)
    await userEvent.click(screen.getByRole("checkbox", { name: /Overwrite files that already exist/ }))
    await userEvent.upload(screen.getByLabelText("Media zip"), zip())
    await userEvent.click(screen.getByRole("button", { name: "Add the files" }))
    await waitFor(() => expect(posted()).toBeDefined())
    expect(posted()![1].body.get("overwrite")).toBe("true")
  })

  it("shows it is working, locks the form while it does, then the summary", async () => {
    let finish: (r: MediaImportReport) => void = () => {}
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      (() =>
        new Promise<MediaImportReport>((resolve) => {
          finish = resolve
        })) as typeof api
    )
    renderWithProviders(<MediaImport />)
    await userEvent.upload(screen.getByLabelText("Media zip"), zip())
    await userEvent.click(screen.getByRole("button", { name: "Add the files" }))

    expect(await screen.findByText(/Adding the files\. This can take a minute/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Adding the files/ })).toBeDisabled()
    expect(screen.getByLabelText("Media zip")).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: /Overwrite files that already exist/ })).toBeDisabled()

    finish(REPORT)
    const result = await screen.findByTestId("media-result")
    expect(within(result).getByText(/Added 794 files/)).toBeInTheDocument()
    expect(within(result).getByText(/6 already here, left alone/)).toBeInTheDocument()
    expect(screen.queryByText(/Adding the files\. This can take a minute/)).toBeNull()
    // The zip has been used, so the picker is empty again and nothing is sent twice by a stray click.
    expect(screen.getByRole("button", { name: "Add the files" })).toBeDisabled()
  })

  it("lists each problem with its reason, and keeps the list behind a count", async () => {
    mountImport(() => REPORT)
    await userEvent.upload(screen.getByLabelText("Media zip"), zip())
    await userEvent.click(screen.getByRole("button", { name: "Add the files" }))
    const result = await screen.findByTestId("media-result")
    expect(within(result).getByText(/2 files had a problem and were not added/)).toBeInTheDocument()
    await userEvent.click(within(result).getByRole("button", { name: /Show problems/ }))
    expect(within(result).getByText("avatars/me.jpg")).toBeInTheDocument()
    expect(within(result).getByText(/The name is not one this app uses/)).toBeInTheDocument()
  })

  it("says plainly when nothing was new", async () => {
    mountImport(() => ({ ...REPORT, added: 0, skipped: 794, rejected: [], rejected_count: 0, bytes: 0 }))
    await userEvent.upload(screen.getByLabelText("Media zip"), zip())
    await userEvent.click(screen.getByRole("button", { name: "Add the files" }))
    const result = await screen.findByTestId("media-result")
    expect(within(result).getByText(/Nothing new: all 794 files were already here/)).toBeInTheDocument()
    expect(within(result).queryByText(/problem/)).toBeNull()
  })

  it("says how many it replaced when overwriting", async () => {
    mountImport(() => ({ ...REPORT, added: 10, replaced: 4, skipped: 0, rejected: [], rejected_count: 0 }))
    await userEvent.upload(screen.getByLabelText("Media zip"), zip())
    await userEvent.click(screen.getByRole("button", { name: "Add the files" }))
    expect(await screen.findByText(/4 of them replaced a file that was already here/)).toBeInTheDocument()
  })

  it("says when the server refuses the zip, in the server's words, and reports nothing added", async () => {
    const done = vi.fn()
    mountImport(() => {
      throw new ApiError(400, "That is not a zip file.")
    }, done)
    await userEvent.upload(screen.getByLabelText("Media zip"), zip())
    await userEvent.click(screen.getByRole("button", { name: "Add the files" }))
    expect(await screen.findByText("That is not a zip file.")).toBeInTheDocument()
    expect(screen.queryByTestId("media-result")).toBeNull()
    expect(done).not.toHaveBeenCalled()
    // The same zip can be tried again, or another chosen.
    expect(screen.getByRole("button", { name: "Add the files" })).not.toBeDisabled()
  })
})

const step = (over: Record<string, unknown>) => ({
  key: "files",
  title: "Photos and files",
  state: "todo",
  fact: "12 of 12 photos and files checked are missing from this server. Upload the media zip so faces and claim files appear.",
  to: "/admin/start",
  action: "Add photos and files",
  required: false,
  ...over,
})

const start = (files: Record<string, unknown>) => ({
  checked_at: "",
  done: 0,
  total: 1,
  next: "record",
  complete: false,
  steps: [
    {
      key: "record", title: "Load the college's record", state: "todo", fact: "Nothing is loaded.",
      to: "/imports", action: "Load the record", required: true,
    },
    files,
  ],
})

function mountStart(files: Record<string, unknown>, extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((path: string, ...rest: unknown[]) =>
    fakeApi({
      "/api/auth/me": () => ADMIN,
      "/api/admin/start": () => start(files),
      ...extra,
    })(path, ...(rest as []))
  )
  renderWithProviders(<AdminStart />)
}

describe("the Get the college running page: the photos and files step", () => {
  it("is an extra under 'Also', with the picker right there while the files are missing", async () => {
    mountStart(step({}))
    const row = await screen.findByTestId("start-files")
    expect(within(row).getByText("Photos and files")).toBeInTheDocument()
    expect(within(row).getByText(/12 of 12 photos and files checked are missing/)).toBeInTheDocument()
    expect(within(row).getByLabelText("Media zip")).toBeInTheDocument()
    expect(screen.getByText("Also")).toBeInTheDocument()
    // It is not one of the steps counted towards "N of M steps done".
    expect(screen.getByText("0 of 1 steps done.")).toBeInTheDocument()
  })

  it("tucks the picker away once the files are here, behind 'Add more'", async () => {
    mountStart(step({ state: "done", fact: "The 24 photos and files checked are all here.", action: "Add more" }))
    const row = await screen.findByTestId("start-files")
    expect(within(row).queryByLabelText("Media zip")).toBeNull()
    await userEvent.click(within(row).getByRole("button", { name: "Add more" }))
    expect(within(row).getByLabelText("Media zip")).toBeInTheDocument()
  })

  it("keeps the result on the page after the step turns done", async () => {
    let state = "todo"
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(((path: string, init?: { method?: string }) => {
      if (path === "/api/admin/media-import" && init?.method === "POST") {
        state = "done"
        return Promise.resolve(REPORT)
      }
      return fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/admin/start": () => start(step({ state })),
      })(path)
    }) as typeof api)
    renderWithProviders(<AdminStart />)
    const row = await screen.findByTestId("start-files")
    await userEvent.upload(within(row).getByLabelText("Media zip"), zip())
    await userEvent.click(within(row).getByRole("button", { name: "Add the files" }))
    await waitFor(() => expect(screen.getByTestId("start-files")).toHaveAttribute("data-state", "done"))
    expect(within(screen.getByTestId("start-files")).getByTestId("media-result")).toHaveTextContent(/Added 794 files/)
  })
})
