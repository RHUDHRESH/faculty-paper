import type { IllustrationName } from "@/ui/illustration-index"

export type { IllustrationName }


/** Decorative illustration: the minimalist skin renders nothing. Kept so imports compile. */
export function Illustration(_props: {
  name: IllustrationName
  width?: number
  alt?: string
  className?: string
  plate?: boolean
  eager?: boolean
}) {
  return null
}

/** Decorative spot icon: renders nothing. */
export function SpotIcon(_props: {
  name: Extract<IllustrationName, `icon-${string}`>
  size?: number
  label?: string
  className?: string
}) {
  return null
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
