import { Component, type ErrorInfo, type ReactNode } from "react"
import { useLocation } from "react-router-dom"

/**
 * The screen for a page that broke while drawing.
 *
 * Without it React unmounts the whole tree on an uncaught render error and the
 * person is left with a blank white page: no message, no sidebar, no way out
 * but the address bar. The commonest cause is not a bug at all: a new version
 * went live while a tab was open, and the next page's script no longer exists
 * under its old name. That case gets its own sentence, because "reload" is the
 * whole fix and saying so saves a call to somebody.
 *
 * Plain elements only (no router links, no query hooks, no kit components):
 * whatever broke may be in one of those, and an error screen that throws is
 * the one failure with nowhere left to fall to.
 */

const STALE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i

type Props = { children: ReactNode; resetKey: string }
type State = { error: Error | null }

class Boundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    // Following any link out of the broken page gives the next one a clean start.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("A page failed to draw", error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const stale = STALE.test(error.message)
    return (
      <main role="alert" className="mx-auto grid min-h-svh max-w-md content-center gap-4 px-6 py-16 text-center">
        <h1 className="display text-[1.75rem] leading-9">{stale ? "This page has been updated" : "This page could not be drawn"}</h1>
        <p className="text-base text-fg-muted">
          {stale
            ? "A newer version went live while this tab was open. Reload to pick it up."
            : "Something on this page failed. Reload, or go to the home page."}
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex h-10 items-center rounded-control bg-action px-4 text-sm font-medium text-action-fg shadow-action hover:bg-action-hover hover:shadow-action-hover active:shadow-press"
          >
            Reload the page
          </button>
          <a
            href="/"
            className="inline-flex h-10 items-center rounded-control bg-surface px-4 text-sm font-medium text-fg shadow-raise ring-1 ring-inset ring-control-edge hover:bg-hover hover:ring-field active:bg-active active:shadow-press"
          >
            Go to the home page
          </a>
        </div>
        {!stale && <p className="break-words text-xs text-fg-subtle">{error.message.slice(0, 200)}</p>}
      </main>
    )
  }
}

/** Wrap the app once, inside the router, so a link followed from the error screen clears it. */
export function CrashGuard({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return <Boundary resetKey={pathname}>{children}</Boundary>
}
