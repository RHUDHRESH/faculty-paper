"""Why did 267 ledger rows fail to find a faculty account?"""
import os
import sys
from collections import Counter

import django

sys.path.insert(0, r"C:\Users\SEC\publication software\backend")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from core.models import Claim, User  # noqa: E402

holding = User.objects.filter(email="unattributed@saveetha.ac.in").first()
rows = Claim.objects.filter(owner=holding)
print(f"unattributed claims: {rows.count()}")

have_staff = rows.exclude(staff_id__isnull=True).exclude(staff_id="").count()
have_bio = rows.exclude(biometric_id__isnull=True).exclude(biometric_id="").count()
have_scopus = rows.exclude(scopus_author_id__isnull=True).exclude(scopus_author_id="").count()
print(f"  carry a staff id     {have_staff}")
print(f"  carry a biometric id {have_bio}")
print(f"  carry a scopus id    {have_scopus}")

# What identifiers do they carry that the account table does not?
staff_known = set(
    User.objects.exclude(staff_id__isnull=True).exclude(staff_id="")
    .values_list("staff_id", flat=True)
)
bio_known = set(
    User.objects.exclude(biometric_id__isnull=True).exclude(biometric_id="")
    .values_list("biometric_id", flat=True)
)
scopus_known = set(
    User.objects.exclude(scopus_author_id__isnull=True).exclude(scopus_author_id="")
    .values_list("scopus_author_id", flat=True)
)

miss = Counter()
sample = {}
for c in rows.only("staff_id", "biometric_id", "scopus_author_id", "paper_title"):
    reasons = []
    if c.staff_id and c.staff_id not in staff_known:
        reasons.append("staff id not in Faculty_Data")
    if c.biometric_id and c.biometric_id not in bio_known:
        reasons.append("biometric id not in Faculty_Data")
    if c.scopus_author_id and c.scopus_author_id not in scopus_known:
        reasons.append("scopus id not in Faculty_Data")
    if not (c.staff_id or c.biometric_id or c.scopus_author_id):
        reasons.append("row carries no identifier at all")
    key = " + ".join(reasons) or "identifiers present and known (name mismatch)"
    miss[key] += 1
    sample.setdefault(key, (c.staff_id, c.biometric_id, c.scopus_author_id, (c.paper_title or "")[:44]))

print("\nwhy:")
for reason, n in miss.most_common():
    print(f"  {n:>4}  {reason}")
    print(f"        e.g. staff={sample[reason][0]} bio={sample[reason][1]} scopus={sample[reason][2]}")

print(f"\naccounts on file: {User.objects.filter(role='FACULTY').count()}")
print(f"  with staff id   {len(staff_known)}")
print(f"  with bio id     {len(bio_known)}")
print(f"  with scopus id  {len(scopus_known)}")
