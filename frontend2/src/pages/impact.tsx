import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { motion, useReducedMotion } from "motion/react"
import { BadgeCheck, Check, Download, Link2, Share2 } from "lucide-react"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { CopyButton } from "@/ui/copy"
import { ConfirmDialog } from "@/ui/dialog"
import { Checkbox, Switch } from "@/ui/field"
import { HeroBand } from "@/ui/hero"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu"
import { SharePlate } from "@/ui/share-plate"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"

type ShareState = { enabled: boolean; token: string | null; path: string | null }

export type Headline = { key: string; big: string; label: string; priority: number }

export type Impact = {
  name: string
  initials: string
  designation: string
  department: string
  college: string
  papers: number
  papers_source: "record"
  q1: number
  first_author: number
  citations: number | null
  rank: number | null
  ranked_among: number | null
  rank_on_card: boolean
  top_journal: string | null
  since: number | null
  as_of: string
  headlines: Headline[]
  headline_text: string | null
  strip: { year: number; papers: number }[]
  photo_url: string | null
  share: ShareState
}

export const FORMATS = [
  { key: "portrait", label: "Portrait", dims: "1080 × 1350", w: 1080, h: 1350 },
  { key: "story", label: "Story", dims: "1080 × 1920", w: 1080, h: 1920 },
  { key: "linkedin", label: "LinkedIn", dims: "1200 × 627", w: 1200, h: 627 },
  { key: "square", label: "Square", dims: "1080 × 1080", w: 1080, h: 1080 },
] as const
type FormatKey = (typeof FORMATS)[number]["key"]

const THEMES = [
  { key: "navy", label: "Navy", swatch: "bg-[#2b398f]" },
  { key: "cream", label: "Cream", swatch: "bg-[#fbf8f1] ring-1 ring-inset ring-[#e0a82e]" },
  { key: "midnight", label: "Midnight", swatch: "bg-[#0b1030] ring-1 ring-inset ring-[#f5d27a]" },
] as const
type ThemeKey = (typeof THEMES)[number]["key"]

type Show = { photo: boolean; strip: boolean; qr: boolean; quote: boolean }

/** The server URL for the card with these choices: the preview and the download use the same one. */
export function cardUrl(
  opts: { format: FormatKey; theme: ThemeKey; headline: string | null; show: Show },
  version: number | string
): string {
  const q = new URLSearchParams({ format: opts.format, theme: opts.theme })
  if (opts.headline) q.set("headline", opts.headline)
  for (const k of ["photo", "strip", "qr", "quote"] as const) q.set(k, opts.show[k] ? "1" : "0")
  q.set("v", String(version))
  return `/api/me/impact/card.png?${q.toString()}`
}

