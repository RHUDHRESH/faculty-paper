import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"

import { cn } from "@/lib/cn"
import { Sheet, SheetContent } from "@/ui/sheet"

/**
 * Click anything, get the detail.
 *
 * A paper title, a journal name, a colleague or a number on a page used to be
 * plain text: the reader who wanted to know "which papers make up these 20
 * citations?" had to go and find them by hand. A `DetailLink` opens a panel
 * about the thing instead, and the page underneath stays exactly where it was.
 *
 * The panel lives in the URL (`?detail=paper:<id>`), so Back closes it, a
 * link to it can be shared, and a reload keeps it open. It is the kit's
 * `Sheet`: a right-hand panel on a desktop, a bottom sheet on a phone, with
 * the focus trap and Escape that Radix gives it.
 */

export type DetailSpec =
  | { kind: "paper"; id: string }
  | { kind: "journal"; name: string }
  | { kind: "person"; id: string }
  | { kind: "metric"; metric: string; value?: string | number | null }

export const DETAIL_PARAM = "detail"

export function encodeDetail(spec: DetailSpec): string {
  switch (spec.kind) {
    case "paper":
    case "person":
      return `${spec.kind}:${spec.id}`
    case "journal":
      return `journal:${spec.name}`
    case "metric":
      return spec.value == null || spec.value === "" ? `metric:${spec.metric}` : `metric:${spec.metric}:${spec.value}`
  }
}

export function decodeDetail(raw: string | null): DetailSpec | null {
  if (!raw) return null
  const at = raw.indexOf(":")
  if (at < 1) return null
  const kind = raw.slice(0, at)
  const rest = raw.slice(at + 1)
  if (!rest) return null
  if (kind === "paper" || kind === "person") return { kind, id: rest }
  if (kind === "journal") return { kind, name: rest }
  if (kind === "metric") {
    const k = rest.indexOf(":")
    return k < 0 ? { kind, metric: rest } : { kind, metric: rest.slice(0, k), value: rest.slice(k + 1) }
  }
  return null
}

/** A relative link that opens a panel, for components that only take a `to`
 *  (chart bars). It keeps the page and replaces the query string. */
export function detailHref(spec: DetailSpec): string {
  return `?${new URLSearchParams({ [DETAIL_PARAM]: encodeDetail(spec) })}`
}

type DetailState ={ detailDepth?: number } | null

/** Open and close the panel. Opening pushes a history entry, so Back closes it. */
export function useDetail() {
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const current = decodeDetail(params.get(DETAIL_PARAM))
  const depth = (location.state as DetailState)?.detailDepth ?? 0

  const open = useCallback(
    (spec: DetailSpec) => {
      const next = new URLSearchParams(location.search)
      next.set(DETAIL_PARAM, encodeDetail(spec))
      navigate(
        { pathname: location.pathname, search: `?${next}`, hash: location.hash },
        { state: { ...((location.state as object) ?? {}), detailDepth: depth + 1 } }
      )
    },
    [location, navigate, depth]
  )

  const close = useCallback(() => {
    if (depth > 0) {
      navigate(-depth)
      return
    }
    // Arrived on a shared link: there is no entry of ours to go back to.
    const next = new URLSearchParams(location.search)
    next.delete(DETAIL_PARAM)
    const search = next.toString()
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash }, { replace: true })
  }, [depth, location, navigate])

  return { current, open, close }
}

type LinkProps = {
  children?: React.ReactNode
  className?: string
  /** A number: drawn with a dotted underline so people learn it opens. */
  number?: boolean
  /** Read by a screen reader in place of the visible text. */
  label?: string
} & (
  | { kind: "paper"; id: string | null | undefined }
  | { kind: "journal"; name: string | null | undefined }
  | { kind: "person"; id: string | null | undefined }
  | { kind: "metric"; metric: string; params?: { value?: string | number | null } }
)

function specOf(p: LinkProps): DetailSpec | null {
  if (p.kind === "paper") return p.id && !p.id.startsWith("claim-") ? { kind: "paper", id: p.id } : null
  if (p.kind === "person") return p.id ? { kind: "person", id: p.id } : null
  if (p.kind === "journal") return p.name && p.name.trim() ? { kind: "journal", name: p.name.trim() } : null
  return { kind: "metric", metric: p.metric, value: p.params?.value ?? null }
}

/**
 * Text that opens the detail panel about what it names.
 *
 * A real `<button>`, so it is in the tab order and answers Enter and Space.
 * Quiet at rest (it reads as the text it is), underlined under the pointer,
 * with the global focus ring. A number gets a faint dotted underline at rest:
 * without it nobody guesses a figure can be clicked. A paper known only from a
 * claim (no record to open) or a nameless journal stays plain text.
 */
export function DetailLink(props: LinkProps) {
  const { open } = useDetail()
  const spec = specOf(props)
  const text = props.children ?? (props.kind === "journal" ? props.name : null)
  if (!spec) return <span className={props.className}>{text}</span>
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        open(spec)
      }}
      className={cn(
        "cursor-pointer rounded-sm text-left [font:inherit] [color:inherit] underline-offset-4 hover:underline hover:decoration-1",
        props.number && "underline decoration-dotted decoration-fg-subtle/70 hover:decoration-solid",
        props.className
      )}
    >
      {text}
    </button>
  )
}

const Panels = lazy(() => import("@/ui/detail-panels"))

function useWide() {
  const query = "(min-width: 40rem)"
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function" ? true : window.matchMedia(query).matches
  )
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const m = window.matchMedia(query)
    const on = () => setWide(m.matches)
    m.addEventListener?.("change", on)
    return () => m.removeEventListener?.("change", on)
  }, [])
  return wide
}

/**
 * The one panel, mounted once by the shell. Reads `?detail=` and shows what
 * it names; closing it (Escape, the cross, the scrim, Back) takes the
 * parameter off again.
 */
export function DetailHost() {
  const { current, close } = useDetail()
  const wide = useWide()
  return (
    <Sheet open={!!current} onOpenChange={(v) => !v && close()}>
      <SheetContent
        side={wide ? "right" : "bottom"}
        aria-describedby={undefined}
        className={cn(wide ? "sm:w-[30rem]" : "h-[85vh]")}
      >
        {current && (
          <Suspense fallback={<div className="p-5 text-sm text-fg-muted">Opening…</div>}>
            <Panels spec={current} />
          </Suspense>
        )}
      </SheetContent>
    </Sheet>
  )
}
