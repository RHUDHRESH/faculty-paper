import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import { MessageCircle, Minus, Plus, RotateCcw, UserRound, Waypoints } from "lucide-react"
import { Avatar, initialsOf } from "@/ui/person"
import { cn } from "@/lib/cn"

/**
 * "Your circle": you in the middle with your face, the people you have
 * written with on a ring around you (closer and bigger the more papers you
 * share), the people two steps away faint on an outer ring. Hand-drawn SVG,
 * laid out deterministically with collision so no two faces overlap.
 */

export type CirclePerson = {
  key: string
  user_id: string | null
  name: string
  department: string | null
  institution: string | null
  is_college_member: boolean
  hop: 0 | 1 | 2
  papers: number
  together: number
  photo_url?: string | null
  initials?: string
}
export type CircleLink = { source: string; target: string; papers: number }

export type Placed = CirclePerson & { x: number; y: number; r: number; angle: number }

const TITLES = /^(dr|mr|mrs|ms|prof|er)\.?\s*/i
/** "Dr.G.Venkatesan" -> "G. Venkatesan"; titles off, dots spaced. */
export function shortName(name: string, max = 20): string {
  let s = name.trim()
  while (TITLES.test(s)) s = s.replace(TITLES, "")
  s = s.replace(/\.(?=\S)/g, ". ").replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/** A calm hue per institution, the same every time. */
export function tint(institution: string | null): number {
  const s = (institution || "?").toLowerCase()
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

/**
 * Deterministic radial layout in pixel space: me at the centre, direct
 * co-authors on an (elliptical, when the box is wide) inner ring with the
 * strongest ties nearest, two-steps-away people on the outer ring near the
 * co-authors who link them. A few relaxation passes push apart anything that
 * still touches.
 */
export function circleLayout(
  people: CirclePerson[],
  links: CircleLink[],
  w: number,
  h: number,
  opts: { compact?: boolean } = {}
): Placed[] {
  const scale = opts.compact ? 0.82 : 1
  const cx = w / 2
  const cy = h / 2
  const ry = Math.max(60, h / 2 - (opts.compact ? 26 : 40))
  const rx = Math.max(60, Math.min(w / 2 - (opts.compact || w < 700 ? 26 : 110), ry * 1.9))
  const maxT = Math.max(1, ...people.map((p) => p.together))
  const radius = (p: CirclePerson) =>
    scale *
    (p.hop === 0
      ? 30
      : p.hop === 2
        ? 7
        : Math.min(p.is_college_member ? 22 : 16, (p.is_college_member ? 11 : 9) + 3 * Math.sqrt(p.together)))

  const out: Placed[] = []
  const me = people.find((p) => p.hop === 0)
  if (me) out.push({ ...me, x: cx, y: cy, r: radius(me), angle: 0 })

  const ring = people
    .filter((p) => p.hop === 1)
    .sort(
      (a, b) =>
        Number(b.is_college_member) - Number(a.is_college_member) ||
        (a.institution || "~").localeCompare(b.institution || "~") ||
        b.together - a.together ||
        a.key.localeCompare(b.key)
    )
  const hasOuter = people.some((p) => p.hop === 2)
  const inner = hasOuter ? 0.86 : 0.98
  ring.forEach((p, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, ring.length)) * Math.PI * 2
    // strongest ties sit nearest; alternate a little in and out so a crowded ring breathes
    const pull = 1 - (p.together - 1) / Math.max(1, maxT - 1)
    const f = inner * (0.5 + 0.42 * pull) + (ring.length > 24 ? (i % 2 ? 0.05 : -0.03) : 0)
    out.push({ ...p, x: cx + Math.cos(angle) * rx * f, y: cy + Math.sin(angle) * ry * f, r: radius(p), angle })
  })

  const angleOf = new Map(out.map((p) => [p.key, p.angle]))
  const outer = people.filter((p) => p.hop === 2).sort((a, b) => a.key.localeCompare(b.key))
  outer.forEach((p, i) => {
    let sx = 0
    let sy = 0
    for (const l of links) {
      const other = l.source === p.key ? l.target : l.target === p.key ? l.source : null
      const a = other != null ? angleOf.get(other) : undefined
      if (a != null && other !== me?.key) {
        sx += Math.cos(a)
        sy += Math.sin(a)
      }
    }
    const angle = sx || sy ? Math.atan2(sy, sx) : (i / Math.max(1, outer.length)) * Math.PI * 2
    out.push({ ...p, x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, r: radius(p), angle })
  })

  // relax: push touching pairs apart, never move me, stay inside the box
  const gap = opts.compact ? 3 : 5
  for (let it = 0; it < 80; it++) {
    let moved = false
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]
        const b = out[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d = Math.hypot(dx, dy)
        const need = a.r + b.r + gap
        if (d >= need) continue
        if (d < 0.01) {
          dx = Math.cos(i + j)
          dy = Math.sin(i + j)
          d = 1
        }
        const push = (need - d) / 2
        const ux = dx / d
        const uy = dy / d
        if (a.hop === 0) {
          b.x += ux * push * 2
          b.y += uy * push * 2
        } else if (b.hop === 0) {
          a.x -= ux * push * 2
          a.y -= uy * push * 2
        } else {
          a.x -= ux * push
          a.y -= uy * push
          b.x += ux * push
          b.y += uy * push
        }
        moved = true
      }
    }
    for (const p of out) {
      p.x = Math.min(w - p.r - 2, Math.max(p.r + 2, p.x))
      p.y = Math.min(h - p.r - 2, Math.max(p.r + 2, p.y))
    }
    if (!moved) break
  }
  for (const p of out) if (p.hop !== 0) p.angle = Math.atan2(p.y - cy, p.x - cx)
  return out
}

