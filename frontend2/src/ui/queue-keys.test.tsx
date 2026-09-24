import { useRef } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { useSlashToSearch } from "@/ui/queue-keys"

function Queue() {
  const search = useRef<HTMLInputElement>(null)
  useSlashToSearch(search)
  return (
    <>
      <input ref={search} aria-label="Search the queue" />
      <textarea aria-label="A note" />
    </>
  )
}

describe("useSlashToSearch", () => {
  it("puts the cursor in the queue's search box when / is pressed", async () => {
    const user = userEvent.setup()
    render(<Queue />)
    await user.keyboard("/")
    expect(screen.getByLabelText("Search the queue")).toHaveFocus()
    // The slash itself is not typed into the box.
    expect(screen.getByLabelText("Search the queue")).toHaveValue("")
  })

  it("leaves a / typed into another field alone", async () => {
    const user = userEvent.setup()
    render(<Queue />)
    await user.click(screen.getByLabelText("A note"))
    await user.keyboard("a/b")
    expect(screen.getByLabelText("A note")).toHaveValue("a/b")
    expect(screen.getByLabelText("A note")).toHaveFocus()
  })
})
