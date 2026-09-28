import { useEffect, useState, type FormEvent } from "react"
import { LoaderCircle } from "lucide-react"

import { useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { queryClient, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, PasswordInput } from "@/ui/field"
import { toast } from "@/ui/toast"

/**
 * Choosing a new password — both the forced first-sign-in path and the
 * ordinary "change it because I want to" one.
 *
 * This lives in `app/` rather than on the profile page because of where the
 * forced path has to work. 498 of the 508 live accounts carry
 * `must_change_password`: they were issued a 24-character password typed off
 * a printed sheet, and every one of them is meant to replace it before doing
 * anything else. Mounting the dialog only on `/me` meant the forced path
 * fired only for somebody who had already navigated to their profile —
 * which is to say, almost never. A claimant signed in, landed on their own
 * home, and was never asked.
 *
 * So `ForcePasswordChange` is mounted once by the app itself, beside the
 * command palette, and covers every route. The profile page keeps the manual
 * button and renders the same dialog for it, so the two paths cannot drift
 * into behaving differently.
 */

/**
 * The forced path, mounted once for the whole app.
 *
 * It renders nothing at all for an account that does not owe a password
 * change, and cannot be dismissed by one that does.
 */
export function ForcePasswordChange() {
  const { me, refresh } = useAuth()
  // Viewing as somebody is read-only; their password is theirs to change.
  if (!me?.must_change_password || me.impersonated_by) return null
  return (
    <PasswordDialog
      forced
      manualOpen={false}
      // There is nothing to close: while the flag is set the dialog stays
      // open regardless, and once the change succeeds `refresh()` clears the
      // flag, which unmounts this component entirely.
      onManualOpenChange={() => {}}
      // Every request the page made while the change was owed was refused, and
      // those refusals are cached: without the reset the first thing somebody
      // sees after choosing a password is "Could not load your record".
      onSuccess={async () => {
        await refresh()
        await queryClient.resetQueries()
      }}
    />
  )
}

/**
 * A rough strength reading: length first, then variety. It advises; only
 * the 8-character rule is enforced.
 */
export function passwordStrength(pw: string): { score: 1 | 2 | 3 | 4; label: string; bar: string } {
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  let score: 1 | 2 | 3 | 4 = 1
  if (pw.length >= 8) score = 2
  if (pw.length >= 10 && kinds >= 3) score = 3
  if ((pw.length >= 12 && kinds >= 3) || pw.length >= 16) score = 4
  if (/^(.)\1*$/.test(pw)) score = 1
  const table = {
    1: { label: "Too weak", bar: "bg-critical" },
    2: { label: "Fair", bar: "bg-caution" },
    3: { label: "Good", bar: "bg-positive" },
    4: { label: "Strong", bar: "bg-positive" },
  } as const
  return { score, ...table[score] }
}

/* ------------------------------------------------------------------------ */
/* Password dialog                                                          */
/* ------------------------------------------------------------------------ */

/**
 * The password form, forced open on a first sign-in with an issued
 * password and otherwise opened by choice from the button above.
 *
 * The bug this must not reproduce: the old app rendered `open ||
 * must_change_password` and its forced-path success handler set `open` to
 * false without also clearing `must_change_password` first — so the very
 * next render read the flag, which was still true, and reopened the dialog
 * on top of its own "password changed" toast. There is no `open` variable
 * here for that to happen to. `open` is not state this component owns; it
 * is computed fresh every render as `forced || manualOpen`, so there is no
 * stale `true` left over from a previous render for either half to disagree
 * with — closing the dialog always means both reasons it could be open are
 * false, and while `forced` is still true (the change has not yet
 * succeeded) `open` stays true no matter what `manualOpen` is set to.
 */
export function PasswordDialog({
  forced,
  manualOpen,
  onManualOpenChange,
  onSuccess,
}: {
  forced: boolean
  manualOpen: boolean
  onManualOpenChange: (open: boolean) => void
  onSuccess: () => void | Promise<void>
}) {
  const open = forced || manualOpen

  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setCurrent("")
      setNext("")
      setConfirm("")
      setError(null)
    }
  }, [open])

  const mutation = useApiMutation<
    { current_password: string; new_password: string },
    { ok: boolean }
  >("/api/auth/change-password")

  const mismatch = confirm.length > 0 && next !== confirm
  const canSubmit =
    !mutation.isPending && current.length > 0 && next.length >= 8 && confirm === next && next !== current
  // Why the button is off, said under it, so nobody has to guess.
  const blocker = mutation.isPending
    ? null
    : !current
      ? "Enter your current password to continue."
      : next.length < 8
        ? `The new password needs ${8 - next.length} more character${8 - next.length === 1 ? "" : "s"}.`
        : next === current
          ? "The new password must differ from the current one."
          : confirm !== next
            ? "Type the new password again to confirm it."
            : null
  const strength = passwordStrength(next)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (next.length < 8) {
      setError("New password must be at least 8 characters")
      return
    }
    if (next !== confirm) {
      setError("The two new passwords do not match")
      return
    }
    try {
      await mutation.mutateAsync({ current_password: current, new_password: next })
      toast.ok("Password changed")
      onManualOpenChange(false)
      await onSuccess()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change the password")
    }
  }

  // While the account still demands a change, a close request (Escape, an
  // overlay click, the corner button) is refused outright rather than left
  // to no-op silently — `open` would stay true regardless, but this is what
  // stops Radix from starting a dismiss it cannot finish.
  function attemptClose(v: boolean) {
    if (!v && forced) return
    onManualOpenChange(v)
  }

  return (
    <Dialog open={open} onOpenChange={attemptClose}>
      <DialogContent
        size="sm"
        onEscapeKeyDown={(e) => forced && e.preventDefault()}
        onPointerDownOutside={(e) => forced && e.preventDefault()}
        onInteractOutside={(e) => forced && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{forced ? "Choose a new password" : "Change password"}</DialogTitle>
          <DialogDescription>
            {forced
              ? "This account was issued a temporary password. Choose one only you know before continuing."
              : "Confirm the current password, then choose a new one."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit}>
          <DialogBody className="space-y-3.5">
            <Field label="Current password">
              <PasswordInput
                size="lg"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>

            <Field label="New password">
              <PasswordInput
                size="lg"
                autoComplete="new-password"
                required
                minLength={8}
                aria-describedby="pw-rule"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <div id="pw-rule" className="-mt-1.5 space-y-1.5">
              <div className="grid grid-cols-4 gap-1" aria-hidden>
                {[1, 2, 3, 4].map((n) => (
                  <span
                    key={n}
                    className={
                      "h-1 rounded-full " +
                      (next && strength.score >= n ? strength.bar : "bg-sunken")
                    }
                  />
                ))}
              </div>
              <p className="text-xs text-fg-muted" aria-live="polite">
                <span className={next.length >= 8 ? "text-positive" : undefined}>
                  {next.length >= 8 ? "✓ " : ""}At least 8 characters ({next.length}/8)
                </span>
                {next && <> · Strength: <span className="font-medium text-fg">{strength.label}</span></>}
              </p>
            </div>

            <Field
              label="Confirm new password"
              error={mismatch ? "Does not match the new password yet." : undefined}
            >
              <PasswordInput
                size="lg"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>

            {error && (
              <p role="alert" className="rounded-md bg-critical-wash px-3 py-2 text-sm text-critical">
                {error}
              </p>
            )}
          </DialogBody>

          <DialogFooter className="flex-wrap">
            {blocker && (
              <p id="pw-blocker" className="mr-auto basis-full text-xs text-fg-muted sm:basis-auto">
                {blocker}
              </p>
            )}
            {!forced && (
              <Button kind="quiet" type="button" onClick={() => onManualOpenChange(false)}>
                Cancel
              </Button>
            )}
            <Button
              kind="primary"
              type="submit"
              disabled={!canSubmit}
              aria-describedby={blocker ? "pw-blocker" : undefined}
            >
              {mutation.isPending && <LoaderCircle className="animate-spin" />}
              {mutation.isPending ? "Changing…" : "Change password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