type Filter = { inside: boolean; outside: boolean; two: boolean }

export function YourCircle({
  people,
  links,
  height,
  compact,
  onConnect,
  footnote,
}: {
  people: CirclePerson[]
  links: CircleLink[]
  height: number
  compact?: boolean
  /** "How you're connected", for people without a profile here. */
  onConnect: (id: string) => void
  footnote?: ReactNode
}) {
  const navigate = useNavigate()
  const clip = useId().replace(/:/g, "")
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [filter, setFilter] = useState<Filter>({ inside: true, outside: true, two: !compact })
  const [focus, setFocus] = useState<string | null>(null)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const close = useRef<number | undefined>(undefined)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const cap = compact ? 18 : 60
  const { shown, hiddenCount } = useMemo(() => {
    const keep = people.filter(
      (p) =>
        p.hop === 0 ||
        (p.hop === 2 ? filter.two : p.is_college_member ? filter.inside : filter.outside)
    )
    const hop1 = keep.filter((p) => p.hop === 1).sort((a, b) => b.together - a.together || a.key.localeCompare(b.key))
    const allowed = new Set(hop1.slice(0, cap).map((p) => p.key))
    const shown = keep.filter((p) => p.hop !== 1 || allowed.has(p.key))
    return { shown, hiddenCount: Math.max(0, hop1.length - cap) }
  }, [people, filter, cap])

  const placed = useMemo(() => (w ? circleLayout(shown, links, w, height, { compact }) : []), [shown, links, w, height, compact])
  const at = useMemo(() => new Map(placed.map((p) => [p.key, p])), [placed])
  const drawn = useMemo(() => links.filter((l) => at.has(l.source) && at.has(l.target)), [links, at])
  const near = useMemo(() => {
    if (!focus) return null
    const s = new Set([focus])
    for (const l of drawn) {
      if (l.source === focus) s.add(l.target)
      if (l.target === focus) s.add(l.source)
    }
    return s
  }, [focus, drawn])

  // labels: the strongest ties (and the focused person), skipping any that would collide
  const labels = useMemo(() => {
    const top = placed
      .filter((p) => p.hop === 1)
      .sort((a, b) => b.together - a.together || a.key.localeCompare(b.key))
      .slice(0, compact ? 5 : 10)
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = []
    const out: { p: Placed; x: number; y: number; anchor: "start" | "end" | "middle"; text: string }[] = []
    for (const p of top) {
      const text = shortName(p.name, compact ? 14 : 20)
      const c = Math.cos(p.angle)
      const s = Math.sin(p.angle)
      const radial = c > 0.35 ? "start" : c < -0.35 ? "end" : "middle"
      const tw = text.length * 6.4
      // try outward first, then under, then over the face
      const tries: { x: number; y: number; anchor: "start" | "end" | "middle" }[] = [
        { x: p.x + c * (p.r + 5), y: p.y + s * (p.r + 5) + (radial === "middle" ? (s > 0 ? 9 : -3) : 4), anchor: radial },
        { x: p.x, y: p.y + p.r + 13, anchor: "middle" },
        { x: p.x, y: p.y - p.r - 5, anchor: "middle" },
      ]
      for (const t of tries) {
        const x0 = t.anchor === "start" ? t.x : t.anchor === "end" ? t.x - tw : t.x - tw / 2
        const b = { x0, x1: x0 + tw, y0: t.y - 11, y1: t.y + 3 }
        const hits = placed.some(
          (o) => o !== p && o.hop !== 2 && b.x1 > o.x - o.r && b.x0 < o.x + o.r && b.y1 > o.y - o.r && b.y0 < o.y + o.r
        )
        if (hits || b.x0 < 0 || b.x1 > w || boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue
        boxes.push(b)
        out.push({ p, ...t, text })
        break
      }
    }
    return out
  }, [placed, compact, w])

  const focused = focus ? at.get(focus) : undefined
  const idOf = (p: CirclePerson) => p.user_id ?? p.key
  const openPerson = (p: CirclePerson) => {
    if (p.hop === 0) return
    if (p.user_id) navigate(`/u/${p.user_id}`)
    else onConnect(idOf(p))
  }
  const hold = () => window.clearTimeout(close.current)
  const letGo = () => {
    hold()
    close.current = window.setTimeout(() => setFocus(null), 160)
  }
  const zoom = (f: number) =>
    setView((v) => {
      const k = Math.min(3, Math.max(0.6, v.k * f))
      const cx = w / 2
      const cy = height / 2
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }
    })

  const chips: { id: keyof Filter; label: string; n: number }[] = [
    { id: "inside", label: "Saveetha", n: people.filter((p) => p.hop === 1 && p.is_college_member).length },
    { id: "outside", label: "Outside", n: people.filter((p) => p.hop === 1 && !p.is_college_member).length },
    { id: "two", label: "Two steps", n: people.filter((p) => p.hop === 2).length },
  ]

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show in the drawing">
        {chips
          .filter((c) => c.n > 0)
          .map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={filter[c.id]}
              onClick={() => setFilter((f) => ({ ...f, [c.id]: !f[c.id] }))}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                filter[c.id] ? "border-(--area-line) bg-(--area-wash) text-fg" : "border-line text-fg-subtle hover:text-fg"
              )}
            >
              {c.label}
              <span className="tabular text-fg-subtle">{c.n}</span>
            </button>
          ))}
      </div>

      <div
        ref={box}
        className="relative overflow-hidden rounded-xl border border-line bg-surface"
        style={{ height }}
        onMouseLeave={letGo}
      >
        {w > 0 && (
          <svg
            width={w}
            height={height}
            role="group"
            aria-label={`Your circle: ${placed.length} people. Tab through to meet each one; Enter opens them.`}
            className={cn("block touch-none select-none", drag.current ? "cursor-grabbing" : "cursor-grab")}
            onPointerDown={(e) => {
              if ((e.target as Element).closest("[data-person]")) return
              drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
              ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
            }}
            onPointerUp={() => (drag.current = null)}
            onWheel={(e) => {
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault()
                zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
              }
            }}
          >
            <defs>
              <clipPath id={clip} clipPathUnits="objectBoundingBox">
                <circle cx="0.5" cy="0.5" r="0.5" />
              </clipPath>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <g fill="none" strokeLinecap="round">
                {drawn.map((l) => {
                  const a = at.get(l.source)!
                  const b = at.get(l.target)!
                  const lit = focus != null && (l.source === focus || l.target === focus)
                  const spoke = a.hop === 0 || b.hop === 0
                  // co-author to co-author lines only when asked for, or the middle becomes a hairball
                  if (!lit && !spoke && a.hop !== 2 && b.hop !== 2) return null
                  return (
                    <line
                      key={`${l.source}|${l.target}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={lit ? "var(--area)" : "var(--color-fg-subtle)"}
                      strokeWidth={Math.min(5, 0.8 + l.papers * 0.7) / (compact ? 1.2 : 1)}
                      strokeOpacity={lit ? 0.85 : focus ? 0.05 : spoke ? 0.2 : 0.12}
                      className="motion-safe:transition-[stroke-opacity] motion-safe:duration-150"
                    />
                  )
                })}
              </g>
              {placed.map((p) => {
                const dim = near != null && !near.has(p.key)
                const hue = tint(p.institution)
                const face = p.hop === 0 || p.is_college_member
                const initials = p.initials || initialsOf(p.name)
                return (
                  <g
                    key={p.key}
                    data-person
                    tabIndex={0}
                    role="button"
                    aria-label={
                      p.hop === 0
                        ? "You"
                        : `${p.name}, ${(p.is_college_member ? p.department : p.institution) || "outside"}${
                            p.hop === 1 ? `, ${p.together} papers together` : ", two steps away"
                          }`
                    }
                    className="cursor-pointer outline-none motion-safe:transition-opacity motion-safe:duration-150 [&:focus-visible>.ring]:stroke-(--area)"
                    opacity={dim ? 0.2 : p.hop === 2 && focus !== p.key ? 0.55 : 1}
                    onMouseEnter={() => {
                      hold()
                      setFocus(p.key)
                    }}
                    onFocus={() => {
                      hold()
                      setFocus(p.key)
                    }}
                    onBlur={letGo}
                    onClick={() => openPerson(p)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        openPerson(p)
                      } else if (e.key === "Escape") setFocus(null)
                    }}
                  >
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={p.r + (p.hop === 0 ? 4 : 2)}
                      className="ring"
                      fill="var(--color-surface)"
                      stroke={focus === p.key ? "var(--area)" : p.hop === 0 ? "var(--area-line)" : "transparent"}
                      strokeWidth={2}
                    />
                    {face && p.photo_url ? (
                      <image
                        href={p.photo_url}
                        x={p.x - p.r}
                        y={p.y - p.r}
                        width={p.r * 2}
                        height={p.r * 2}
                        preserveAspectRatio="xMidYMid slice"
                        clipPath={`url(#${clip})`}
                      />
                    ) : (
                      <>
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={p.r}
                          fill={face ? "var(--color-accent-wash)" : `hsl(${hue} 32% 90%)`}
                          stroke={face ? "var(--color-accent-line)" : `hsl(${hue} 25% 78%)`}
                        />
                        {p.r >= 8 && (
                          <text
                            x={p.x}
                            y={p.y}
                            dy="0.35em"
                            textAnchor="middle"
                            fontSize={Math.max(8, p.r * 0.72)}
                            fontWeight={600}
                            fill={face ? "var(--color-accent)" : `hsl(${hue} 30% 34%)`}
                          >
                            {initials.slice(0, 2)}
                          </text>
                        )}
                      </>
                    )}
                  </g>
                )
              })}
              <g pointerEvents="none" fontSize={compact ? 11 : 12}>
                {labels.map((l) => (
                  <text
                    key={l.p.key}
                    x={l.x}
                    y={l.y}
                    textAnchor={l.anchor}
                    fill="var(--color-fg-muted)"
                    stroke="var(--color-surface)"
                    strokeWidth={3}
                    paintOrder="stroke"
                    opacity={near && !near.has(l.p.key) ? 0.15 : 1}
                  >
                    {l.text}
                  </text>
                ))}
              </g>
            </g>
          </svg>
        )}

        {focused && (
          <PersonCard
            p={focused}
            x={view.x + focused.x * view.k}
            y={view.y + focused.y * view.k}
            r={focused.r * view.k}
            w={w}
            h={height}
            compact={compact}
            onEnter={hold}
            onLeave={letGo}
            onConnect={() => onConnect(idOf(focused))}
          />
        )}

        <div className="absolute bottom-2 right-2 flex items-center rounded-md border border-line bg-surface/90 text-fg-muted shadow-(--shadow-under)">
          {[
            { label: "Zoom in", icon: Plus, run: () => zoom(1.25) },
            { label: "Zoom out", icon: Minus, run: () => zoom(0.8) },
            { label: "Back to the whole circle", icon: RotateCcw, run: () => setView({ k: 1, x: 0, y: 0 }) },
          ].map((b) => (
            <button
              key={b.label}
              type="button"
              aria-label={b.label}
              title={b.label}
              onClick={b.run}
              className="grid size-7 place-items-center hover:bg-hover hover:text-fg"
            >
              <b.icon aria-hidden className="size-3.5" strokeWidth={1.75} />
            </button>
          ))}
        </div>
      </div>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full border border-accent-line bg-accent-wash" /> Saveetha faces
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full" style={{ background: "hsl(200 32% 86%)" }} /> Outside, tinted by
          institution
        </span>
        <span>Bigger and nearer: more papers together{filter.two ? "; faint: two steps away" : ""}.</span>
        {hiddenCount > 0 && <span>{hiddenCount} more on the Map tab.</span>}
        {footnote}
      </p>
    </div>
  )
}


