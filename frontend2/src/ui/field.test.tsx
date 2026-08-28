import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Combobox } from "@/ui/combobox"
import { Checkbox, Field, Input, PasswordInput, Switch } from "@/ui/field"

/**
 * The accessibility wiring that typechecks whether or not it is there.
 *
 * `Field` clones `id`, `aria-describedby` and `aria-invalid` onto its child.
 * Every one of those props is optional on every control, so a control that
 * drops one compiles, renders identically, and silently stops announcing its
 * hint or its error. That is exactly what `Combobox` did until recently, and
 * nothing in `npm run check` could have noticed.
 */

const DEPARTMENTS = [
  { value: "mech", label: "Mechanical Engineering" },
  { value: "cse", label: "Computer Science" },
  { value: "bio", label: "Biomechanics" },
]

/* ------------------------------------------------------------------------ */
/* Field + Input                                                             */
/* ------------------------------------------------------------------------ */

describe("Field", () => {
  it("gives its control the label as an accessible name", () => {
    render(
      <Field label="Voucher number">
        <Input />
      </Field>
    )
    expect(screen.getByLabelText("Voucher number")).toBeInTheDocument()
  })

  it("points the control at its hint", () => {
    render(
      <Field label="Ticket" hint="Eight digits, no spaces.">
        <Input />
      </Field>
    )
    const input = screen.getByLabelText("Ticket")
    expect(input).toHaveAccessibleDescription("Eight digits, no spaces.")
  })

  it("points the control at its error and marks it invalid", () => {
    render(
      <Field label="Amount" error="Enter an amount above zero.">
        <Input />
      </Field>
    )
    const input = screen.getByLabelText("Amount")
    expect(input).toHaveAccessibleDescription("Enter an amount above zero.")
    expect(input).toHaveAttribute("aria-invalid", "true")
  })

  it("does not claim an error when there is none", () => {
    render(
      <Field label="Amount">
        <Input />
      </Field>
    )
    expect(screen.getByLabelText("Amount")).not.toHaveAttribute("aria-invalid")
  })

  it("generates a fresh id per field, so two forms on a page do not collide", () => {
    render(
      <>
        <Field label="First">
          <Input />
        </Field>
        <Field label="Second">
          <Input />
        </Field>
      </>
    )
    const first = screen.getByLabelText("First")
    const second = screen.getByLabelText("Second")
    expect(first.id).not.toBe("")
    expect(first.id).not.toBe(second.id)
  })
})

/* ------------------------------------------------------------------------ */
/* Field + Combobox — the regression                                         */
/* ------------------------------------------------------------------------ */

describe("Combobox inside a Field", () => {
  it("takes the label as its accessible name", () => {
    render(
      <Field label="Department">
        <Combobox value={null} onChange={() => {}} options={DEPARTMENTS} />
      </Field>
    )
    expect(screen.getByRole("button", { name: "Department" })).toBeInTheDocument()
  })

  it("forwards aria-describedby, so the hint is still announced", () => {
    // Destructuring only some of Field's cloned props dropped the hint from
    // every <Field><Combobox/></Field> in the app, and it typechecked either
    // way because all three props are optional.
    render(
      <Field label="Department" hint="31 departments. Type to filter.">
        <Combobox value={null} onChange={() => {}} options={DEPARTMENTS} />
      </Field>
    )
    expect(screen.getByRole("button", { name: "Department" })).toHaveAccessibleDescription(
      "31 departments. Type to filter."
    )
  })

  it("forwards aria-invalid and the error text", () => {
    render(
      <Field label="Department" error="Choose a department.">
        <Combobox value={null} onChange={() => {}} options={DEPARTMENTS} />
      </Field>
    )
    const trigger = screen.getByRole("button", { name: "Department" })
    expect(trigger).toHaveAttribute("aria-invalid", "true")
    expect(trigger).toHaveAccessibleDescription("Choose a department.")
  })

  it("filters on what is typed, prefix matches first", async () => {
    const onChange = vi.fn()
    render(
      <Field label="Department">
        <Combobox value={null} onChange={onChange} options={DEPARTMENTS} />
      </Field>
    )
    await userEvent.click(screen.getByRole("button", { name: "Department" }))
    await userEvent.type(screen.getByRole("combobox"), "mech")

    const options = screen.getAllByRole("option")
    // "Mechanical Engineering" starts with the term; "Biomechanics" only
    // contains it, so it comes second rather than alphabetically first.
    expect(options.map((o) => o.textContent)).toEqual([
      "Mechanical Engineering",
      "Biomechanics",
    ])

    await userEvent.click(options[0])
    expect(onChange).toHaveBeenCalledWith("mech")
  })
})

/* ------------------------------------------------------------------------ */
/* Icon-only controls                                                        */
/* ------------------------------------------------------------------------ */

describe("icon-only controls carry a name", () => {
  it("names the password reveal toggle, and keeps it out of the tab order", () => {
    // An unlabelled eye glyph is "button" to a screen reader. This one is
    // the difference between a mistyped password and a locked account, so
    // it has to say which way it will go.
    render(
      <Field label="Password">
        <PasswordInput />
      </Field>
    )
    const toggle = screen.getByRole("button", { name: "Show password" })
    expect(toggle).toHaveAttribute("tabindex", "-1")
  })

  it("changes the toggle's name when the password is revealed", async () => {
    render(
      <Field label="Password">
        <PasswordInput />
      </Field>
    )
    await userEvent.click(screen.getByRole("button", { name: "Show password" }))
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument()
  })
})

/* ------------------------------------------------------------------------ */
/* Side-labelled controls                                                    */
/* ------------------------------------------------------------------------ */

describe("controls whose label sits beside them", () => {
  it("associates a checkbox with its own label", () => {
    render(<Checkbox label="Only show unpaid" />)
    expect(screen.getByRole("checkbox", { name: "Only show unpaid" })).toBeInTheDocument()
  })

  /**
   * Was a live defect; now the guard against it returning.
   *
   * `Switch` computed `controlId`, handed it to `SideLabel` — which renders
   * `<label htmlFor={controlId}>` — and never put `id={controlId}` on the
   * `<button role="switch">`. The label pointed at nothing: the switch had no
   * accessible name and clicking its words did not flip it, while `Checkbox`
   * and `Radio` three lines away both set the id correctly.
   *
   * It was written as `it.fails` while `field.tsx` was out of scope, which is
   * how a known bug stays visible without turning the suite red. The id is on
   * the button now, so this is an ordinary assertion again.
   */
  it("associates a switch with its own label", () => {
    render(<Switch checked={false} onCheckedChange={() => {}} label="Email me on approval" />)
    expect(screen.getByRole("switch", { name: "Email me on approval" })).toBeInTheDocument()
  })
})
