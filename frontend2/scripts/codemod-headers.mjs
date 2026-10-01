// One-off codemod: calm page headers with a spot illustration.
import fs from "node:fs"
const dir = new URL("../src/pages/", import.meta.url)
const jobs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
for (const [file, title, spot] of jobs) {
  const url = new URL(file, dir)
  let s = fs.readFileSync(url, "utf8")
  const t = s.indexOf(`<PageTitle${title}`)
  if (t < 0) { console.error("NO TITLE", file, title); continue }
  const h = s.lastIndexOf("<header", t)
  const e = s.indexOf("</header>", t)
  if (h < 0 || e < 0) { console.error("NO HEADER", file, title); continue }
  const open = s.slice(h, s.indexOf(">", h) + 1)
  const indent = s.slice(s.lastIndexOf("\n", e) + 1, e)
  let body = s.slice(h + open.length, e)
  let out
  if (open === "<header>" || !open.includes("justify-between")) {
    out = `<header className="page-head">\n${indent}  <div>${body.replace(/\s+$/, "")}\n${indent}  </div>\n${indent}  <HeaderSpot name="${spot}" />\n${indent}</header>`
  } else {
    out = `<header className="page-head">${body.replace(/\s+$/, "")}\n${indent}  <HeaderSpot name="${spot}" />\n${indent}</header>`
  }
  s = s.slice(0, h) + out + s.slice(e + "</header>".length)
  if (!s.includes('from "@/ui/page-header"')) {
    const lastImport = s.lastIndexOf("\nimport ")
    const end = s.indexOf("\n", s.indexOf(" from ", lastImport) )
    s = s.slice(0, end + 1) + 'import { HeaderSpot } from "@/ui/page-header"\n' + s.slice(end + 1)
  }
  fs.writeFileSync(url, s)
  console.log("ok", file, title, open)
}
