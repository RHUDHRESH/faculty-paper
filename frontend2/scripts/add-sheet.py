"""Append a sheet record to generated-art.json.
Usage: add-sheet.py <id> <raw> <variant> <subject> <name|category|purpose|page> ... [--note text]"""
import json, sys, datetime
from pathlib import Path
p = Path(__file__).with_name("generated-art.json")
reg = json.loads(p.read_text(encoding="utf-8"))
args = sys.argv[1:]
note = None
if "--note" in args:
    i = args.index("--note"); note = args[i + 1]; args = args[:i] + args[i + 2:]
sid, raw, variant, subject, *items = args
reg["sheets"] = [s for s in reg["sheets"] if s["id"] != sid]
rec = {"id": sid, "raw": raw, "date": datetime.date.today().isoformat(), "variant": variant, "subject": subject,
       "assets": [dict(zip(["name", "category", "purpose", "page"], it.split("|"))) for it in items]}
if note:
    rec["note"] = note
reg["sheets"].append(rec)
p.write_text(json.dumps(reg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(sid, len(rec["assets"]))
