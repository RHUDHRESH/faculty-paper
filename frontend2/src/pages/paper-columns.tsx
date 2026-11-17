import type { Column } from "@/ui/table"

/**
 * The paper's own figures as table columns, the same on every screen that lists
 * payments or claims (the Paid register, the monthly statement).
 *
 * The server works each one out once (`core/services/paper_fields.py`: the
 * claim, then the ledger's sheet row, then the publication record, then the
 * journal tables), so a paper reads the same here, in a file, in the Report
 * studio and in the API. A figure no source has is empty: a quiet dash on the
 * screen, an empty cell in a file. Never a word such as "Not recorded".
 */

/** What `paper_fields` sends for a paper. Every figure may be unknown (null). */
export type PaperFigures = {
  title?: string | null
  journal?: string | null
  issn: string | null
  category: string | null
  quartile: string | null
  snip: number | null
  total_authors: number | null
  author_position: number | null
  doi: string | null
  document_type: string | null
  indexing: string | null
  remark: string | null
  academic_year?: string | null
}

/** The quiet dash for an unknown figure. */
export const DASH = "–"

/** SNIP to three places without trailing zeros: 0.475, 1.2, 2. */
export function snipText(snip: number | null | undefined): string | null {
  return snip == null ? null : String(Number(snip.toFixed(3)))
}

export type PaperColumns<T> = {
  journal: Column<T>
  issn: Column<T>
  category: Column<T>
  quartile: Column<T>
  snip: Column<T>
  totalAuthors: Column<T>
  authorPosition: Column<T>
  academicYear: Column<T>
  doi: Column<T>
  documentType: Column<T>
  indexing: Column<T>
  remark: Column<T>
}

/**
 * The columns, in the owner's order: journal name, ISSN, category, quartile,
 * SNIP, total number of authors, author position shown by default; academic
 * year, DOI, document type, indexing and remark one click away in the
 * Columns menu (and in the file once shown).
 */
export function paperColumns<T>(
  figures: (row: T) => PaperFigures | null | undefined,
  journal: (row: T) => string | null | undefined
): PaperColumns<T> {
  const text = (header: string, key: string, pick: (f: PaperFigures) => string | null | undefined, extra: Partial<Column<T>> = {}): Column<T> => {
    const value = (r: T) => {
      const f = figures(r)
      return f ? (pick(f) ?? null) : null
    }
    return { key, header, empty: DASH, exportValue: value, cell: value, ...extra }
  }
  const number = (header: string, key: string, pick: (f: PaperFigures) => number | null | undefined, show: (n: number) => string): Column<T> => {
    const value = (r: T) => {
      const f = figures(r)
      return f ? (pick(f) ?? null) : null
    }
    return {
      key,
      header,
      align: "right",
      empty: DASH,
      exportKind: "number",
      exportValue: value,
      cell: (r) => {
        const n = value(r)
        return n == null ? null : show(n)
      },
    }
  }
  return {
    journal: {
      key: "journal",
      header: "Journal name",
      empty: DASH,
      truncate: true,
      exportValue: (r) => figures(r)?.journal ?? journal(r) ?? null,
      cell: (r) => figures(r)?.journal ?? journal(r) ?? null,
    },
    issn: text("ISSN", "issn", (f) => f.issn, { className: "whitespace-nowrap" }),
    category: text("Category (Engineering / Non-engineering)", "category", (f) => f.category),
    quartile: text("Quartile", "quartile", (f) => f.quartile),
    snip: number("SNIP", "snip", (f) => f.snip, (n) => snipText(n) ?? ""),
    totalAuthors: number("Total number of authors", "total_authors", (f) => f.total_authors, String),
    authorPosition: number("Author position", "author_position", (f) => f.author_position, String),
    academicYear: text("Academic year", "academic_year", (f) => f.academic_year, { defaultHidden: true }),
    doi: text("DOI", "doi", (f) => f.doi, { defaultHidden: true, className: "break-all" }),
    documentType: text("Document type", "document_type", (f) => f.document_type, { defaultHidden: true }),
    indexing: text("Indexing (Scopus)", "indexing", (f) => f.indexing, { defaultHidden: true }),
    remark: text("Remark", "remark", (f) => f.remark, { defaultHidden: true }),
  }
}

/**
 * A Total row and an Average row for the end of an exported register: how many
 * rows, and the sum and average of the amount and of the SNIP. The Report
 * studio's own files end the same way.
 */
export function registerTotals<T>(
  rows: T[],
  amount: (r: T) => number | null | undefined,
  snip: (r: T) => number | null | undefined,
  noun = "payments"
): Partial<Record<string, string | number | null>>[] {
  const sum = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === "number")
    return v.length ? { total: v.reduce((a, b) => a + b, 0), avg: v.reduce((a, b) => a + b, 0) / v.length } : null
  }
  const money = sum(rows.map(amount))
  const sn = sum(rows.map(snip))
  const r2 = (n: number) => Math.round(n * 100) / 100
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  return [
    { "*": `Total of ${rows.length} ${rows.length === 1 ? noun.replace(/s$/, "") : noun}`, amount: money ? r2(money.total) : null, snip: sn ? r3(sn.total) : null },
    { "*": "Average", amount: money ? r2(money.avg) : null, snip: sn ? r3(sn.avg) : null },
  ]
}
