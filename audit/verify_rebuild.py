"""Does the app now report what the workbook says?"""
import os
import sys

import django

sys.path.insert(0, r"C:\Users\SEC\publication software\backend")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from django.db.models import Count, Min, Max, Sum  # noqa: E402
from django.test import Client  # noqa: E402

from core.models import Claim, ClaimStatus, PaidLedger, Role, User  # noqa: E402

WORKBOOK_TOTAL = 27_596_006.98  # the payout column, not the mislabelled header
WORKBOOK_PAID_ROWS = 3137
WORKBOOK_SUBMISSIONS = 89

print("=== database ===")
paid = Claim.objects.filter(status=ClaimStatus.PAID)
print(f"  paid claims        {paid.count()} (workbook {WORKBOOK_PAID_ROWS})")
total = paid.aggregate(t=Sum("remuneration"))["t"] or 0
print(f"  paid total         {total:,.2f} (workbook {WORKBOOK_TOTAL:,.2f})")
print(f"  ledger total       {PaidLedger.objects.aggregate(t=Sum('amount'))['t'] or 0:,.2f}")
sub = Claim.objects.filter(status=ClaimStatus.SUBMITTED)
print(f"  awaiting review    {sub.count()} (workbook {WORKBOOK_SUBMISSIONS})")
print(f"  faculty accounts   {User.objects.filter(role=Role.FACULTY).count()}")
print(f"  active logins      {User.objects.filter(role=Role.FACULTY, active=True).count()}")

print("\n=== the exact time things happened ===")
d = paid.exclude(publication_date__isnull=True).aggregate(lo=Min('publication_date'), hi=Max('publication_date'))
print(f"  published between  {d['lo']} .. {d['hi']}")
print(f"  paid claims with a publication date  "
      f"{paid.exclude(publication_date__isnull=True).count()}/{paid.count()}")
s = sub.aggregate(lo=Min("created_at"), hi=Max("created_at"))
print(f"  submissions filed  {s['lo']} .. {s['hi']}")
print(f"  submissions with the real filing time "
      f"{sub.exclude(submitted_at__isnull=True).count()}/{sub.count()}")

print("\n=== what the dashboard and reports now say ===")
admin = User.objects.filter(role=Role.SUPER_ADMIN, active=True).first()
c = Client(SERVER_NAME="localhost")
c.force_login(admin)
dash = c.get("/api/dashboard").json()
print(f"  dashboard total_paid   {dash['total_paid']:,.2f}")
print(f"  dashboard by_status    PAID={dash['by_status']['PAID']} "
      f"SUBMITTED={dash['by_status']['SUBMITTED']}")

rep = c.get("/api/reports").json()
print(f"  reports keys: {sorted(rep)[:12]}")
print(f"  reports publications   {rep.get('publications')}")
print("\n  by month (most recent 6):")
for m in (rep.get("by_month") or [])[:6]:
    print(f"    {m['key']}  {m['count']:>4} claims  {m['amount']:>14,.2f}")
print("\n  top departments:")
for d_ in (rep.get("by_department") or [])[:6]:
    print(f"    {d_['key']:<16} {d_['count']:>4}  {d_['amount']:>14,.2f}")
print("\n  quartiles:")
for q in (rep.get("by_quartile") or [])[:8]:
    print(f"    {q['key']:<16} {q['count']:>4}  {q['amount']:>14,.2f}")

drift = abs(float(dash["total_paid"]) - WORKBOOK_TOTAL)
print(f"\n  dashboard vs workbook drift: {drift:,.2f}")
print("  " + ("MATCHES" if drift < 0.01 else "MISMATCH"))
