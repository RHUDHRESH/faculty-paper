import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Minus, Plus, RotateCcw } from "lucide-react"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Meta } from "@/ui/text"

/**
 * A network of colleagues, drawn by hand in SVG — no graph library.
 *
 * Laid out once with a small Fruchterman–Reingold simulation from positions
 * seeded by each person's id, so the same data always draws the same picture
 * (a layout that wanders on every visit makes "is X still connected to Y"
 * unanswerable). Pan by dragging, zoom with the wheel or the buttons; point
 * at or tab to a person to light up who they are connected to, and open them
 * with a click or Enter.
 *
 * Two kinds of line, and the legend says which is which: a solid line is a
 * paper written together (worked out from claims for the same paper), a
 * dashed accent line is a collaboration both people agreed to.
 */

export type GraphNode = {
  id: string
  name: string
  department?: string | null
  degree: number
  papers?: number
  center?: boolean
}

export type GraphLink = {
  source: string
  target: string
  papers: number
  kind: "coauthor" | "collab"
  topic?: string
}

type Point = { x: number; y: number }

/** The layout's own coordinate space; the SVG's viewBox scales it to the screen. */
const W = 1000
const H = 700

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

/** Deterministic force layout. O(n²) per step, capped so a few hundred people stay well under a frame budget. */
export function layout(nodes: GraphNode[], links: GraphLink[], centerId?: string): Map<string, Point> {
  const n = nodes.length
  const pos = new Map<string, Point>()
  if (n === 0) return pos
  nodes.forEach((node) => {
    const a = hash(node.id) * Math.PI * 2
    const r = 80 + hash(`${node.id}r`) * 260
    pos.set(node.id, node.id === centerId ? { x: W / 2, y: H / 2 } : { x: W / 2 + r * Math.cos(a), y: H / 2 + r * Math.sin(a) })
  })
  if (n === 1) return pos

  const k = 0.85 * Math.sqrt((W * H) / n)
  const steps = n <= 60 ? 300 : n <= 200 ? 160 : 90
  let t = W / 8
  const cool = t / (steps + 1)
  const ids = nodes.map((node) => node.id)
  const edges = links.filter((l) => pos.has(l.source) && pos.has(l.target))

  for (let s = 0; s < steps; s++) {
    const disp = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]))
    for (let i = 0; i < n; i++) {
      const a = pos.get(ids[i])!
      const da = disp.get(ids[i])!
      for (let j = i + 1; j < n; j++) {
        const b = pos.get(ids[j])!
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d = Math.hypot(dx, dy)
        if (d < 0.01) {
          dx = 0.01
          dy = 0
          d = 0.01
        }
        const f = (k * k) / d
        const db = disp.get(ids[j])!
        da.x += (dx / d) * f
        da.y += (dy / d) * f
        db.x -= (dx / d) * f
        db.y -= (dy / d) * f
      }
    }
    for (const e of edges) {
      const a = pos.get(e.source)!
      const b = pos.get(e.target)!
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d = Math.max(0.01, Math.hypot(dx, dy))
      const f = (d * d) / k
      const da = disp.get(e.source)!
      const db = disp.get(e.target)!
      da.x -= (dx / d) * f
      da.y -= (dy / d) * f
      db.x += (dx / d) * f
      db.y += (dy / d) * f
    }
    for (const id of ids) {
      if (id === centerId) continue
      const p = pos.get(id)!
      const dp = disp.get(id)!
      // A little gravity, so people with no connection in view do not drift off the page.
      dp.x += (W / 2 - p.x) * 0.02 * k
      dp.y += (H / 2 - p.y) * 0.02 * k
      const d = Math.max(0.01, Math.hypot(dp.x, dp.y))
      p.x = Math.min(W - 20, Math.max(20, p.x + (dp.x / d) * Math.min(d, t)))
      p.y = Math.min(H - 20, Math.max(20, p.y + (dp.y / d) * Math.min(d, t)))
    }
    t -= cool
  }
  return fit(pos, centerId)
}

/** How far from the edge the fitted drawing stays, in layout units — room for a label. */
const MARGIN = 60

/**
 * Stretch the settled layout to use the drawing. The forces decide the shape;
 * this decides the size, so three people are not a dot in the middle of an
 * empty box on a phone. The person a profile is about stays in the centre.
 */
