import { Link, useLocation } from "react-router-dom"
import { Compass, Lock } from "lucide-react"

import { useAuth } from "@/app/auth"
import { NAV, navFor } from "@/app/nav"
import { Button } from "@/ui/button"
import { Meta, PageTitle, Sub } from "@/ui/text"

/**
 * The catch-all, which used to be `<Navigate to="/" replace />`.
 *
 * Silently bouncing somebody home is the worst of the three things this could
 * do, because it answers a question they did not ask and hides the one they
 * did. A reader who follows a stale link, mistypes a path, or is sent a URL
 * by a colleague on a different role arrives at their own home page with no
 * indication that anything went wrong — and concludes the link was fine and
 * the app is broken. That is exactly the failure `audit/routes.mjs` exists to
 * catch for sidebar items; this is the same failure for every other way into
 * a URL.
 *
 * So it says which of the two things happened. **A path that is a real page
 * this account may not open is a different sentence from a path that is not a
 * page at all** — the first is answered by asking somebody for access, the
 * second by going back. Telling them apart is possible here because `nav.ts`
 * already declares every destination and who it is for, so the page can check
 * the requested path against the full list rather than only against the
 * filtered one the sidebar drew.
 */
export function NotFound() {
  const { me } = useAuth()
  const location = useLocation()

  const path = location.pathname
  // Matched against every declared destination, not just this role's — that
  // is the whole point: a hit here that is absent from `navFor(role)` means
  // the page exists and is somebody else's.
  const declared = NAV.find((item) => item.to === path)
  const mine = navFor(me?.role).some((item) => item.to === path)
  const forbidden = Boolean(declared) && !mine

  const home = me?.role === "FACULTY" ? "your papers" : "your home page"

  return (
    <div className="page py-16">
      <div className="mx-auto max-w-lg space-y-4 text-center">
        {forbidden ? (
          <Lock className="mx-auto size-8 text-fg-subtle" aria-hidden />
        ) : (
          <Compass className="mx-auto size-8 text-fg-subtle" aria-hidden />
        )}

        <div>
          <PageTitle>{forbidden ? "Not open to this account" : "No page at this address"}</PageTitle>
          <Sub className="mt-1">
            {forbidden ? (
              <>
                <span className="font-medium text-fg">{declared?.label}</span> is a real page, but
                it is not one this account may open. Nothing is broken and nothing has been
                lost — ask the research cell if you think it should be yours.
              </>
            ) : (
              <>
                Nothing in this app answers to that address. It may have been a link from an
                older version, or a typo.
              </>
            )}
          </Sub>
        </div>

        {/* The address itself, because the reader is usually about to send it
            to somebody and ask what happened. */}
        <Meta className="block break-all rounded-md bg-sunken px-3 py-1.5 font-mono">{path}</Meta>

        <div className="flex justify-center gap-2 pt-2">
          <Button kind="primary" asChild>
            <Link to="/">Go to {home}</Link>
          </Button>
        </div>

        <Meta className="block pt-2">Ctrl-K searches every page you can open.</Meta>
      </div>
    </div>
  )
}

/**
 * A page the rebuild has not reached, said honestly.
 *
 * The generic "Not built yet. This page is next in the rebuild." was on seven
 * routes at once, which made it false on six of them, and it told a reader
 * nothing about whether to wait a week or go and do the job by hand. This
 * takes what the screen is actually blocked on and says it, so somebody who
 * lands here knows whether it is coming and what to use in the meantime.
 */
export function NotBuilt({
  name,
  needs,
  meanwhile,
}: {
  name: string
  /** What has to exist before this screen can be built at all. */
  needs: string
  /** What answers the same question today, if anything does. */
  meanwhile?: React.ReactNode
}) {
  return (
    <div className="page py-16">
      <div className="mx-auto max-w-lg space-y-4 text-center">
        <PageTitle>{name}</PageTitle>
        <Sub>Not built yet — and not simply waiting its turn.</Sub>
        <p className="text-base text-fg-muted">{needs}</p>
        {meanwhile && <p className="text-base">{meanwhile}</p>}
        <div className="flex justify-center gap-2 pt-2">
          <Button kind="default" asChild>
            <Link to="/">Back</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
