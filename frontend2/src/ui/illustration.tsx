import { cn } from "@/lib/cn"
import { ILLUSTRATIONS, type IllustrationName } from "@/ui/illustration-index"

export type { IllustrationName }

const BASE = "/illustrations/generated/"

/**
 * One of the generated illustrations (public/illustrations/generated,
 * manifest.json; index built by scripts/gen-illustration-index.mjs).
 *
 * Lazy, WebP with a PNG fallback, and width/height set from the asset's own
 * size so nothing shifts while it loads. Decorative by default (the heading
 * beside it carries the meaning); pass `alt` to make it content.
 *
 * Some drawings keep a cream fill inside closed shapes, so in dark mode they
 * sit on a light plate (docs/ux/ASSETS.md); in light mode the plate is
 * invisible against the canvas. Illustrations support, never dominate: keep
 * `width` small.
 */
export function Illustration({
  name,
  width = 160,
  alt,
  className,
  plate = true,
  eager = false,
}: {
  name: IllustrationName
  /** Rendered width in px; height follows the asset's aspect ratio. */
  width?: number
  alt?: string
  className?: string
  /** Light plate behind the art in dark mode. */
  plate?: boolean
  eager?: boolean
}) {
  const meta = ILLUSTRATIONS[name]
  if (!meta) return null
  const height = Math.round((width * meta.h) / meta.w)
  return (
    <picture
      className={cn(
        "inline-block shrink-0 select-none",
        plate && "dark:rounded-2xl dark:bg-[#f5f0e8] dark:p-2",
        className
      )}
      data-illustration={name}
    >
      <source srcSet={`${BASE}${name}.webp`} type="image/webp" />
      <img
        src={`${BASE}${name}.png`}
        width={width}
        height={height}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        alt={alt ?? ""}
        aria-hidden={alt ? undefined : true}
        className="block h-auto max-w-full"
        style={{ width }}
      />
    </picture>
  )
}

/**
 * One of the 60 generated spot icons, masked so its ink takes `currentColor`
 * and themes with the text around it. For spot moments (a stat, an empty
 * row, a card lead) — not UI chrome, where Lucide stays.
 */
export function SpotIcon({
  name,
  size = 24,
  label,
  className,
}: {
  name: Extract<IllustrationName, `icon-${string}`>
  size?: number
  label?: string
  className?: string
}) {
  const url = `url(${BASE}${name}.svg)`
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-spot-icon={name}
      className={cn("inline-block shrink-0 bg-current align-middle", className)}
      style={{
        width: size,
        height: size,
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  )
}

/** The illustration for a department code, when there is one. */
const DEPT: Record<string, IllustrationName> = {
  CSE: "dept-cse", ECE: "dept-ece", EEE: "dept-eee", MECH: "dept-mech", AUTO: "dept-auto",
  IT: "dept-it", CIVIL: "dept-civil", AIDS: "dept-aids", "AI&DS": "dept-aids", AIML: "dept-aiml",
  "AI&ML": "dept-aiml", BME: "dept-bme", AGRI: "dept-agri", MBA: "dept-mba", ENGLISH: "dept-sh-english",
  CHEMISTRY: "dept-sh-chemistry", PHYSICS: "dept-sh-physics", MATHS: "dept-sh-maths",
  MATHEMATICS: "dept-sh-maths", "S&H": "dept-interdisciplinary",
}
export function departmentArt(code: string | null | undefined): IllustrationName {
  const k = (code ?? "").trim().toUpperCase().replace(/\s+/g, "")
  return DEPT[k] ?? "dept-interdisciplinary"
}

/** The illustration for a research topic, matched on keywords; null when none fits. */
const TOPICS: [RegExp, IllustrationName][] = [
  [/deep learning|neural/i, "topic-deep-learning"],
  [/machine learning|artificial intelligence|\bai\b/i, "topic-machine-learning"],
  [/vision|image processing/i, "topic-computer-vision"],
  [/natural language|\bnlp\b|text mining/i, "topic-nlp"],
  [/internet of things|\biot\b/i, "topic-iot"],
  [/security|cyber|cryptograph/i, "topic-cybersecurity"],
  [/blockchain/i, "topic-blockchain"],
  [/cloud/i, "topic-cloud-computing"],
  [/edge|fog/i, "topic-edge-computing"],
  [/big data|data mining|data science|database/i, "topic-big-data"],
  [/solar|photovoltaic/i, "topic-solar-energy"],
  [/wind/i, "topic-wind-energy"],
  [/power electronic|converter|inverter/i, "topic-power-electronics"],
  [/electric vehicle|\bev\b|battery/i, "topic-electric-vehicles"],
  [/smart grid|power system|energy/i, "topic-smart-grid"],
  [/wireless|5g|communication/i, "topic-wireless-5g"],
  [/antenna|microwave|electromagnetic/i, "topic-antennas"],
  [/vlsi|semiconductor|circuit/i, "topic-vlsi"],
  [/embedded|microcontroller/i, "topic-embedded-systems"],
  [/robot/i, "topic-robotics"],
  [/control/i, "topic-control-systems"],
  [/signal/i, "topic-signal-processing"],
  [/biomedical|medical imag/i, "topic-biomedical-imaging"],
  [/health|medicine|clinical/i, "topic-healthcare-ai"],
  [/biomaterial|tissue/i, "topic-biomaterials"],
  [/nano/i, "topic-nanomaterials"],
  [/composite|materials/i, "topic-composites"],
  [/heat|thermal/i, "topic-heat-transfer"],
  [/fluid|\bcfd\b/i, "topic-cfd"],
  [/additive|3d print|manufactur/i, "topic-additive-manufacturing"],
  [/structur/i, "topic-structural"],
  [/concrete|cement/i, "topic-concrete"],
  [/water|hydro/i, "topic-water-resources"],
  [/environment|pollution|sustainab/i, "topic-environmental"],
  [/transport|traffic/i, "topic-transportation"],
  [/agri|crop/i, "topic-precision-agriculture"],
  [/optimi[sz]|operations research/i, "topic-optimisation"],
  [/quantum/i, "topic-quantum-computing"],
  [/network/i, "topic-computer-networks"],
  [/education|learning analytics/i, "topic-edtech"],
  [/food/i, "topic-food-technology"],
  [/industry 4|industrial/i, "topic-industry-4"],
]
export function topicArt(topic: string | null | undefined): IllustrationName | null {
  if (!topic) return null
  for (const [re, name] of TOPICS) if (re.test(topic)) return name
  return null
}
