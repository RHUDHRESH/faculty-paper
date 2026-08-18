"""How much money does the column shift in Master_List_Accounts move?

The newest block of rows carries six extra columns and the payout is the last
of them; the column headed "Amount" holds the author count for those rows.
Reading the header at face value prices a Rs 200 payment at Rs 6.
"""
import openpyxl

PATH = r"data\Publication_Processing_ERP_V3.0.xlsx"
wb = openpyxl.load_workbook(PATH, read_only=True, data_only=True)
ws = wb["Master_List_Accounts"]
it = ws.iter_rows(values_only=True)
hdr = [str(h).strip() if h is not None else f"col{i}" for i, h in enumerate(next(it))]
AMOUNT = hdr.index("Amount")
# col23 = author-position points, col25 = QF, col26 = (SNIP x 55000) + QF,
# col27 = the payout. The column headed 'Amount' holds the author count here.
APP, QF, BASE, REAL = 23, 25, 26, 27


def f(v):
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


naive = shifted = 0.0
n_shift = 0
consistent = 0
examples = []
for r in it:
    if not any(v is not None and str(v).strip() for v in r):
        continue
    a = f(r[AMOUNT]) or 0.0
    naive += a
    real = f(r[REAL]) if len(r) > REAL else None
    if real is not None:
        n_shift += 1
        shifted += real
        base, app = f(r[BASE]), f(r[APP])
        if base is not None and app is not None and abs(base * app - real) < 0.01:
            consistent += 1
        if len(examples) < 5:
            examples.append((a, base, app, real))
    else:
        shifted += a

print(f"rows with the extra columns   {n_shift}")
print(f"  of those, (SNIP*55000+QF) x APP == payout  {consistent}/{n_shift}")
print()
print(f"total reading the Amount header   {naive:,.2f}")
print(f"total using the real payout       {shifted:,.2f}")
print(f"difference                        {shifted - naive:,.2f}")
print()
print("  header-Amount |    base |   APP | real payout")
for a, base, app, real in examples:
    print(f"  {a:>13} | {base:>7} | {app:>5} | {real:>11}")
