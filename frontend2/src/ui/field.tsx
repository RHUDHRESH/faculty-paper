import {
  cloneElement,
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type Ref,
} from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { Check, Eye, EyeOff } from "lucide-react"

import { cn } from "@/lib/cn"

/**
 * Every control on a form, drawn once.
 *
 * `sign-in.tsx` hand-rolled an input and a password field because there was
 * nothing to reach for. That is the failure mode this file closes: the next
 * screen that needs a text field either imports `Input` or reinvents its
 * ring colour, its focus width and its disabled opacity slightly differently,
 * and five screens later "the input" is five inputs.
 */

type Size = "md" | "lg"

const CONTROL_SIZE: Record<Size, string> = {
  md: "h-8 px-2.5 text-sm rounded-md",
  lg: "h-10 px-3 text-base rounded-md",
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === "function") ref(node)
      else (ref as { current: T | null }).current = node
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Field                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * The label, hint and error around one control, wired up so nobody has to
 * remember how.
 *
 * `htmlFor`/`id` pairing, `aria-describedby` and `aria-invalid` are the kind
 * of thing that is correct in the first form and quietly missing in the
 * tenth, because `useId` collisions and copy-pasted `id="email"` strings
 * don't fail loudly — a screen reader user just stops hearing the hint. This
 * generates the id once and clones it onto the control, so the pairing
 * cannot drift from the label.
 */
export function Field<
  P extends {
    id?: string
    "aria-describedby"?: string
    "aria-invalid"?: boolean | "true" | "false"
  },
