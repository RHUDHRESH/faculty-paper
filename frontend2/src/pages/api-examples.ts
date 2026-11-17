/**
 * Copy-ready examples for the API docs page.
 *
 * Plain strings built from the endpoint's path and the site's own address, so
 * what a reader pastes is what works. The token in them is always the
 * placeholder, never a real secret.
 */

export const TOKEN_PLACEHOLDER = "YOUR_TOKEN"

export type ExampleKind = "curl" | "python" | "excel" | "sheets"

export const EXAMPLE_LABEL: Record<ExampleKind, string> = {
  curl: "curl",
  python: "Python",
  excel: "Excel Power Query",
  sheets: "Google Sheets",
}

export type Examples = Record<ExampleKind, string>

export function buildExamples({
  origin,
  path,
  params = {},
}: {
  origin: string
  path: string
  params?: Record<string, string>
}): Examples {
  const url = `${origin}${path}`
  const query = (extra: Record<string, string>) => {
    const all = { ...params, ...extra }
    const text = Object.entries(all)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&")
    return text ? `?${text}` : ""
  }
  const paramLines = (extra: Record<string, string>) =>
    Object.entries({ ...params, ...extra })
      .map(([k, v]) => `${k}="${v}"`)
      .join(", ")

  const curl = [
    `curl -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" \\`,
    `  "${url}${query({})}"`,
    ``,
    `# A spreadsheet file instead of JSON`,
    `curl -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" \\`,
    `  -o ${path.split("/").pop()}.xlsx \\`,
    `  "${url}${query({ format: "xlsx" })}"`,
  ].join("\n")

  const python = [
    `import requests`,
    ``,
    `URL = "${url}"`,
    `HEADERS = {"Authorization": "Bearer ${TOKEN_PLACEHOLDER}"}`,
    `PARAMS = ${pyDict({ ...params, page_size: "1000" })}`,
    ``,
    `rows = []`,
    `while URL:`,
    `    r = requests.get(URL, headers=HEADERS, params=PARAMS)`,
    `    r.raise_for_status()`,
    `    body = r.json()`,
    `    rows += body["data"]`,
    `    URL, PARAMS = body["next"], None  # "next" already carries the query`,
    ``,
    `print(len(rows), "rows")`,
  ].join("\n")

  const excel = [
    `let`,
    `    Source = Csv.Document(`,
    `        Web.Contents(`,
    `            "${url}",`,
    `            [`,
    `                Query = [${paramLines({ format: "csv", page_size: "1000" })}],`,
    `                Headers = [Authorization = "Bearer ${TOKEN_PLACEHOLDER}"]`,
    `            ]`,
    `        ),`,
    `        [Delimiter = ",", Encoding = 65001]`,
    `    ),`,
    `    Table = Table.PromoteHeaders(Source, [PromoteAllScalars = true])`,
    `in`,
    `    Table`,
  ].join("\n")

  const sheets = [
    `function importData() {`,
    `  const url = "${url}${query({ format: "csv", page_size: "1000" })}";`,
    `  const response = UrlFetchApp.fetch(url, {`,
    `    headers: { Authorization: "Bearer ${TOKEN_PLACEHOLDER}" },`,
    `  });`,
    `  // The file starts with a byte-order mark that Excel wants and Sheets does not.`,
    `  const rows = Utilities.parseCsv(response.getContentText().replace(/^\\uFEFF/, ""));`,
    `  const sheet = SpreadsheetApp.getActiveSheet();`,
    `  sheet.clear();`,
    `  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);`,
    `}`,
  ].join("\n")

  return { curl, python, excel, sheets }
}

function pyDict(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([k, v]) => `"${k}": "${v}"`)
    .join(", ")}}`
}