function PersonCard({
  p,
  x,
  y,
  r,
  w,
  h,
  compact,
  onEnter,
  onLeave,
  onConnect,
}: {
  p: Placed
  x: number
  y: number
  r: number
  w: number
  h: number
  compact?: boolean
  onEnter: () => void
  onLeave: () => void
  onConnect: () => void
}) {
  const cw = compact ? 220 : 248
  // beside the person, on the side away from the middle; above or below when the box is too narrow
  const rightSide = x + r + 12 + cw <= w - 8
  const leftSide = x - r - 12 - cw >= 8
  const side = x >= w / 2 ? (rightSide ? "r" : leftSide ? "l" : null) : leftSide ? "l" : rightSide ? "r" : null
  const pos: CSSProperties = side
    ? { left: side === "r" ? x + r + 12 : x - r - 12 - cw, top: Math.min(h - 136, Math.max(8, y - 48)) }
    : y < h / 2
      ? { left: 8, right: 8, bottom: 8, width: "auto" }
      : { left: 8, right: 8, top: 8, width: "auto" }
  const where = p.is_college_member ? p.department && `${p.department}, Saveetha` : p.institution
  const detail =
    p.hop === 0
      ? `${p.papers} papers`
      : p.hop === 1
        ? `${p.together} ${p.together === 1 ? "paper" : "papers"} together`
        : "Two steps away: a co-author's co-author"
  return (
    <div
      role="dialog"
      aria-label={p.name}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="absolute z-10 rounded-lg border border-line bg-surface p-3 shadow-(--shadow-pop)"
      style={{ width: cw, ...pos }}
    >
      <div className="flex items-center gap-2.5">
        <Avatar person={{ name: p.name, initials: p.initials || initialsOf(p.name), photo_url: p.photo_url ?? null }} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{p.hop === 0 ? "You" : p.name}</p>
          <p className="truncate text-xs text-fg-muted">{where || (p.is_college_member ? "Saveetha" : "Outside the college")}</p>
        </div>
      </div>
      <p className="mt-2 text-xs text-fg-muted">{detail}</p>
      {p.hop !== 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {p.user_id ? (
            <>
              <Link
                to={`/messages?to=${p.user_id}`}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-xs text-fg hover:bg-hover"
              >
                <MessageCircle aria-hidden className="size-3.5" strokeWidth={1.75} /> Message
              </Link>
              <Link
                to={`/u/${p.user_id}`}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-(--area) hover:bg-(--area-wash)"
              >
                <UserRound aria-hidden className="size-3.5" strokeWidth={1.75} /> Open profile
              </Link>
            </>
          ) : (
            <button
              type="button"
              onClick={onConnect}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-(--area) hover:bg-(--area-wash)"
            >
              <Waypoints aria-hidden className="size-3.5" strokeWidth={1.75} /> How you're connected
            </button>
          )}
        </div>
      )}
    </div>
  )
}