function fit(pos: Map<string, Point>, centerId?: string): Map<string, Point> {
  const pts = [...pos.values()]
  if (pts.length < 2) return pos
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const cx = centerId && pos.has(centerId) ? W / 2 : (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = centerId && pos.has(centerId) ? H / 2 : (Math.min(...ys) + Math.max(...ys)) / 2
  const dx = Math.max(1, ...xs.map((x) => Math.abs(x - cx)))
  const dy = Math.max(1, ...ys.map((y) => Math.abs(y - cy)))
  const s = Math.min((W / 2 - MARGIN) / dx, (H / 2 - MARGIN) / dy)
  const out = new Map<string, Point>()
  for (const [id, p] of pos) out.set(id, { x: W / 2 + (p.x - cx) * s, y: H / 2 + (p.y - cy) * s })
  return out
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

type View = { x: number; y: number; s: number }
const HOME: View = { x: 0, y: 0, s: 1 }

export function ForceGraph({
  nodes,
  links,
  centerId,
  highlight,
  height = 420,
  label,
}: {
  nodes: GraphNode[]
  links: GraphLink[]
  centerId?: string
  /** A person to pick out, e.g. from a search box. */
  highlight?: string | null
  height?: number
  /** What the drawing is, for a screen reader. */
  label: string
}) {
  const navigate = useNavigate()
  const [box, width] = useWidth<HTMLDivElement>()
  const [active, setActive] = useState<string | null>(null)
  const [view, setView] = useState<View>(HOME)
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null)
  const svg = useRef<SVGSVGElement>(null)

  const placed = useMemo(() => layout(nodes, links, centerId), [nodes, links, centerId])
  const focus = active ?? highlight ?? null
  const neighbours = useMemo(() => {
    const out = new Set<string>()
    if (!focus) return out
    for (const l of links) {
      if (l.source === focus) out.add(l.target)
      if (l.target === focus) out.add(l.source)
    }
    return out
  }, [focus, links])

  useEffect(() => setView(HOME), [nodes])

  // Labels: everybody in a small network; in a big one, the centre, the best
  // connected dozen, and whoever is being pointed at and their neighbours.
  const labelled = useMemo(() => {
    if (nodes.length <= 30) return new Set(nodes.map((n) => n.id))
    const top = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 12)
    return new Set([...top.map((n) => n.id), ...(centerId ? [centerId] : [])])
  }, [nodes, centerId])

  const vbW = W / view.s
  const vbH = H / view.s
  const vbX = W / 2 - vbW / 2 + view.x
  const vbY = H / 2 - vbH / 2 + view.y

  // Screen pixels per layout unit at no zoom (the viewBox is fitted, "meet").
  // Dots, lines and names are sized in pixels through this, so a phone gets
  // the same legible 12px name as a desktop, and zooming in grows them gently.
  const perUnit = width > 0 ? Math.min(width / W, height / H) : 1
  const px = (n: number) => n / (perUnit * Math.sqrt(view.s))

  function zoom(by: number) {
    setView((v) => ({ ...v, s: Math.min(6, Math.max(0.6, v.s * by)) }))
  }

  function onWheel(e: React.WheelEvent) {
    // A plain wheel scrolls the page, as everywhere else. Ctrl + wheel, which
    // is also what a trackpad pinch sends, zooms the drawing.
    if (!e.ctrlKey && !e.metaKey) return
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }

  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as Element).closest("[data-node]")) return
    drag.current = { x: e.clientX, y: e.clientY, view, moved: false }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current
    if (!d || !width) return
    const per = W / view.s / width
    const dx = (e.clientX - d.x) * per
    const dy = (e.clientY - d.y) * per
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true
    setView({ ...d.view, x: d.view.x - dx, y: d.view.y - dy })
  }
  function onPointerUp() {
    drag.current = null
  }

  // Wheel zoom needs a non-passive listener, which React's onWheel is not.
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const stop = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    }
    el.addEventListener("wheel", stop, { passive: false })
    return () => el.removeEventListener("wheel", stop)
  }, [width])

  const nodeRadius = (n: GraphNode) => (n.id === centerId ? 13 : 5 + Math.min(9, Math.sqrt(n.degree) * 2))

  return (
    <div className="space-y-2">
      <div ref={box} className="relative w-full overflow-hidden rounded-lg bg-sunken" style={{ height }}>
        {width > 0 && (
          <svg
            ref={svg}
            width={width}
            height={height}
            viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
            preserveAspectRatio="xMidYMid meet"
            role="group"
            aria-label={label}
            className="cursor-grab touch-none select-none active:cursor-grabbing"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <g>
              {links.map((l) => {
                const a = placed.get(l.source)
                const b = placed.get(l.target)
                if (!a || !b) return null
                const touches = !!focus && (l.source === focus || l.target === focus)
                const dim = !!focus && !touches
                const collab = l.kind === "collab"
                return (
                  <line
                    key={`${l.kind}-${l.source}-${l.target}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={collab || touches ? "var(--color-accent)" : "var(--color-fg-subtle)"}
                    strokeWidth={px(collab ? 2 : Math.min(4, 1 + l.papers * 0.6))}
                    strokeDasharray={collab ? "6 4" : undefined}
                    opacity={dim ? 0.1 : touches ? 0.95 : 0.45}
                  >
                    <title>{collab ? `Collaborating${l.topic ? ` on ${l.topic}` : ""}` : `${l.papers} paper${l.papers === 1 ? "" : "s"} together`}</title>
                  </line>
                )
              })}
            </g>
            <g>
              {nodes.map((n) => {
                const p = placed.get(n.id)
                if (!p) return null
                const isFocus = n.id === focus
                const lit = isFocus || n.id === centerId
                const dim = !!focus && !isFocus && !neighbours.has(n.id)
                const r = px(nodeRadius(n))
                const showLabel = labelled.has(n.id) || isFocus || neighbours.has(n.id)
                return (
                  <g
                    key={n.id}
                    data-node=""
                    tabIndex={0}
                    role="link"
                    aria-label={`${n.name}${n.department ? `, ${n.department}` : ""}, ${n.degree} connection${n.degree === 1 ? "" : "s"}. Opens their profile.`}
                    onMouseEnter={() => setActive(n.id)}
                    onMouseLeave={() => setActive((a) => (a === n.id ? null : a))}
                    onFocus={() => setActive(n.id)}
                    onBlur={() => setActive((a) => (a === n.id ? null : a))}
                    onClick={() => navigate(`/u/${n.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        navigate(`/u/${n.id}`)
                      }
                    }}
                    className="cursor-pointer outline-none"
                    opacity={dim ? 0.25 : 1}
                  >
                    <circle cx={p.x} cy={p.y} r={r + px(8)} fill="transparent" />
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      fill={lit ? "var(--color-accent)" : "var(--color-fg-muted)"}
                      stroke={isFocus ? "var(--color-accent-line)" : "var(--color-bg)"}
                      strokeWidth={px(isFocus ? 4 : 1.5)}
                    />
                    {showLabel && (
                      <text
                        x={p.x}
                        y={p.y - r - px(5)}
                        textAnchor="middle"
                        fontSize={px(12)}
                        className={cn("fill-fg", isFocus && "font-semibold")}
                        stroke="var(--color-bg)"
                        strokeWidth={px(3)}
                        paintOrder="stroke"
                      >
                        {n.name.length > 24 ? `${n.name.slice(0, 23)}…` : n.name}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        )}
        <div className="absolute right-2 top-2 flex flex-col gap-1">
          <Button kind="default" size="icon" aria-label="Zoom in" onClick={() => zoom(1.3)}>
            <Plus />
          </Button>
          <Button kind="default" size="icon" aria-label="Zoom out" onClick={() => zoom(1 / 1.3)}>
            <Minus />
          </Button>
          <Button kind="default" size="icon" aria-label="Back to the whole picture" onClick={() => setView(HOME)}>
            <RotateCcw />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Meta className="inline-flex items-center gap-1.5 text-xs">
          <svg width="22" height="6" aria-hidden>
            <line x1="0" y1="3" x2="22" y2="3" stroke="var(--color-fg-subtle)" strokeWidth="2" />
          </svg>
          Wrote a paper together
        </Meta>
        <Meta className="inline-flex items-center gap-1.5 text-xs">
          <svg width="22" height="6" aria-hidden>
            <line x1="0" y1="3" x2="22" y2="3" stroke="var(--color-accent)" strokeWidth="2" strokeDasharray="6 4" />
          </svg>
          Collaborating
        </Meta>
        <Meta className="text-xs">
          Drag to move. Zoom with the buttons, a trackpad pinch or Ctrl and scroll. Tap a person to open them.
        </Meta>
      </div>
    </div>
  )
}
