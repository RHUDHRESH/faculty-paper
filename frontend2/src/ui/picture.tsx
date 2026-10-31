/** Decorative illustration: the minimalist skin renders nothing. Kept so imports compile. */
export function Picture(_props: { name: string; alt?: string; className?: string; eager?: boolean }) {
  return null
}

/** Topic picture for a paper, guessed from its title and journal; null when nothing fits. */
const TOPICS: [RegExp, string][] = [
  [/solar|photovolt|\bpv\b/i, "topic-solar-energy"],
  [/wind/i, "topic-wind-energy"],
  [/smart grid|microgrid|demand response|distribution system|capacitor placement|power flow|power quality|upqc|dstatcom|facts/i, "topic-smart-grid"],
  [/electric vehicle|\bev\b|battery|charging/i, "topic-electric-vehicles"],
  [/converter|inverter|power electronic|dfig|reluctance motor|motor drive/i, "topic-power-electronics"],
  [/deep learning|neural|cnn|lstm|transformer/i, "topic-deep-learning"],
  [/machine learning|ensemble|random forest|svm|classif|predict/i, "topic-machine-learning"],
  [/image|imaging|vision|ct\b|mri|tumou?r/i, "topic-biomedical-imaging"],
  [/eeg|ecg|epilep|biomedical|patient|covid|health|pneumonia/i, "topic-healthcare-ai"],
  [/iot|internet of things|smart parking|sensor network/i, "topic-iot"],
  [/lora|wireless|5g|antenna/i, "topic-wireless-5g"],
  [/fuzzy|control|pid|stability/i, "topic-control-systems"],
  [/swarm|optimi[sz]/i, "topic-optimisation"],
  [/groundwater|water|hydro|desalination/i, "topic-water-resources"],
  [/glass|ceramic|lumines|nano|crystal|dihydrate|photonic/i, "topic-nanomaterials"],
  [/concrete|cement|structural|beam|pile|soil/i, "topic-structural"],
  [/composite/i, "topic-composites"],
  [/biogas|fuel cell|environment|pollut/i, "topic-environmental"],
  [/vlsi|cmos|fpga|circuit design/i, "topic-vlsi"],
  [/embedded|microcontroller|arduino/i, "topic-embedded-systems"],
  [/robot/i, "topic-robotics"],
  [/cloud/i, "topic-cloud-computing"],
  [/edge computing|fog/i, "topic-edge-computing"],
  [/blockchain/i, "topic-blockchain"],
  [/security|cyber|intrusion|malware/i, "topic-cybersecurity"],
  [/signal|filter|fourier|wavelet/i, "topic-signal-processing"],
  [/heat transfer|thermal/i, "topic-heat-transfer"],
  [/traffic|transport|vehicle routing/i, "topic-transportation"],
  [/street light|urban|smart city/i, "topic-industry-4"],
  [/agri|crop|farm/i, "topic-precision-agriculture"],
  [/language|nlp|text mining|sentiment/i, "topic-nlp"],
]

export function topicPicture(...text: (string | null | undefined)[]): string | null {
  const s = text.filter(Boolean).join(" ")
  for (const [re, name] of TOPICS) if (re.test(s)) return name
  return null
}
