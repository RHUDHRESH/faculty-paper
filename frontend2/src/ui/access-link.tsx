import { Link, type LinkProps } from "react-router-dom"

import { can, useAuth } from "@/app/auth"

/**
 * A link that exists only where it leads somewhere the reader may go.
 *
 * Where the reader's role cannot open `to` (`app/access.ts`), the children are
 * drawn as plain text in a span, so a name or a number stays on the page and
 * stops promising a page that would only say "Not visible to this account".
 * Give `plain` to style that text (the link's own styling does not apply to it).
 */
export function AccessLink({
  to,
  plain,
  children,
  ...rest
}: Omit<LinkProps, "to"> & {
  to: string
  /** The class for the plain-text fallback. */
  plain?: string
}) {
  const { me } = useAuth()
  if (!can(me?.role).open(to, me?.id)) {
    return <span className={plain}>{children}</span>
  }
  return (
    <Link to={to} {...rest}>
      {children}
    </Link>
  )
}
