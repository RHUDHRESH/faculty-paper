import "./pdf.css"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist"
import type * as Pdfjs from "pdfjs-dist"
import type { TextContent } from "pdfjs-dist/types/src/display/api"
import {
  ChevronDown,
  ChevronUp,
  Download,
  Expand,
  Landmark,
  PanelLeft,
  RotateCw,
  Search,
  Shrink,
  StretchHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"

import { cn } from "@/lib/cn"
import { MarkLayer } from "@/ui/review-marks"

import { describePdfError, loadPdfjs } from "./pdf-engine"
import {
  buildPageText,
  findAffiliation,
  findAll,
  phrasePattern,
  piecesOf,
  type PageText,
  type Span,
} from "./pdf-text"
import { stepZoom, ToolButton, ToolDivider, ToolTextButton } from "./tool"
import { ADD_MARK_EVENT } from "../events"

/**
 * A real PDF viewer for the review workspace.
 *
 * The side sheet framed the file in an `<iframe>`, which on a phone is a blank
 * rectangle, on a desktop is a browser's own viewer with no way to ask "does
 * this paper name our college", and on neither could a reviewer mark a page.
 * pdf.js draws each page to a canvas (so a mark can sit on it at a known
 * place), lays invisible selectable text over it (so search and text marks
 * work) and reads the file in byte ranges (so the first page shows before the
 * last is downloaded).
 *
 * Only pages near the screen are drawn. A forty-page paper at a comfortable
 * zoom is tens of millions of pixels; drawing all of it is what freezes a
 * reviewer's laptop halfway through a queue.
 */

export type PdfViewProps = {
  url: string
  filename: string
  claimId: string
  uploadId: string | null
}

type Size = { w: number; h: number }

type FoundText = { content: TextContent; page: PageText }

type Hit = { page: number; span: Span }

type SearchState = {
  status: "idle" | "running" | "done"
  hits: Hit[]
  scanned: number
  /** Runs of text seen across the file. Zero on a scan with no text layer. */
  runs: number
}

const NO_SEARCH: SearchState = { status: "idle", hits: [], scanned: 0, runs: 0 }
const GAP = 12
const SIDE = 16

export default function PdfView({ url, filename, claimId, uploadId }: PdfViewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageEls = useRef<Map<number, HTMLDivElement>>(new Map())
  const textCache = useRef<Map<number, Promise<FoundText>>>(new Map())

  const [lib, setLib] = useState<typeof Pdfjs | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [sizes, setSizes] = useState<Size[]>([])

  const [zoom, setZoom] = useState<"fit" | number>("fit")
  const [rotation, setRotation] = useState(0)
  const [box, setBox] = useState(0)
  const [current, setCurrent] = useState(1)
  const [pageInput, setPageInput] = useState("1")
  const [thumbs, setThumbs] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1280)
  const [fullscreen, setFullscreen] = useState(false)

  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [mode, setMode] = useState<"text" | "affiliation">("text")
  const [search, setSearch] = useState<SearchState>(NO_SEARCH)
  const [active, setActive] = useState(0)
  const [activeToken, setActiveToken] = useState(0)
  // "m" in the workspace starts drawing a mark on the page in view.
  const [drawing, setDrawing] = useState(false)
  useEffect(() => {
    const start = () => setDrawing(true)
    window.addEventListener(ADD_MARK_EVENT, start)
    return () => window.removeEventListener(ADD_MARK_EVENT, start)
  }, [])
  const searchInput = useRef<HTMLInputElement>(null)

  const numPages = doc?.numPages ?? 0

  /* ---- opening the file ------------------------------------------------ */

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof Pdfjs.getDocument> | null = null
    setDoc(null)
    setError(null)
    setProgress(0)
    setSizes([])
    setCurrent(1)
    setSearch(NO_SEARCH)
    textCache.current = new Map()
    ;(async () => {
      const pdfjs = await loadPdfjs()
      if (cancelled) return
      setLib(pdfjs)
      task = pdfjs.getDocument({ url, withCredentials: true })
      task.onProgress = ({ loaded, total }: { loaded: number; total?: number }) => {
        if (!cancelled) setProgress(total ? loaded / total : null)
      }
      const opened = await task.promise
      if (cancelled) {
        void task.destroy()
        return
      }
      const first = await opened.getPage(1)
      if (cancelled) return
      const v = first.getViewport({ scale: 1 })
      const firstSize = { w: v.width, h: v.height }
      setSizes(Array.from({ length: opened.numPages }, () => firstSize))
      setDoc(opened)
      setProgress(null)
      // The rest are measured quietly. Most papers are one size throughout,
      // so this changes nothing; a scanned appendix in a different size
      // reflows once, here, not on every scroll.
      const measured: Size[] = Array.from({ length: opened.numPages }, () => firstSize)
      for (let n = 2; n <= opened.numPages; n++) {
        if (cancelled) return
        try {
          const p = await opened.getPage(n)
          const pv = p.getViewport({ scale: 1 })
          measured[n - 1] = { w: pv.width, h: pv.height }
        } catch {
          return
        }
        if (n % 8 === 0 || n === opened.numPages) setSizes([...measured])
      }
    })().catch((err) => {
      if (!cancelled) setError(describePdfError(err))
    })
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [url])

  /* ---- size of the scroll area ----------------------------------------- */

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setBox(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [doc])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  const turned = rotation % 180 !== 0
  const dims = useMemo(() => sizes.map((s) => (turned ? { w: s.h, h: s.w } : s)), [sizes, turned])
  const fitScale = useMemo(() => {
    const w = dims[0]?.w
    if (!w || box <= 0) return 1
    return Math.min(4, Math.max(0.25, (box - SIDE * 2) / w))
  }, [dims, box])
  const scale = zoom === "fit" ? fitScale : zoom

  /* ---- where we are ---------------------------------------------------- */

  const updateCurrent = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const line = el.scrollTop + el.clientHeight * 0.3
    let at = 1
    for (const [n, node] of pageEls.current) {
      if (node.offsetTop <= line && n >= at) at = n
    }
    setCurrent(at)
    setPageInput(String(at))
  }, [])

  const scrolling = useRef(false)
  const onScroll = useCallback(() => {
    if (scrolling.current) return
    scrolling.current = true
    requestAnimationFrame(() => {
      scrolling.current = false
      updateCurrent()
    })
  }, [updateCurrent])

  const scrollToPage = useCallback((n: number, smooth = false) => {
    const el = scrollRef.current
    const node = pageEls.current.get(n)
    if (!el || !node) return
    el.scrollTo({ top: Math.max(0, node.offsetTop - GAP), behavior: smooth ? "smooth" : "auto" })
  }, [])

  const goTo = useCallback(
    (n: number) => {
      const clamped = Math.min(Math.max(1, n), Math.max(1, numPages))
      setCurrent(clamped)
      setPageInput(String(clamped))
      scrollToPage(clamped)
    },
    [numPages, scrollToPage]
  )

  // Zooming or turning changes every page's height, and the reader should
  // keep their place rather than be thrown back up the page.
  const keepPlace = useRef(1)
  useEffect(() => {
    keepPlace.current = current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, rotation])
  useEffect(() => {
    const id = requestAnimationFrame(() => scrollToPage(keepPlace.current))
    return () => cancelAnimationFrame(id)
  }, [scale, rotation, scrollToPage])

  /* ---- text of each page ----------------------------------------------- */

  const getText = useCallback(
    (n: number): Promise<FoundText> => {
      const cached = textCache.current.get(n)
      if (cached) return cached
      const wanted = (async () => {
        if (!doc) throw new Error("no document")
        const page = await doc.getPage(n)
        const content = await page.getTextContent()
        // The runs the text layer will draw, in its order: everything that
        // has a string. Marked-content markers have none.
        const runs = content.items.flatMap((item) => ("str" in item ? [item.str] : []))
        return { content, page: buildPageText(runs) }
      })()
      textCache.current.set(n, wanted)
      return wanted
    },
    [doc]
  )

  /* ---- search ---------------------------------------------------------- */

  useEffect(() => {
    if (!doc || !findOpen) return
    if (mode === "text" && !query.trim()) {
      setSearch(NO_SEARCH)
      return
    }
    let cancelled = false
    const pattern = mode === "text" ? phrasePattern(query) : null
    const timer = window.setTimeout(async () => {
      const hits: Hit[] = []
      let runs = 0
      setSearch({ status: "running", hits: [], scanned: 0, runs: 0 })
      for (let n = 1; n <= doc.numPages; n++) {
        if (cancelled) return
        try {
          const { page } = await getText(n)
          runs += page.runs.length
          const spans = mode === "affiliation" ? findAffiliation(page.text) : pattern ? findAll(page.text, pattern) : []
          for (const span of spans) hits.push({ page: n, span })
        } catch {
          // A page that will not parse is a page with no text, not a reason
          // to stop looking at the rest.
        }
        if (n % 4 === 0 || n === doc.numPages) {
          if (cancelled) return
          setSearch({ status: n === doc.numPages ? "done" : "running", hits: [...hits], scanned: n, runs })
        }
      }
      if (!cancelled) {
        setActive(0)
        setActiveToken((t) => t + 1)
        if (hits[0]) scrollToPage(hits[0].page)
      }
    }, mode === "text" ? 250 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [doc, findOpen, mode, query, getText, scrollToPage])

  const stepHit = useCallback(
    (delta: 1 | -1) => {
      if (search.hits.length === 0) return
      const next = (active + delta + search.hits.length) % search.hits.length
      setActive(next)
      setActiveToken((t) => t + 1)
      scrollToPage(search.hits[next].page)
    },
    [active, search.hits, scrollToPage]
  )

  const openFind = useCallback((m: "text" | "affiliation") => {
    setMode(m)
    setFindOpen(true)
    if (m === "text") requestAnimationFrame(() => searchInput.current?.focus())
  }, [])

  const hitsByPage = useMemo(() => {
    const by = new Map<number, { spans: Span[]; activeSpan: number }>()
    search.hits.forEach((h, i) => {
      const entry = by.get(h.page) ?? { spans: [], activeSpan: -1 }
      if (i === active) entry.activeSpan = entry.spans.length
      entry.spans.push(h.span)
      by.set(h.page, entry)
    })
    return by
  }, [search.hits, active])

  const affiliationPages = useMemo(
    () => [...new Set(search.hits.map((h) => h.page))].sort((a, b) => a - b),
    [search.hits]
  )

  /* ---- toolbar actions ------------------------------------------------- */

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen?.()
  }

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return
    // A pinch or Ctrl-wheel zooms the page, not the browser's whole window.
    e.preventDefault()
    setZoom(stepZoom(scale, e.deltaY < 0 ? 1 : -1))
  }

  useEffect(() => {
    // React attaches wheel listeners as passive, where preventDefault is
    // ignored. Stop the browser's own page zoom on the scroll area directly.
    const el = scrollRef.current
    if (!el) return
    const stop = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    }
    el.addEventListener("wheel", stop, { passive: false })
    return () => el.removeEventListener("wheel", stop)
  }, [doc])

  /* ---- drawing --------------------------------------------------------- */

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex shrink-0 flex-wrap items-center gap-x-0.5 gap-y-1 border-b border-line bg-surface px-2 py-1">
        <ToolButton label={thumbs ? "Hide page thumbnails" : "Show page thumbnails"} active={thumbs} onClick={() => setThumbs((v) => !v)}>
          <PanelLeft />
        </ToolButton>
        <ToolDivider />
        <form
          className="flex items-center gap-1 text-xs text-fg-muted"
          onSubmit={(e) => {
            e.preventDefault()
            const n = Number.parseInt(pageInput, 10)
            if (Number.isFinite(n)) goTo(n)
          }}
        >
          <label className="sr-only" htmlFor="pdf-page-input">
            Page number
          </label>
          <input
            id="pdf-page-input"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            onFocus={(e) => e.currentTarget.select()}
            inputMode="numeric"
            className="h-7 w-10 rounded-md bg-sunken text-center text-sm tabular text-fg max-sm:h-9"
          />
          <span className="tabular">of {numPages || "…"}</span>
        </form>
        <ToolButton label="Previous page" disabled={current <= 1} onClick={() => goTo(current - 1)}>
          <ChevronUp />
        </ToolButton>
        <ToolButton label="Next page" disabled={current >= numPages} onClick={() => goTo(current + 1)}>
          <ChevronDown />
        </ToolButton>
        <ToolDivider />
        <ToolButton label="Zoom out" onClick={() => setZoom(stepZoom(scale, -1))}>
          <ZoomOut />
        </ToolButton>
        <span className="w-11 text-center text-xs tabular text-fg-muted" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <ToolButton label="Zoom in" onClick={() => setZoom(stepZoom(scale, 1))}>
          <ZoomIn />
        </ToolButton>
        <ToolButton label="Fit to width" active={zoom === "fit"} onClick={() => setZoom("fit")}>
          <StretchHorizontal />
        </ToolButton>
        <ToolButton label="Turn the page clockwise" onClick={() => setRotation((r) => (r + 90) % 360)}>
          <RotateCw />
        </ToolButton>
        <ToolDivider />
        <ToolButton label="Search this file" active={findOpen && mode === "text"} onClick={() => (findOpen && mode === "text" ? setFindOpen(false) : openFind("text"))}>
          <Search />
        </ToolButton>
        <ToolTextButton label="Find affiliation" active={findOpen && mode === "affiliation"} onClick={() => openFind("affiliation")}>
          <Landmark />
        </ToolTextButton>
        <span className="ml-auto flex items-center gap-0.5">
          <ToolButton label={fullscreen ? "Leave full screen" : "Full screen"} onClick={toggleFullscreen}>
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

      {findOpen && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-sunken px-3 py-1.5 text-sm">
          {mode === "text" ? (
            <>
              <label className="sr-only" htmlFor="pdf-find">
                Search this file
              </label>
              <input
                id="pdf-find"
                ref={searchInput}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    stepHit(e.shiftKey ? -1 : 1)
                  } else if (e.key === "Escape") {
                    setFindOpen(false)
                  }
                }}
                placeholder="Search this file"
                className="h-8 min-w-0 flex-1 rounded-md bg-surface px-2.5 text-sm shadow-well ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent sm:max-w-xs max-sm:h-10"
              />
            </>
          ) : (
            <span className="font-medium">Saveetha Engineering College and its usual spellings</span>
          )}
          <span role="status" aria-live="polite" className="text-xs text-fg-muted">
            <SearchSummary state={search} mode={mode} query={query} active={active} pages={affiliationPages} />
          </span>
          <span className="ml-auto flex items-center gap-0.5">
            {mode === "affiliation" && (
              <ToolTextButton label="Search for words" onClick={() => openFind("text")}>
                <Search />
              </ToolTextButton>
            )}
            <ToolButton label="Previous match" disabled={search.hits.length === 0} onClick={() => stepHit(-1)}>
              <ChevronUp />
            </ToolButton>
            <ToolButton label="Next match" disabled={search.hits.length === 0} onClick={() => stepHit(1)}>
              <ChevronDown />
            </ToolButton>
            <ToolButton label="Close search" onClick={() => setFindOpen(false)}>
              <X />
            </ToolButton>
          </span>
        </div>
      )}

      {progress !== null && !error && (
        <div className="h-0.5 shrink-0 bg-line" role="progressbar" aria-label="Opening the file" aria-valuenow={Math.round((progress ?? 0) * 100)}>
          <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.max(6, Math.round((progress ?? 0) * 100))}%` }} />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {thumbs && doc && (
          <Thumbnails doc={doc} sizes={dims} rotation={rotation} current={current} onPick={goTo} />
        )}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={onWheel}
          tabIndex={0}
          aria-label={`${filename}, page ${current} of ${numPages || "…"}`}
          className="relative min-w-0 flex-1 overflow-auto bg-sunken outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          {error ? (
            <div className="mx-auto max-w-md p-8 text-center">
              <p className="text-sm text-critical" role="alert">
                {error}
              </p>
              <a href={url} download={filename} className="mt-3 inline-block text-sm underline underline-offset-2">
                Download the file
              </a>
            </div>
          ) : !doc || !lib ? (
            <div className="grid h-full place-items-center p-8 text-sm text-fg-muted" role="status">
              Opening the file…
            </div>
          ) : (
            <div className="relative mx-auto flex w-max min-w-full flex-col items-center py-3" style={{ rowGap: GAP }}>
              {dims.map((d, i) => {
                const n = i + 1
                const found = hitsByPage.get(n)
                return (
                  <PageView
                    key={n}
                    lib={lib}
                    doc={doc}
                    pageNumber={n}
                    size={d}
                    scale={scale}
                    rotation={rotation}
                    getText={getText}
                    hits={found?.spans ?? null}
                    activeSpan={found?.activeSpan ?? -1}
                    activeToken={activeToken}
                    claimId={claimId}
                    uploadId={uploadId}
                    drawing={drawing && n === current}
                    onDrawingChange={setDrawing}
                    root={scrollRef}
                    register={(el) => {
                      if (el) pageEls.current.set(n, el)
                      else pageEls.current.delete(n)
                    }}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Search summary                                                             */
/* -------------------------------------------------------------------------- */

function pagesSentence(pages: number[]): string {
  if (pages.length === 1) return `page ${pages[0]}`
  const head = pages.slice(0, -1).join(", ")
  return `pages ${head} and ${pages[pages.length - 1]}`
}

/**
 * What the search found, in words. The affiliation answer is the one a
 * claim turns on, so "not found" says whether the file has any text to search
 * at all: a scan with no text layer is not evidence that the college is
 * missing from the paper.
 */
function SearchSummary({
  state,
  mode,
  query,
  active,
  pages,
}: {
  state: SearchState
  mode: "text" | "affiliation"
  query: string
  active: number
  pages: number[]
}) {
  if (mode === "text" && !query.trim()) return <>Type to search this file.</>
  if (state.status === "running") return <>Searching… {state.hits.length} found so far.</>
  if (state.status === "idle") return null
  if (state.hits.length === 0) {
    if (state.runs === 0) {
      return <>This file has no text to search. It may be a scan, so read it by eye.</>
    }
    return mode === "affiliation" ? (
      <span className="font-medium text-critical">The college's name was not found in this file.</span>
    ) : (
      <>Not found in this file.</>
    )
  }
  if (mode === "affiliation") {
    return (
      <span className="font-medium text-positive">
        Found {state.hits.length} {state.hits.length === 1 ? "time" : "times"}, on {pagesSentence(pages)}. Showing {active + 1}.
      </span>
    )
  }
  return (
    <>
      {active + 1} of {state.hits.length}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* One page                                                                   */
/* -------------------------------------------------------------------------- */

const MAX_CANVAS_PIXELS = 16_000_000

function PageView({
  lib,
  doc,
  pageNumber,
  size,
  scale,
  rotation,
  getText,
  hits,
  activeSpan,
  activeToken,
  claimId,
  uploadId,
  drawing,
  onDrawingChange,
  register,
  root,
}: {
  lib: typeof Pdfjs
  doc: PDFDocumentProxy
  pageNumber: number
  size: Size
  scale: number
  rotation: number
  getText: (n: number) => Promise<FoundText>
  hits: Span[] | null
  activeSpan: number
  activeToken: number
  claimId: string
  uploadId: string | null
  drawing: boolean
  onDrawingChange: (on: boolean) => void
  register: (el: HTMLDivElement | null) => void
  root: React.RefObject<HTMLDivElement | null>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(pageNumber <= 2)
  const [layer, setLayer] = useState<{ divs: HTMLElement[]; page: PageText } | null>(null)
  const painted = useRef<Set<number>>(new Set())

  const width = Math.floor(size.w * scale)
  const height = Math.floor(size.h * scale)

  useEffect(() => {
    register(hostRef.current)
    return () => register(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Near the screen means within about a page and a half either side.
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    // The scroller is the root: with the window as root, the scroller's own
    // clip would cut the margin off and nothing below the fold would count.
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: root.current,
      rootMargin: "1200px 0px",
    })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  useEffect(() => {
    const canvas = canvasRef.current
    const textEl = textRef.current
    if (!canvas || !textEl) return
    if (!near) {
      // Off screen: give the memory back. The page keeps its size, so the
      // scroll position does not move.
      canvas.width = 0
      canvas.height = 0
      textEl.replaceChildren()
      painted.current.clear()
      setLayer(null)
      return
    }
    let cancelled = false
    let task: RenderTask | null = null
    let textLayer: TextLayer | null = null
    ;(async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 })
      let ratio = Math.min(2, window.devicePixelRatio || 1)
      const pixels = viewport.width * viewport.height * ratio * ratio
      if (pixels > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      task = page.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      })
      await task.promise
      if (cancelled) return
      const found = await getText(pageNumber)
      if (cancelled) return
      textEl.replaceChildren()
      painted.current.clear()
      textLayer = new lib.TextLayer({ textContentSource: found.content, container: textEl, viewport })
      await textLayer.render()
      if (cancelled) return
      setLayer({ divs: textLayer.textDivs, page: found.page })
    })().catch((err: unknown) => {
      // A render cancelled by a zoom is the normal way for one to end.
      const name = (err as { name?: string } | null)?.name
      if (name !== "RenderingCancelledException" && name !== "AbortException") {
        // The page stays blank; the rest of the file is still readable.
        console.warn("PDF page did not draw", pageNumber, err)
      }
    })
    return () => {
      cancelled = true
      task?.cancel()
      textLayer?.cancel()
    }
  }, [doc, lib, pageNumber, scale, rotation, near, getText])

  // Draw the search hits into the text layer. Each hit is cut to the runs it
  // touches; the runs are put back the way they were first when the hits
  // change, so nothing accumulates.
  useEffect(() => {
    if (!layer) return
    const { divs, page } = layer
    for (const i of painted.current) {
      if (divs[i]) divs[i].textContent = page.runs[i]
    }
    painted.current.clear()
    if (!hits || hits.length === 0) return

    const perRun = new Map<number, { from: number; to: number; active: boolean }[]>()
    hits.forEach((span, k) => {
      for (const p of piecesOf(page, span)) {
        const list = perRun.get(p.run) ?? []
        list.push({ from: p.from, to: p.to, active: k === activeSpan })
        perRun.set(p.run, list)
      }
    })
    let firstActive: HTMLElement | null = null
    for (const [run, pieces] of perRun) {
      const div = divs[run]
      if (!div) continue
      const text = page.runs[run]
      const frag = document.createDocumentFragment()
      let at = 0
      for (const p of pieces.sort((a, b) => a.from - b.from)) {
        if (p.from > at) frag.append(text.slice(at, p.from))
        const mark = document.createElement("mark")
        mark.textContent = text.slice(Math.max(p.from, at), p.to)
        if (p.active) {
          mark.dataset.active = "true"
          firstActive ??= mark
        }
        frag.append(mark)
        at = p.to
      }
      if (at < text.length) frag.append(text.slice(at))
      div.replaceChildren(frag)
      painted.current.add(run)
    }
    if (firstActive) (firstActive as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" })
    // activeToken re-centres on the same hit when the reviewer asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, hits, activeSpan, activeToken])

  return (
    <div
      ref={hostRef}
      data-page={pageNumber}
      className="pdf-page relative shrink-0 bg-white shadow-under"
      style={{ width, height, ["--total-scale-factor" as string]: String(scale) }}
    >
      <canvas ref={canvasRef} className="absolute left-0 top-0 block" aria-label={`Page ${pageNumber}`} role="img" />
      <div ref={textRef} className="pdf-text" />
      {/* The marks layer sits over the text so a reviewer can draw or select
          on it. Turned pages are left unmarked: a mark is stored as fractions
          of the upright page, and would land in the wrong place. */}
      {rotation === 0 && uploadId && (
        <div className="pointer-events-none absolute inset-0 z-20">
          <MarkLayer
            claimId={claimId}
            uploadId={uploadId}
            page={pageNumber}
            scale={scale}
            drawMode={drawing}
            onDrawModeChange={onDrawingChange}
          />
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Thumbnails                                                                 */
/* -------------------------------------------------------------------------- */

const THUMB_WIDTH = 92

function Thumbnails({
  doc,
  sizes,
  rotation,
  current,
  onPick,
}: {
  doc: PDFDocumentProxy
  sizes: Size[]
  rotation: number
  current: number
  onPick: (n: number) => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const strip = stripRef.current
    const on = strip?.querySelector<HTMLElement>(`[data-thumb="${current}"]`)
    if (!strip || !on) return
    const top = on.offsetTop
    if (top < strip.scrollTop || top + on.offsetHeight > strip.scrollTop + strip.clientHeight) {
      strip.scrollTo({ top: Math.max(0, top - 24) })
    }
  }, [current])

  return (
    <div
      ref={stripRef}
      aria-label="Pages"
      className="relative hidden w-[7.5rem] shrink-0 overflow-y-auto border-r border-line bg-surface py-2 sm:block"
    >
      <ol className="flex flex-col items-center gap-2">
        {sizes.map((s, i) => (
          <Thumb key={i} doc={doc} pageNumber={i + 1} size={s} rotation={rotation} active={current === i + 1} onPick={onPick} root={stripRef} />
        ))}
      </ol>
    </div>
  )
}

function Thumb({
  doc,
  pageNumber,
  size,
  rotation,
  active,
  onPick,
  root,
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  size: Size
  rotation: number
  active: boolean
  onPick: (n: number) => void
  root: React.RefObject<HTMLDivElement | null>
}) {
  const ref = useRef<HTMLLIElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(pageNumber <= 6)
  const scale = THUMB_WIDTH / size.w
  const height = Math.round(size.h * scale)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: "400px 0px" })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!near) {
      canvas.width = 0
      canvas.height = 0
      return
    }
    let cancelled = false
    let task: RenderTask | null = null
    ;(async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const turned = (page.rotate + rotation) % 360
      const base = page.getViewport({ scale: 1, rotation: turned })
      const viewport = page.getViewport({ scale: (THUMB_WIDTH / base.width) * (window.devicePixelRatio || 1), rotation: turned })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      task = page.render({ canvas, viewport })
      await task.promise
    })().catch(() => {})
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNumber, rotation, near])

  return (
    <li ref={ref} data-thumb={pageNumber}>
      <button
        type="button"
        onClick={() => onPick(pageNumber)}
        aria-label={`Go to page ${pageNumber}`}
        aria-current={active || undefined}
        className={cn(
          "flex flex-col items-center gap-1 rounded-md p-1 hover:bg-hover",
          active && "bg-selected ring-1 ring-accent"
        )}
      >
        <span className="block bg-white shadow-well" style={{ width: THUMB_WIDTH, height }}>
          <canvas ref={canvasRef} className="block" style={{ width: THUMB_WIDTH, height }} />
        </span>
        <span className="text-xs tabular text-fg-muted">{pageNumber}</span>
      </button>
    </li>
  )
}
