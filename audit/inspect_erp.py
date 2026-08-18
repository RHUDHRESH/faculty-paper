"""Ground truth about the ERP workbook: what each sheet holds and how complete it is.

Nothing here interprets or assumes -- it reports headers, row counts, fill rates
and samples so the import can be written against what the file actually contains.
"""
import sys
from collections import Counter

import openpyxl

PATH = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\SEC\Downloads\Publication_Processing_ERP_V3.0.xlsx"
ONLY = sys.argv[2] if len(sys.argv) > 2 else None

wb = openpyxl.load_workbook(PATH, read_only=True, data_only=True)

for ws in wb.worksheets:
    if ONLY and ws.title != ONLY:
        continue
    rows = ws.iter_rows(values_only=True)
    try:
        header = next(rows)
    except StopIteration:
        print(f"\n=== {ws.title} === (empty)")
        continue
    header = [str(h).strip() if h is not None else f"<col{i}>" for i, h in enumerate(header)]

    filled = Counter()
    total = 0
    samples: dict[str, list] = {h: [] for h in header}
    for r in rows:
        total += 1
        for h, v in zip(header, r):
            if v is not None and str(v).strip() != "":
                filled[h] += 1
                if len(samples[h]) < 3:
                    samples[h].append(v)

    print(f"\n=== {ws.title} ===  {total} data rows, {len(header)} columns")
    for h in header:
        pct = (filled[h] / total * 100) if total else 0
        ex = " | ".join(str(s)[:38] for s in samples[h][:2])
        print(f"  {h[:38]:<40} {filled[h]:>6}/{total} ({pct:5.1f}%)  {ex[:78]}")
