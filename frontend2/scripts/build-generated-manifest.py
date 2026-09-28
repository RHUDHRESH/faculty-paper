"""Build public/illustrations/generated/manifest.json and the generated-art
section of docs/ux/ASSETS.md from scripts/generated-art.json."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REG = json.loads((ROOT / "scripts" / "generated-art.json").read_text(encoding="utf-8"))
OUT = ROOT / "public" / "illustrations" / "generated"
DOC = ROOT.parent / "docs" / "ux" / "ASSETS.md"
BEGIN, END = "<!-- generated-art:begin -->", "<!-- generated-art:end -->"

assets = []
missing = []
for sheet in REG["sheets"]:
    for a in sheet["assets"]:
        files = {ext: f"/illustrations/generated/{a['name']}.{ext}"
                 for ext in ("svg", "webp", "png") if (OUT / f"{a['name']}.{ext}").exists()}
        if not files:
            missing.append(a["name"])
            continue
        sizes = {ext: (OUT / f"{a['name']}.{ext}").stat().st_size for ext in files}
        assets.append({**a, "files": files, "bytes": sizes, "sheet": sheet["id"], "date": sheet["date"],
                       "background": "kept (flat #F3EEE6)" if sheet["variant"] == "hero" else "transparent"})

manifest = {
    "source": REG["source"],
    "style": REG["style"],
    "count": len(assets),
    "assets": assets,
}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

lines = [BEGIN, "", "## Generated illustrations: `frontend2/public/illustrations/generated/`", "",
         f"**Source:** {REG['source']}. Original art, no third-party characters, logos or likenesses; "
         "raw downloads are kept outside the repo in `D:/Faculty Paper/data/generated/raw/`. "
         "Machine-readable list: `generated/manifest.json` (name, purpose, files, suggested page). "
         "Pipeline: `frontend2/scripts/process-generated-art.py`; registry: `frontend2/scripts/generated-art.json`.", "",
         "**Shared style block** (prefixed to every prompt):", "", f"> {REG['style']}", ""]
for k, v in REG["variants"].items():
    lines += [f"- *{k} variant:* {v}"]
lines += ["", "**Processing:**", ""]
for k, v in REG["processing"].items():
    lines += [f"- *{k}:* {v}"]
lines += ["", "| Sheet | Date | Prompt (subject) | Assets |", "|---|---|---|---|"]
for s in REG["sheets"]:
    names = ", ".join(f"`{a['name']}`" for a in s["assets"])
    note = f" *{s['note']}*" if s.get("note") else ""
    lines.append(f"| {s['id']} ({s['variant']}) | {s['date']} | {s['subject']}{note} | {names} |")
lines += ["", END]
block = "\n".join(lines)

doc = DOC.read_text(encoding="utf-8")
if BEGIN in doc:
    doc = doc[: doc.index(BEGIN)] + block + doc[doc.index(END) + len(END):]
else:
    doc = doc.rstrip("\n") + "\n\n" + block + "\n"
DOC.write_text(doc, encoding="utf-8")
print(f"{len(assets)} assets in manifest; missing: {missing}")
over = [(a["name"], k, v) for a in assets for k, v in a["bytes"].items() if k != "svg" and v > 150 * 1024]
print("raster over 150KB:", over)
