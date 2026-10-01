/**
 * The name to greet somebody by.
 *
 * College records put initials first ("Dr. R. Subhashini", "Mr.V. Balasundaram")
 * or last ("Srigitha S"), so the first word is often a lone initial. Titles
 * and initials are skipped; the first real word wins. A name made only of
 * initials falls back to its first one rather than to nothing.
 */
export function firstName(full: string | null | undefined): string {
  const words = (full || "")
    .replace(/\b(Dr|Mr|Ms|Mrs|Miss|Prof|Er)\b\.?/gi, " ")
    .split(/[\s.,]+/)
    .filter(Boolean)
  return words.find((w) => w.replace(/[^\p{L}]/gu, "").length > 2) || words[0] || ""
}

/**
 * A paper's title for display. Imported rows carry placeholders such as "-",
 * "NA" or "nil" where the spreadsheet had nothing; those read as "Untitled".
 */
export function paperTitle(title: string | null | undefined): string {
  const t = (title || "").trim()
  return !t || /^[-–—.\s]*$|^(n\/?a|nil|null|none|tbd)$/i.test(t) ? "Untitled" : unshout(t)
}

/** Short forms that stay in capitals when a shouted title is brought down. */
const KEEP_UPPER = new Set(
  (
    "AI ML DL IOT IOMT IEEE CNN RNN LSTM SVM GPS RFID VLSI MIMO OFDM FPGA WSN DNA RNA PV CFD FEM UAV EEG ECG MRI " +
    "NLP GAN BERT SDN LORA MATLAB VANET MANET GSM LTE QOS SNR BER MPPT HVAC CAD CAM FSS SQL XML API CMOS MEMS NOMA " +
    "SAR GIS COVID HIV AIDS USA UK EU IT IC GD ERP CRM ISO NAAC NIRF 5G 4G 6G 3D 2D"
  ).split(" ")
)

/**
 * Some imported titles were typed in capitals ("THE IMPACT OF GROUP
 * DISCUSSION TASKS"). A page of those shouts, so a title with no lower-case
 * letter is shown in sentence case, keeping the short forms people know.
 */
export function unshout(text: string | null | undefined): string {
  if (!text) return ""
  const letters = text.replace(/[^A-Za-z]/g, "")
  if (letters.length < 12 || /[a-z]/.test(text)) return text
  const low = text
    .toLowerCase()
    .replace(/[a-z0-9][a-z0-9-]*/g, (w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w))
  return low.charAt(0).toUpperCase() + low.slice(1)
}
