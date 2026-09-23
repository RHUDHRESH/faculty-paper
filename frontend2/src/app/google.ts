/**
 * Google Identity Services, loaded once for whichever screen asks first.
 *
 * Two screens draw a Google button: the sign-in page, and "Link Google
 * account" on the profile. Each used to be able to append its own copy of
 * the script, and the sign-in page decided the script was ready the moment a
 * `<script>` tag with the right id existed rather than when it had finished
 * loading — so reaching it mid-download drew nothing and said nothing. One
 * promise, shared, resolves when `window.google` is actually there.
 *
 * Nothing is fetched until a screen asks, so a college that never turns
 * Google sign-in on never downloads Google's script at all.
 */

/** What `/api/auth/google/config` answers. */
export type GoogleConfig = {
  enabled: boolean
  client_id: string | null
  hosted_domain: string | null
}

/** The slice of Google Identity Services this app uses. */
export type GoogleIdentity = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string
        callback: (response: { credential: string }) => void
      }) => void
      renderButton: (
        parent: HTMLElement,
        options: { theme: string; size: string; width: number; text: string }
      ) => void
    }
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client"

let pending: Promise<GoogleIdentity> | null = null

function current(): GoogleIdentity | undefined {
  const google = (window as unknown as { google?: GoogleIdentity }).google
  return google?.accounts?.id ? google : undefined
}

export function loadGoogleIdentity(): Promise<GoogleIdentity> {
  const ready = current()
  if (ready) return Promise.resolve(ready)
  if (pending) return pending

  pending = new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = GSI_SRC
    script.async = true
    script.defer = true

    // A failed load forgets itself, so the next press tries again rather
    // than being handed the same rejection for the rest of the session.
    const fail = () => {
      pending = null
      script.remove()
      reject(new Error("Google's sign-in did not load."))
    }
    script.addEventListener("load", () => {
      const google = current()
      if (google) resolve(google)
      else fail()
    })
    script.addEventListener("error", fail)
    document.head.appendChild(script)
  })
  return pending
}
