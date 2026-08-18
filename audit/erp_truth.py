"""The numbers the workbook actually contains, so the app can be checked against them."""
import datetime as dt
import sys
from collections import Counter

import openpyxl

PATH = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\SEC\Downloads\Publication_Processing_ERP_V3.0.xlsx"
wb = openpyxl.load_workbook(PATH, read_only=True, data_only=True)


def sheet(name):
    ws = wb[name]
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h is not None else "" for h in next(rows)]
    for r in rows:
        rec = dict(zip(header, r))
        if any(v is not None and str(v).strip() != "" for v in rec.values()):
            yield rec


def num(v):
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def when(v):
    """Excel dates arrive as datetimes in some rows and as serial numbers in others."""
    if isinstance(v, dt.datetime):
        return v
    n = num(v)
    if n and 20000 < n < 60000:
        return dt.datetime(1899, 12, 30) + dt.timedelta(days=n)
    return None


print("=" * 72)
print("Master_List_Accounts — the historical payment ledger")
print("=" * 72)
rows = list(sheet("Master_List_Accounts"))
amounts = [num(r.get("Amount")) for r in rows]
paid = [a for a in amounts if a is not None]
dates = [when(r.get("Publication Date")) for r in rows]
good_dates = [d for d in dates if d]
print(f"  rows                {len(rows)}")
print(f"  with an Amount      {len(paid)}")
print(f"  total paid          {sum(paid):,.2f}")
print(f"  zero-amount rows    {sum(1 for a in paid if a == 0)}")
print(f"  publication dates   {len(good_dates)} parsed, {len(dates) - len(good_dates)} unparsable")
if good_dates:
    print(f"  date range          {min(good_dates).date()} .. {max(good_dates).date()}")
snips = [num(r.get("SNIP Value")) for r in rows]
print(f"  rows with a SNIP    {sum(1 for s in snips if s is not None)}")
print(f"  quartiles           {dict(Counter(str(r.get('SJR Quartile') or '-').strip() for r in rows).most_common(8))}")
months = Counter()
for r in rows:
    m = when(r.get("Month"))
    if m:
        months[m.strftime("%Y-%m")] += 1
print(f"  months covered      {len(months)}  ({min(months) if months else '-'} .. {max(months) if months else '-'})")

print()
print("=" * 72)
print("Accounts — the current processing batch")
print("=" * 72)
acc = list(sheet("Accounts"))
amt = [num(r.get("Amount")) for r in acc]
amt = [a for a in amt if a is not None]
print(f"  rows                {len(acc)}")
print(f"  total              {sum(amt):,.2f}")
print(f"  rows paying > 0     {sum(1 for a in amt if a > 0)}")
print(f"  rows paying 0       {sum(1 for a in amt if a == 0)}")
app = [num(r.get("Author Position Points")) for r in acc]
print(f"  APP > 0             {sum(1 for a in app if a and a > 0)} of {len(acc)}")

print()
print("=" * 72)
print("Raw_Data — faculty submissions, with the time they were filed")
print("=" * 72)
raw = list(sheet("Raw_Data"))
ts = [r.get("Timestamp") for r in raw]
ts_ok = [t for t in ts if isinstance(t, dt.datetime)]
pub = [when(r.get("Date of Publication")) for r in raw]
pub_ok = [p for p in pub if p]
print(f"  submissions         {len(raw)}")
print(f"  with a timestamp    {len(ts_ok)}")
if ts_ok:
    print(f"  submitted between   {min(ts_ok)} .. {max(ts_ok)}")
print(f"  publication dates   {len(pub_ok)}")
if pub_ok:
    print(f"  published between   {min(pub_ok).date()} .. {max(pub_ok).date()}")
print(f"  distinct emails     {len({str(r.get('Email Address') or '').strip().lower() for r in raw if r.get('Email Address')})}")

print()
print("=" * 72)
print("Faculty_Data — the staff master accounts would be built from")
print("=" * 72)
fac = list(sheet("Faculty_Data"))
emails = [str(r.get("Email ID") or "").strip().lower() for r in fac]
emails = [e for e in emails if "@" in e]
print(f"  rows                {len(fac)}")
print(f"  with an email       {len(emails)}  ({len(set(emails))} distinct)")
print(f"  with a staff id     {sum(1 for r in fac if str(r.get('Staff-ID') or '').strip())}")
print(f"  with a scopus id    {sum(1 for r in fac if str(r.get('Scopus ID') or '').strip())}")
print(f"  departments         {len({str(r.get('Department') or '').strip() for r in fac if r.get('Department')})}")