>({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactElement<P>
  className?: string
}) {
  const id = useId()
  const hintId = hint && !error ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined

  const control = cloneElement(
    children,
    {
      id,
      "aria-describedby": describedBy,
      "aria-invalid": error ? true : undefined,
    } as Partial<P>
  )

  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {control}
      {hintId && (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {errorId && (
        <p id={errorId} role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Input                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * A single line of text. 32px by default, 40px (`lg`) for the forms — sign
 * in, the rare full-screen dialog — that stand alone on a page.
 *
 * `shadow-well` — a one-pixel inner shadow along the top edge — is on every
 * control you type into, and on none of the ones you click. It is the
 * cheapest possible statement of "text goes in here": a form of eight
 * outlined rectangles on a white page gives a reader nothing to distinguish
 * an input from a read-only value in a box, and they find out which is which
 * by clicking. The recess says it before the click. `Checkbox` and `Radio`
 * deliberately do not get it — an inner shadow inside a 16px box is mud.
 */
export const Input = forwardRef<
  HTMLInputElement,
  // The native `size` attribute (character width) is not a thing this app
  // uses, so it is repurposed here for the control's height instead.
  Omit<React.ComponentProps<"input">, "size"> & { size?: Size }
>(function Input({ className, size = "md", ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full bg-surface text-fg outline-none",
        "shadow-well ring-1 ring-inset ring-field",
        "placeholder:text-fg-subtle",
        "focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:cursor-not-allowed disabled:bg-sunken disabled:opacity-50",
        "aria-invalid:ring-critical",
        CONTROL_SIZE[size],
        className
      )}
      {...props}
    />
  )
})

/* ------------------------------------------------------------------------ */
/* PasswordInput                                                            */
/* ------------------------------------------------------------------------ */

/**
 * `Input` plus a reveal toggle and a caps-lock warning.
 *
 * This system hands out 24-character random passwords on paper, and five
 * wrong attempts locks the account. A masked field that cannot be read back
 * turns a mistyped `l`/`1` or an unnoticed caps lock into a lockout, so the
 * toggle is not a nicety here — it is what stands between "typed it wrong"
 * and a support ticket. It sits at `tabIndex={-1}`: Tab from the field must
 * reach the submit button, not a button nobody tabbed here for.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type" | "size"> & { size?: Size }
>(function PasswordInput({ className, size = "md", onKeyUp, onBlur, ...props }, ref) {
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)

  return (
    <div>
      <div className="relative">
        <Input
          ref={ref}
          type={shown ? "text" : "password"}
          size={size}
          className={cn(size === "lg" ? "pr-10" : "pr-8", className)}
          onKeyUp={(e) => {
            setCaps(e.getModifierState?.("CapsLock") ?? false)
            onKeyUp?.(e)
          }}
          onBlur={(e) => {
            setCaps(false)
            onBlur?.(e)
          }}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          className={cn(
            "absolute top-1/2 grid -translate-y-1/2 place-items-center rounded-sm",
            "text-fg-subtle hover:text-fg",
            size === "lg" ? "right-1 size-8" : "right-0.5 size-7"
          )}
        >
          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {caps && (
        <p role="status" className="mt-1.5 text-xs text-caution">
          Caps lock is on.
        </p>
      )}
    </div>
  )
})

/* ------------------------------------------------------------------------ */
/* Textarea                                                                  */
/* ------------------------------------------------------------------------ */

// text-base line height (1.5rem) plus the py-2 padding this control uses.
const TEXTAREA_LINE_PX = 24
const TEXTAREA_PAD_PX = 16

/**
 * Grows with what is typed, up to `maxRows`, then scrolls like any other
 * text field. A fixed-height textarea for a rejection reason or a paper's
 * abstract either wastes half the form on whitespace or clips the third
 * sentence with no sign there was a third sentence.
 */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea"> & { maxRows?: number }
>(function Textarea({ className, maxRows = 6, rows = 2, style, onInput, ...props }, ref) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const maxHeight = TEXTAREA_LINE_PX * maxRows + TEXTAREA_PAD_PX

  const resize = useCallback(() => {
    const el = innerRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [maxHeight])

  // Runs on mount and whenever a controlled `value` changes from outside
  // (cleared after submit, prefilled by a query) — not only on typing.
  useLayoutEffect(resize, [resize, props.value])

  return (
    <textarea
      ref={mergeRefs(ref, innerRef)}
      rows={rows}
      onInput={(e) => {
        resize()
        onInput?.(e)
      }}
      style={{ maxHeight, ...style } as CSSProperties}
      className={cn(
        "w-full resize-none rounded-md bg-surface px-3 py-2 text-base text-fg outline-none",
        "shadow-well ring-1 ring-inset ring-field",
        "placeholder:text-fg-subtle",
        "focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:cursor-not-allowed disabled:bg-sunken disabled:opacity-50",
        "aria-invalid:ring-critical",
        className
      )}
      {...props}
    />
  )
})

/* ------------------------------------------------------------------------ */
/* Checkbox                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * 16px, hand-drawn, never the OS tick. Radix gives it a real checked/
 * indeterminate state machine and keyboard handling; every pixel — the
 * ring, the fill, the mark — is drawn here so it cannot show up as a
 * different shape of box on Windows than on macOS the way an unstyled
 * `<input type="checkbox">` does.
 */
/**
 * A control with its label beside it.
 *
 * Checkbox, radio and switch put their label to the side rather than above,
 * so `Field` is the wrong shape for them. Without this, every caller writes
 * its own `<label>` wrapper — and the one that forgets the association is the
 * one nobody notices, because it looks identical and only fails for the
 * person using a screen reader or clicking the words instead of the box.
 */
function SideLabel({
  id,
  label,
  hint,
  disabled,
  children,
}: {
  id: string
  label?: React.ReactNode
  hint?: React.ReactNode
  disabled?: boolean
  children: React.ReactNode
}) {
  if (!label) return <>{children}</>
  return (
    <span className={cn("inline-flex items-start gap-2", disabled && "opacity-50")}>
      {children}
      <label
        htmlFor={id}
        className={cn("select-none text-base leading-5", !disabled && "cursor-pointer")}
      >
        {label}
        {hint ? (
          <span className="block text-sm text-fg-muted">{hint}</span>
        ) : null}
      </label>
    </span>
  )
}

export const Checkbox = forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentProps<typeof CheckboxPrimitive.Root> & {
    label?: React.ReactNode
    hint?: React.ReactNode
  }
>(function Checkbox({ className, label, hint, id, ...props }, ref) {
  const auto = useId()
  const controlId = id || auto
  return (
    <SideLabel id={controlId} label={label} hint={hint} disabled={props.disabled}>
    <CheckboxPrimitive.Root
      id={controlId}
      ref={ref}
      className={cn(
        "peer size-4 shrink-0 rounded-sm bg-surface outline-none",
        "ring-1 ring-inset ring-field",
        "data-[state=checked]:bg-accent data-[state=checked]:ring-accent",
        "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:ring-critical",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center text-accent-fg">
        <Check className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
    </SideLabel>
  )
})

/* ------------------------------------------------------------------------ */
/* Radio                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * 16px, hand-drawn, same ring as `Checkbox`.
 *
 * There is no Radix radio-group in this project's dependencies, and adding
 * one to style three pixels is not this file's call to make. A native
 * `<input type="radio">` already gives a group arrow-key navigation and
 * correct single-selection for free — `appearance-none` strips its default
 * skin and a sibling dot replaces it, so the behaviour stays native and only
 * the paint changes.
 */
export const Radio = forwardRef<
  HTMLInputElement,
  React.ComponentProps<"input"> & { label?: React.ReactNode; hint?: React.ReactNode }
>(
  function Radio({ className, label, hint, id, ...props }, ref) {
    const auto = useId()
    const controlId = id || auto
    return (
      <SideLabel id={controlId} label={label} hint={hint} disabled={props.disabled}>
      <span className="relative inline-grid size-4 shrink-0 place-items-center">
        <input
          id={controlId}
          ref={ref}
          type="radio"
          className={cn(
            "peer col-start-1 row-start-1 size-4 shrink-0 appearance-none rounded-full outline-none",
            "bg-surface ring-1 ring-inset ring-field",
            "checked:ring-accent",
            "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "aria-invalid:ring-critical",
            className
          )}
          {...props}
        />
        <span className="pointer-events-none col-start-1 row-start-1 hidden size-1.5 rounded-full bg-accent peer-checked:block peer-disabled:opacity-50" />
      </span>
      </SideLabel>
    )
  }
)

/* ------------------------------------------------------------------------ */
/* Switch                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * For a setting that takes effect the moment it is flipped — nothing else.
 *
 * A switch says "this is already true"; a checkbox beside a Save button
 * says "this will become true when you submit". Putting a switch on a form
 * that still needs Save is the tell that it should have been a checkbox —
 * the control promised an effect the form did not deliver.
 */
export const Switch = forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentProps<"button">, "onChange"> & {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    label?: React.ReactNode
    hint?: React.ReactNode
  }
>(function Switch(
  { className, checked, onCheckedChange, disabled, label, hint, id, ...props },
  ref
) {
  const auto = useId()
  const controlId = id || auto
  return (
    <SideLabel id={controlId} label={label} hint={hint} disabled={disabled}>
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors duration-[var(--dur-2)] ease-out",
        checked ? "bg-accent" : "bg-fg-subtle",
        "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "block size-4 translate-x-0.5 rounded-full bg-surface transition-transform duration-[var(--dur-2)] ease-out",
          checked && "translate-x-[1.125rem]"
        )}
      />
    </button>
    </SideLabel>
  )
})

/* ------------------------------------------------------------------------ */
/* NumberInput                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Right-aligned and tabular, because a number that is about to be compared
 * against the one above it has to line up on its last digit, not its first.
 * The unit sits inside the field (`₹`, `pages`, `%`) rather than as a
 * separate label, so it reads as part of the value instead of a caption
 * that can drift away from it in a narrow column.
 */
export const NumberInput = forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "size"> & { size?: Size; unit?: string }
>(function NumberInput({ className, size = "md", unit, ...props }, ref) {
  return (
    <div className="relative">
      <input
        ref={ref}
        type="number"
        inputMode="decimal"
        className={cn(
          "w-full bg-surface text-right text-fg tabular-nums outline-none",
          "shadow-well ring-1 ring-inset ring-field",
          "focus-visible:ring-2 focus-visible:ring-accent",
          "disabled:cursor-not-allowed disabled:bg-sunken disabled:opacity-50",
          "aria-invalid:ring-critical",
          // The browser's up/down spinner does not line up with a
          // right-aligned unit sitting beside it — the field draws its own
          // affordance for "this is a number" via alignment instead.
          "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          unit && "pr-9",
          CONTROL_SIZE[size],
          className
        )}
        {...props}
      />
      {unit && (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
          {unit}
        </span>
      )}
    </div>
  )
})

/* ------------------------------------------------------------------------ */
/* DateInput                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * A native `type="date"` in the house colours, and deliberately nothing
 * more. A custom calendar looks better in a screenshot and worse in a form:
 * it forgets the locale's day order, it cannot be typed into from the
 * keyboard the way `dd/mm/yyyy` can, and every "polished" one this app's
 * predecessor could reach for was how date entry got worse, not better.
 */
export const DateInput = forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "size"> & { size?: Size }
>(function DateInput({ className, size = "md", ...props }, ref) {
  return (
    <input
      ref={ref}
      type="date"
      className={cn(
        "w-full bg-surface text-fg outline-none [color-scheme:light]",
        "shadow-well ring-1 ring-inset ring-field",
        "focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:cursor-not-allowed disabled:bg-sunken disabled:opacity-50",
        "aria-invalid:ring-critical",
        CONTROL_SIZE[size],
        className
      )}
      {...props}
    />
  )
})
