import { apiFile } from "@/lib/api"

/**
 * Download a table as a file, or print it. The one path every list's Export
 * menu takes, so a spreadsheet from one screen and a spreadsheet from another
 * have the same columns, the same numbers and the same file name rules.
 *
 * Without this, each page wrote its own CSV with its own quoting, and a
 * money column came out formatted in one file and bare in the next.
 */

export type ExportFormat = "xlsx" | "pdf" | "csv"
export type ExportKind = "text" | "number" | "money" | "date"
export type ExportColumn = { key: string; label: string; kind: ExportKind | null }
export type ExportCell = string | number | boolean | null
export type TableExport = {
  title: string
  subtitle?: string
  format: ExportFormat
  /** A base name; the server adds the extension and may choose its own. */
  filename: string
  columns: ExportColumn[]
  rows: ExportCell[][]
}

/**
 * Posts the table to the server and saves the file it sends back. Throws a
 * readable Error when the server refuses (the toolbar turns that into a toast).
 */
export async function exportTable(req: TableExport): Promise<string> {
  const { blob, filename } = await apiFile("/api/export/table", {
    title: req.title,
    subtitle: req.subtitle ?? "",
    format: req.format,
    filename: req.filename,
    columns: req.columns,
    rows: req.rows,
  })
  const name = filename || `${req.filename}.${req.format}`
  saveBlob(blob, name)
  return name
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * Prints the page. The `print:` rules in styles.css hide the toolbar and the
 * app chrome and keep grid lines, so this is the print view itself.
 * `window.print()` blocks until the dialog closes in the browsers this app
 * supports, so the title is put back straight after it.
 */
export function printTable(title?: string): void {
  const before = document.title
  if (title) document.title = title
  try {
    window.print()
  } finally {
    document.title = before
  }
}