const SHARE_TARGETS = [
  { key: "linkedin", label: "LinkedIn", href: (u: string) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(u)}` },
  { key: "whatsapp", label: "WhatsApp", href: (u: string, t: string) => `https://wa.me/?text=${encodeURIComponent(`${t} ${u}`)}` },
  { key: "x", label: "X", href: (u: string, t: string) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
] as const

/**
 * The impact card (docs/ux/15, "The Certificate").
 *
 * The preview is the server's own PNG, drawn with the very parameters the
 * Download and the public link use, so what the person sees is exactly what
 * they post -- LinkedIn and WhatsApp read OpenGraph tags and run no
 * JavaScript, which is why the card is drawn on the server at all. Counts come
 * from the publication record, the same as Home and My research. No money,
 * no staff id, no contact details.
 *
 * Sharing needs the public link; choosing a share target while it is off asks
 * first, and turns it on only after a yes.
 */
export function ImpactCardPage() {
  const { me } = useAuth()
  const query = useApi<Impact>(["impact"], "/api/me/impact")
  const share = useApiMutation<{ enabled: boolean }, ShareState>("/api/me/impact/share", {
    method: "PUT",
    invalidates: [["impact"]],
  })
  const [version] = useState(() => Date.now())
  const [format, setFormat] = useState<FormatKey>("portrait")
  const [theme, setTheme] = useState<ThemeKey>("navy")
  const [headline, setHeadline] = useState<string | null>(null)
  const [show, setShow] = useState<Show>({ photo: true, strip: true, qr: true, quote: true })
  const [pending, setPending] = useState<null | ((url: string) => void)>(null)

  const data = query.data
  const shareUrl = data?.share.path ? `${window.location.origin}${data.share.path}` : null
  const chosen = headline ?? data?.headlines[0]?.key ?? null
  const fmt = FORMATS.find((f) => f.key === format)!
  // The public link is part of the QR, so a flip of the switch redraws the card.
  const src = cardUrl({ format, theme, headline: chosen, show }, `${version}-${data?.share.enabled ? 1 : 0}`)
  const fileName = `impact-card-${format}-${(me?.name || "card").replace(/\W+/g, "-").toLowerCase()}.png`
  const head = data?.headlines.find((h) => h.key === chosen)
  const shareText = `My research impact at ${data?.college || "my college"}${head ? ` — ${head.big} ${head.label}` : ""}.`

  async function setShared(enabled: boolean) {
    try {
      const state = await share.mutateAsync({ enabled })
      toast.ok(enabled ? "Your card can be seen by anyone with the link" : "Your card is private again")
      return state
    } catch (err) {
      toast.fail(err)
      return null
    }
  }

  /** Run `go` with the public link, asking to turn it on first when it is off. */
  function withLink(go: (url: string) => void) {
    if (shareUrl) go(shareUrl)
    else setPending(() => go)
  }

  async function nativeShare() {
    try {
      const blob = await (await fetch(src, { credentials: "same-origin" })).blob()
      const file = new File([blob], fileName, { type: "image/png" })
      if (navigator.canShare?.({ files: [file] })) {
        withLink((url) => void navigator.share({ files: [file], text: `${shareText} ${url}` }).catch(() => {}))
        return true
      }
    } catch {
      /* fall through to the intent links */
    }
    return false
  }

  if (query.isError) {
    return (
      <div className="page py-8">
        <InlineError message="Could not load your impact card." onRetry={() => void query.refetch()} />
      </div>
    )
  }

  const canNative = typeof navigator !== "undefined" && typeof navigator.share === "function"

  return (
    <div className="page space-y-8">
      <HeroBand
        area="honours"
        eyebrow="Honours"
        title="Your impact card"
        sentence="Made from your record. It never shows money, your staff id or how to reach you."
        aside={
          data && data.papers > 0 ? (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <BadgeCheck className="size-5 text-(--area)" aria-hidden strokeWidth={1.75} />
              {data.papers.toLocaleString("en-IN")} {data.papers === 1 ? "paper" : "papers"} on your record
            </p>
          ) : undefined
        }
      />

      {!data ? (
        <div className="grid gap-8 lg:grid-cols-[3fr_2fr]">
          <Skeleton className="aspect-[4/5] w-full rounded-2xl" />
          <Skeleton className="h-96 w-full rounded-2xl" />
        </div>
      ) : (
        <div className="grid items-start gap-8 lg:grid-cols-[3fr_2fr]">
          <section aria-label="Preview" className="min-w-0 lg:sticky lg:top-6">
            <SharePlate className="p-4 sm:p-8">
              <CardPreview src={src} format={fmt} name={data.name} />
            </SharePlate>
            {data.papers === 0 && (
              <p className="mt-4 text-sm text-fg-muted">
                Your card fills in once your record is matched.{" "}
                <Link to="/research" className="font-medium text-accent hover:underline">
                  Check my record
                </Link>
              </p>
            )}
          </section>

          <section aria-label="Choices" className="min-w-0 space-y-7">
            <Group label="Format">
              <div role="radiogroup" aria-label="Format" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                {FORMATS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    role="radio"
                    aria-checked={format === f.key}
                    onClick={() => setFormat(f.key)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-sm ring-1 ring-inset transition-colors duration-[var(--dur-1)]",
                      format === f.key
                        ? "bg-(--area-wash) font-medium text-(--area) ring-(--area-fill)"
                        : "ring-line hover:bg-hover"
                    )}
                  >
                    <span
                      aria-hidden
                      className="rounded-[3px] ring-[1.5px] ring-current"
                      style={{ width: Math.round((24 * f.w) / Math.max(f.w, f.h)), height: Math.round((24 * f.h) / Math.max(f.w, f.h)) }}
                    />
                    {f.label}
                    <span className="text-xs text-fg-subtle tabular">{f.dims}</span>
                  </button>
                ))}
              </div>
            </Group>

            <Group label="Theme">
              <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-2">
                {THEMES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="radio"
                    aria-checked={theme === t.key}
                    onClick={() => setTheme(t.key)}
                    className={cn(
                      "flex items-center gap-2 rounded-full py-1.5 pr-3.5 pl-1.5 text-sm ring-1 ring-inset transition-colors duration-[var(--dur-1)]",
                      theme === t.key ? "bg-(--area-wash) font-medium ring-(--area-fill)" : "ring-line hover:bg-hover"
                    )}
                  >
                    <span aria-hidden className={cn("grid size-6 place-items-center rounded-full", t.swatch)}>
                      {theme === t.key && <Check className="size-3.5 text-[#e0a82e]" strokeWidth={3} />}
                    </span>
                    {t.label}
                  </button>
                ))}
              </div>
            </Group>

            {data.headlines.length > 0 && (
              <Group label="Pick your headline">
                <div role="radiogroup" aria-label="Pick your headline" className="space-y-2">
                  {data.headlines.map((h) => (
                    <button
                      key={h.key}
                      type="button"
                      role="radio"
                      aria-checked={chosen === h.key}
                      onClick={() => setHeadline(h.key)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ring-1 ring-inset transition-colors duration-[var(--dur-1)]",
                        chosen === h.key ? "bg-(--area-wash) ring-(--area-fill)" : "ring-line hover:bg-hover"
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded-full ring-1 ring-inset",
                          chosen === h.key ? "ring-(--area-fill)" : "ring-field"
                        )}
                      >
                        {chosen === h.key && <span className="size-2 rounded-full bg-(--area-fill)" />}
                      </span>
                      <span className="text-honour shrink-0 font-semibold text-(--area)" style={{ fontFamily: "var(--font-honour)", fontSize: 22 }}>
                        {h.big}
                      </span>
                      <span className="min-w-0 text-sm text-fg-muted">{h.label}</span>
                    </button>
                  ))}
                </div>
              </Group>
            )}

            <Group label="Show">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                <Checkbox checked={show.photo} onCheckedChange={(v) => setShow({ ...show, photo: v === true })} label="Photo" />
                <Checkbox checked={show.strip} onCheckedChange={(v) => setShow({ ...show, strip: v === true })} label="Record strip" />
                <Checkbox checked={show.qr} onCheckedChange={(v) => setShow({ ...show, qr: v === true })} label="QR code" />
                <Checkbox checked={show.quote} onCheckedChange={(v) => setShow({ ...show, quote: v === true })} label="What you write about" />
              </div>
              {show.qr && !data.share.enabled && (
                <p className="mt-2 text-xs text-fg-muted">The QR code appears once your public link is on.</p>
              )}
            </Group>

            <div className="flex flex-wrap gap-2">
              <Button asChild kind="primary">
                <a href={src} download={fileName}>
                  <Download />
                  Download PNG
                </a>
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button>
                    <Share2 />
                    Share
                  </Button>
                </MenuTrigger>
                <MenuContent align="start">
                  {canNative && (
                    <MenuItem
                      onSelect={() =>
                        void nativeShare().then((ok) => {
                          if (!ok) toast.fail("This browser cannot share the picture; use a link below.")
                        })
                      }
                    >
                      Share the picture…
                    </MenuItem>
                  )}
                  {SHARE_TARGETS.map((t) => (
                    <MenuItem key={t.key} onSelect={() => withLink((u) => window.open(t.href(u, shareText), "_blank", "noopener"))}>
                      {t.label}
                    </MenuItem>
                  ))}
                  <MenuItem
                    onSelect={() =>
                      withLink((u) => void navigator.clipboard?.writeText(u).then(() => toast.ok("Link copied")))
                    }
                  >
                    Copy link
                  </MenuItem>
                </MenuContent>
              </Menu>
            </div>

            <Group label="Public link">
              <Switch
                checked={data.share.enabled}
                disabled={share.isPending || Boolean(me?.impersonated_by)}
                onCheckedChange={(on) => void setShared(on)}
                label="Share my card by link"
                hint="Anyone with the link sees this card and a 'Verified by Saveetha' line. Turn it off and the link stops working at once."
              />
              {shareUrl && (
                <p className="well mt-3 flex min-w-0 items-center gap-2 px-3 py-2 text-sm">
                  <Link2 className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                  <a href={shareUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate text-accent hover:underline">
                    {shareUrl}
                  </a>
                  <CopyButton value={shareUrl} label="the link" />
                </p>
              )}
            </Group>

            <Meta>
              Counted from your publication record, the same count as Home and My research
              {data.citations != null && data.citations > 0 && (
                <>
                  {" "}
                  · <Chip tone="gold" area="honours">{data.citations.toLocaleString("en-IN")} citations</Chip>
                </>
              )}
            </Meta>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={pending != null}
        onOpenChange={(open) => !open && setPending(null)}
        title="Turn on your public link?"
        description="Anyone with it sees this card — nothing else."
        confirmLabel="Turn on and share"
        onConfirm={async () => {
          const go = pending
          const state = await setShared(true)
          setPending(null)
          if (state?.path && go) go(`${window.location.origin}${state.path}`)
        }}
      />
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <SectionTitle>{label}</SectionTitle>
      {children}
    </div>
  )
}

