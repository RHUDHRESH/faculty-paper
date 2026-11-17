"""An amount of money as a person reads it: ₹1,09,265, or ₹1,09,265.50 when the paise are real.

The same rule as `money()` in the frontend (`ui/paper.tsx`), so a sentence the
server writes and a figure the page draws do not disagree about decimals.
Indian grouping (lakh, crore), because that is how the college reads a number.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Optional


def _indian(whole: int) -> str:
    s = str(whole)
    if len(s) <= 3:
        return s
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts + [tail])


def rupees(value: Optional[float]) -> str:
    """"₹5,000" for a whole amount, "₹5,000.50" for a real fifty paise."""
    if value is None:
        return "Not recorded"
    paise = int((Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    sign = "-" if paise < 0 else ""
    whole, frac = divmod(abs(paise), 100)
    return f"{sign}₹{_indian(whole)}" + (f".{frac:02d}" if frac else "")
