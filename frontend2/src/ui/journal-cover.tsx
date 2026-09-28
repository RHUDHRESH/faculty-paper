import { cn } from "@/lib/cn"

/**
 * A journal's visual: a small typographic "cover" drawn from its title,
 * publisher and quartile. Deterministic -- the same journal always looks the
 * same -- and made here, so no publisher's cover art is copied. The band
 * colour says the quartile (Q1 gold, Q2 teal, Q3 slate, Q4 stone).
 */

const QUARTILE_BAND: Record<string, string> = {
  Q1: "#b8860b",
  Q2: "#0f766e",
  Q3: "#475569",
  Q4: "#78716c",
}

/** Muted hues a cover body is drawn in; picked by a hash of the title. */
const HUES = [212, 262, 330, 18, 152, 188, 236, 292, 40, 96]

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const SMALL = new Set(["of", "and", "the", "in", "on", "for", "&", "a", "an", "to", "de", "la"])

/** "IEEE Transactions on Neural Networks" -> "TNN"; short titles stay as words. */
export function monogram(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}&\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
  const acronym = words.find((w) => w.length >= 2 && w.length <= 6 && w === w.toUpperCase() && /[A-Z]/.test(w))
  const initials = words.filter((w) => !SMALL.has(w.toLowerCase())).map((w) => w[0]!.toUpperCase())
  if (acronym && initials.length > 3) return acronym.slice(0, 5)
  return initials.slice(0, 3).join("") || "J"
}

export function coverColours(title: string, quartile?: string | null) {
  const hue = HUES[hashString(title.toLowerCase()) % HUES.length]!
  return {
    body: `hsl(${hue} 38% 30%)`,
    bodyLight: `hsl(${hue} 34% 40%)`,
    band: (quartile && QUARTILE_BAND[quartile]) || `hsl(${hue} 20% 55%)`,
  }
}

const SIZES = {
  xs: "h-10 w-8 text-[9px]",
  sm: "h-14 w-11 text-[10px]",
  md: "h-20 w-15 text-xs",
  lg: "h-32 w-24 text-sm",
} as const

export function JournalCover({
  title,
  publisher,
  quartile,
  size = "sm",
  className,
}: {
  title: string
  publisher?: string | null
  quartile?: string | null
  size?: keyof typeof SIZES
  className?: string
}) {
  const c = coverColours(title, quartile)
  const mark = monogram(title)
  const showPublisher = size === "lg" || size === "md"
  return (
    <div
      role="img"
      aria-label={`${title}${quartile ? `, ${quartile}` : ""}`}
      title={title}
      data-testid="journal-cover"
      className={cn(
        "relative flex shrink-0 select-none flex-col overflow-hidden rounded-[3px] font-semibold text-white shadow-raise",
        SIZES[size],
        className
      )}
      style={{ background: `linear-gradient(160deg, ${c.bodyLight}, ${c.body})` }}
    >
      <span aria-hidden className="h-[14%] w-full" style={{ background: c.band }} />
      <span aria-hidden className="flex flex-1 items-center justify-center px-0.5 font-serif tracking-wide">
        {mark}
      </span>
      {showPublisher && publisher && (
        <span aria-hidden className="truncate px-1 pb-1 text-center text-[8px] font-normal opacity-80">
          {publisher}
        </span>
      )}
      {quartile && (size === "md" || size === "lg") && (
        <span aria-hidden className="absolute right-0.5 top-[16%] rounded-sm bg-black/25 px-0.5 text-[8px]">
          {quartile}
        </span>
      )}
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-black/20" />
    </div>
  )
}
