/**
 * A thin wrapper over `sonner`, so a toast in this app can only say three
 * things: something worked, something failed, or something to note in
 * passing. `<Toaster />` is already mounted once in `main.tsx`.
 *
 * `sonner` is fetched the first time it is needed rather than with the first
 * screen: nothing toasts before somebody has pressed something, and by then
 * the Toaster `main.tsx` mounts after the first paint has brought it in.
 *
 * A toast is the wrong place for anything the reader must act on — it reads
 * for a few seconds and is gone, so a rejection reason, a validation list or
 * anything someone needs to still see after they look away belongs in
 * `InlineError` or `Callout` (`src/ui/state.tsx`) instead.
 */
export const toast = {
  /**
   * Confirms a change, in words that say what changed. `toast.ok("Saved")`
   * tells nobody what was saved or where — a claimant who just cleared
   * twelve papers to the Principal needs `toast.ok("Cleared — 12 papers
   * sent to the Principal")`, because that sentence is the only receipt
   * they get.
   */
  ok(message: string) {
    void sonner().then((s) => s.toast.success(message))
  },

  /**
   * Reports a failure, in a sentence a reader did not write. Pass the
   * caught error as-is — this pulls a readable message out of it and never
   * falls back to `[object Object]`, which is what `String(err)` gives you
   * for the plain `{ error: "..." }` bodies this app's API returns on a
   * non-2xx response.
   */
  fail(error: unknown, fallback = "Something went wrong. Please try again.") {
    const message = readableMessage(error, fallback)
    void sonner().then((s) => s.toast.error(message))
  },

  /** A fact worth noting that is neither a success nor a failure — a
   *  background sync finished, a filter was cleared for you. */
  info(message: string) {
    void sonner().then((s) => s.toast(message))
  },
}

let loading: Promise<typeof import("sonner")> | null = null
function sonner() {
  return (loading ??= import("sonner"))
}

function readableMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error.trim()) return error
  if (isMessageBearing(error) && error.message.trim()) return error.message
  return fallback
}

function isMessageBearing(error: unknown): error is { message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  )
}