/**
 * The card itself, at its true aspect ratio, sliding up once on first view
 * (docs/ux/00 §5). A new choice keeps the last picture on screen, dimmed,
 * until the new one has loaded, so the card never blinks out.
 */
function CardPreview({ src, format, name }: { src: string; format: (typeof FORMATS)[number]; name: string }) {
  const reduce = useReducedMotion()
  const [shown, setShown] = useState(src)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (src === shown) return
    setLoading(true)
    const img = new Image()
    img.onload = () => {
      setShown(src)
      setLoading(false)
    }
    img.onerror = () => setLoading(false)
    img.src = src
  }, [src, shown])
  const shownFormat = useMemo(() => {
    const k = new URLSearchParams(shown.split("?")[1]).get("format")
    return FORMATS.find((f) => f.key === k) ?? format
  }, [shown, format])
  const tall = shownFormat.h > shownFormat.w
  return (
    <motion.figure
      initial={reduce ? false : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="mx-auto"
      style={{ maxWidth: tall ? `${Math.round((560 * shownFormat.w) / shownFormat.h)}px` : "100%" }}
    >
      <img
        src={shown}
        alt={`${name}'s impact card, ${shownFormat.label} format, ${shownFormat.dims}`}
        width={shownFormat.w}
        height={shownFormat.h}
        className={cn(
          "block h-auto w-full rounded-lg shadow-[0_18px_40px_-12px_rgb(20_27_78/0.45),0_4px_10px_-4px_rgb(20_27_78/0.3)] transition-opacity duration-[var(--dur-2)]",
          loading && "opacity-60"
        )}
      />
      <figcaption className="mt-3 text-center text-xs text-fg-muted">
        {shownFormat.label} · {shownFormat.dims} · the same picture you download
      </figcaption>
    </motion.figure>
  )
}
