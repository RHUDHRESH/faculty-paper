import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { EmptyState, ErrorState, InlineError } from "@/ui/state"

/**
 * CONVENTIONS rule 5: never render an error as an empty state.
 *
 * The rule is only worth writing down if a machine can check it, and the
 * only way a machine can check it is by asserting that the two components
 * are not interchangeable — different role, different ground, and a way out
 * of the failure that the empty state does not have and must not need.
 */

describe("EmptyState and ErrorState are not the same thing", () => {
  it("only the error announces itself as an alert", () => {
    // The difference a screen reader gets. An empty tray is not urgent; a
    // failed request is, and a reader who cannot see the colour has nothing
    // else to go on.
    const { unmount } = render(
      <EmptyState title="Nothing filed yet" message="File a paper to start." />
    )
    expect(screen.queryByRole("alert")).toBeNull()
    unmount()

    render(<ErrorState />)
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("stands on a different ground, so they differ before either is read", () => {
    // The distinction a sighted reader gets from across the room, and the
    // one that regressed: an error drawn on neutral `sunken` is an empty
    // state wearing an error's words.
    const { container: empty } = render(
      <EmptyState title="Nothing filed yet" message="File a paper to start." />
    )
    const emptyGround = empty.firstElementChild
    expect(emptyGround).toHaveClass("bg-sunken")
    expect(emptyGround).not.toHaveClass("bg-critical-wash")

    const { container: failed } = render(<ErrorState />)
    const errorGround = failed.firstElementChild
    expect(errorGround).toHaveClass("bg-critical-wash")
    expect(errorGround).not.toHaveClass("bg-sunken")
  })

  it("says the server did not answer, and that nothing was lost", () => {
    // The sentence is the whole product here. "No papers" would be a lie.
    render(<ErrorState />)
    expect(screen.getByText(/could not load/i)).toBeInTheDocument()
    expect(screen.getByText(/nothing has been deleted or lost/i)).toBeInTheDocument()
  })

  it("offers a way out of the failure", () => {
    // "Reload the page" is not a plan, so the retry is part of the
    // component rather than left to each caller to remember.
    const onRetry = vi.fn()
    render(<ErrorState onRetry={onRetry} />)
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument()
  })

  it("retries when asked", async () => {
    const onRetry = vi.fn()
    render(<ErrorState onRetry={onRetry} />)
    await userEvent.click(screen.getByRole("button", { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe("InlineError", () => {
  it("is an alert too, for a failure inside one section of a page", () => {
    render(<InlineError message="Could not load the totals." />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("Could not load the totals.")
    expect(alert).toHaveClass("bg-critical-wash")
  })
})
