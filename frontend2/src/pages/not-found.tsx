import { useState } from "react"
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { NAV, pagesFor } from "@/app/nav"
import { Illustration } from "@/ui/illustration"
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
  const navigate = useNavigate()
  const [query, setQuery] = useState("")

  const path = location.pathname
  // Matched against every declared destination, not just this role's — that
  // is the whole point: a hit here that is absent from `pagesFor(role)` means
  // the page exists and is somebody else's.
  const declared = NAV.find((item) => item.to === path)
  const mine = pagesFor(me?.role).some((item) => item.to === path)
  const forbidden = Boolean(declared) && !mine

  const home = me?.role === "FACULTY" ? "your papers" : "your home page"

  return (
    <div className="page py-16">
      <div className="mx-auto max-w-lg space-y-4 text-center">
        {/* Two different pictures for the two different sentences, and
            neither of them is a padlock apologising. A page that exists and
            belongs to somebody else gets the college's own portico with a
            bar across it; an address that is nothing at all gets a signpost
            with nothing written on it. */}
        <Illustration name={forbidden ? "error-access-denied" : "not-found-404"} width={240} className="mx-auto w-full max-w-[240px]" eager />

        <div>
          <PageTitle>{forbidden ? "Not open to this account" : "No page at this address"}</PageTitle>
          <Sub className="mt-1">
            {forbidden ? (
              <>
                {/* Naming the page tells a member of staff what they were sent to;
                    to a faculty member it would only be the name of somebody else's desk. */}
                {me?.role !== "FACULTY" && (
                  <>
                    <span className="font-medium text-fg">{declared?.label}</span> is a real page, but{" "}
                  </>
                )}
                {me?.role === "FACULTY" ? "That page is not one this account may open. " : "it is not one this account may open. "}
                Nothing is broken and nothing has been lost. Ask the research office if you think it
                should be yours.
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

        {me && (
          <form
            role="search"
            className="flex gap-2 pt-2"
            onSubmit={(e) => {
              e.preventDefault()
              const q = query.trim()
              navigate(q ? "/search?q=" + encodeURIComponent(q) : "/search")
            }}
          >
            <label htmlFor="nf-search" className="sr-only">
              Search papers, journals and people
            </label>
            <input
              id="nf-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search papers, journals, people"
              className="h-10 min-w-0 flex-1 rounded-lg bg-surface px-3 text-base ring-1 ring-inset ring-field outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <Button kind="default" type="submit" className="h-10">
              Search
            </Button>
          </form>
        )}

        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <Button kind="primary" asChild>
            <Link to="/">Go to {home}</Link>
          </Button>
          {/* A stale link is usually one click from where the reader was. */}
          {window.history.length > 1 && (
            <Button kind="default" onClick={() => navigate(-1)}>
              Go back
            </Button>
          )}
        </div>

        {me && <Meta className="block pt-2">Ctrl-K opens every page you can reach.</Meta>}
      </div>
    </div>
  )
}

/**
 * A faculty member who types (or is sent) the address of an office page is
 * shown the plain "not open to this account" screen, before the page loads.
 *
 * Without it the page opened, asked the server, was refused, and printed the
 * server's own sentence: "Only Finance can see or process payments". That
 * names a desk to somebody the college keeps the chain from, and it came with
 * a "Try again" button for a refusal no retry will change. Only faculty are
 * gated here, and only on a path the nav declares for other roles alone, so a
 * path the nav does not list is never blocked by a guess.
 */
export function RoleGate() {
  const { me } = useAuth()
  const { pathname } = useLocation()
  if (me?.role === "FACULTY") {
    const declared = NAV.find((item) => item.to === pathname)
    if (declared?.roles && !declared.roles.includes("FACULTY")) return <NotFound />
  }
  return <Outlet />
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
        <Sub>Not built yet, and not simply waiting its turn.</Sub>
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
