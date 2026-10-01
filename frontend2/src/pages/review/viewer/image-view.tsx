import { useEffect, useRef, useState } from "react"
import { Download, Expand, RotateCw, Shrink, StretchHorizontal, ZoomIn, ZoomOut } from "lucide-react"

import { stepZoom, ToolButton, ToolDivider } from "./tool"

/**
 * A scanned page or a photo, with the same zoom, turn and full screen as a
 * PDF and a drag to move around it.
 *
 * A scan of a title page is often a photograph of a whole sheet with a small
 * line of type on it. At "fit" that line is unreadable, and an `<img>` in a
 * card offers no way to get closer, so the reviewer squints, guesses, or
 * sends the claim back for a clearer copy it did not need.
 */
export default function ImageView({ url, filename }: { url: string; filename: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [fit, setFit] = useState(true)
  const [rotation, setRotation] = useState(0)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [failed, setFailed] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    setScale(1)
    setFit(true)
    setRotation(0)
    setOffset({ x: 0, y: 0 })
    setNatural(null)
    setFailed(false)
  }, [url])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  // The scale that makes the whole picture fit, given how it is turned.
  const turned = rotation % 180 !== 0
  const fitScale =
    natural && stage.w > 0 && stage.h > 0
      ? Math.min(stage.w / (turned ? natural.h : natural.w), stage.h / (turned ? natural.w : natural.h), 4)
      : 1
  const shown = fit ? fitScale : scale

  function zoomTo(next: number) {
    setFit(false)
    setScale(next)
  }

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    // Passive listeners cannot stop the page zooming; this one is not passive.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const from = fit ? fitScale : scale
      setFit(false)
      setScale(stepZoom(from, e.deltaY < 0 ? 1 : -1))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [fit, fitScale, scale])

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex shrink-0 flex-wrap items-center gap-x-0.5 gap-y-1 border-b border-line bg-surface px-2 py-1">
        <ToolButton label="Zoom out" onClick={() => zoomTo(stepZoom(shown, -1))}>
          <ZoomOut />
        </ToolButton>
        <span className="w-11 text-center text-xs tabular text-fg-muted" aria-live="polite">
          {Math.round(shown * 100)}%
        </span>
        <ToolButton label="Zoom in" onClick={() => zoomTo(stepZoom(shown, 1))}>
          <ZoomIn />
        </ToolButton>
        <ToolButton
          label="Fit to the window"
          active={fit}
          onClick={() => {
            setFit(true)
            setOffset({ x: 0, y: 0 })
          }}
        >
          <StretchHorizontal />
        </ToolButton>
        <ToolButton label="Turn clockwise" onClick={() => setRotation((r) => (r + 90) % 360)}>
          <RotateCw />
        </ToolButton>
        <ToolDivider />
        <span className="text-xs text-fg-subtle max-sm:hidden">Drag to move, scroll to zoom</span>
        <span className="ml-auto flex items-center gap-0.5">
          <ToolButton
            label={fullscreen ? "Leave full screen" : "Full screen"}
            onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void rootRef.current?.requestFullscreen?.())}
          >
            {fullscreen ? <Shrink /> : <Expand />}
          </ToolButton>
          <a
            href={url}
            download={filename}
            title="Download this file"
            aria-label="Download this file"
            className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg max-sm:size-10 [&_svg]:size-4"
          >
            <Download />
          </a>
        </span>
      </div>
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-sunken"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y })
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        {failed ? (
          <p role="alert" className="grid h-full place-items-center p-8 text-center text-sm text-critical">
            This image could not be opened. Download it to see what it really is.
          </p>
        ) : (
          <img
            src={url}
            alt={filename}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            className="absolute left-1/2 top-1/2 max-w-none cursor-grab active:cursor-grabbing"
            style={{
              width: natural ? natural.w : undefined,
              height: natural ? natural.h : undefined,
              transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg) scale(${shown})`,
            }}
          />
        )}
      </div>
    </div>
  )
}
