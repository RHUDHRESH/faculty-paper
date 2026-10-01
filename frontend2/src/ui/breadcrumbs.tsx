import { Fragment } from "react"
import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/cn"

export type Crumb = {
  label: string
  /** Absent on the last crumb, which is the page you are on. */
  to?: string
}

/**
 * Where this page sits: "Admin / Imports / ERP workbook, 28 Sep".
 *
 * Without it a detail page is a room with no door back: a super admin who
 * opened one import from the Admin hub has only the browser's back button to
 * find out where they are, and after a reload not even that. Every crumb but
 * the last is a link; the last says where you are and is not one.
 *
 * The shell draws this from the route (`app/crumbs.ts`), so a page does not
 * need to. `PageHeader` accepts `breadcrumbs` for the rare page that lives
 * outside the router (a dialog page, a print view).
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  if (items.length === 0) return null
  return (
    // Not on paper: a printed page has no door to go back through, and the
    // letterhead already says what the page is.
    <nav aria-label="Breadcrumb" className={cn("print:hidden", className)}>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-fg-muted">
        {items.map((c, i) => {
          const last = i === items.length - 1
          return (
            <Fragment key={`${i}-${c.label}`}>
              <li className={cn("min-w-0", last && "truncate text-fg")}>
                {last || !c.to ? (
                  <span aria-current={last ? "page" : undefined} className="block truncate">
                    {c.label}
                  </span>
                ) : (
                  <Link
                    to={c.to}
                    className="inline-flex min-h-6 items-center rounded-control max-sm:min-h-10 hover:text-fg hover:underline hover:underline-offset-2"
                  >
                    {c.label}
                  </Link>
                )}
              </li>
              {!last && (
                <li aria-hidden className="text-fg-subtle">
                  <ChevronRight className="size-3.5" />
                </li>
              )}
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
