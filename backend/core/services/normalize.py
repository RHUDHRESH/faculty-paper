import re


def normalize_title(title: str | None) -> str:
    if not title:
        return ""
    s = title.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def title_tokens(title: str | None) -> set[str]:
    """Significant tokens for rough, case-insensitive matching."""
    stop = {
        "a",
        "an",
        "the",
        "of",
        "and",
        "or",
        "in",
        "on",
        "for",
        "to",
        "with",
        "using",
        "based",
    }
    return {t for t in normalize_title(title).split() if len(t) > 2 and t not in stop}


def titles_rough_match(a: str | None, b: str | None, *, min_overlap: float = 0.72) -> bool:
    """Case-insensitive rough match: exact normalize, containment, or token overlap."""
    na, nb = normalize_title(a), normalize_title(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if na in nb or nb in na:
        return True
    ta, tb = title_tokens(a), title_tokens(b)
    if not ta or not tb:
        return False
    overlap = len(ta & tb) / max(len(ta), len(tb))
    return overlap >= min_overlap


def normalize_doi(doi: str | None) -> str | None:
    """A DOI reduced to its bare `10.x/y` form, however it was pasted in.

    The resolver prefix is stripped as many times as it appears, not once. A
    field that prefills "https://doi.org/" and a value pasted out of a
    browser's address bar together produce
    "https://doi.org/https://doi.org/10.x/y", and an anchored single strip
    normalised that to "https://doi.org/10.x/y" while the same paper filed
    without the doubling normalised to "10.x/y". The DOI is the duplicate key
    that `check_already_paid` and the ERP import compare on, so the two did
    not recognise each other and the same paper could be paid twice.

    Normalising is therefore idempotent: normalise(normalise(x)) == normalise(x).
    """
    if not doi:
        return None
    s = doi.strip().lower()
    s = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/)+", "", s)
    return s or None


def issn_check_digit_ok(value: str) -> bool:
    """Whether eight characters satisfy the ISSN check digit.

    The last character is a mod-11 checksum over the first seven, weighted 8
    down to 2, with X standing for ten. It is what makes a zero-padded
    reconstruction safe to accept: of the wrong paddings, almost none pass.
    """
    cleaned = (value or "").upper()
    # `str.isdigit()` is true for characters `int()` cannot parse -- "²"
    # and the rest of the superscripts and subscripts among them -- so the
    # guard let them through and the sum below raised ValueError. A predicate
    # that raises is a predicate every caller has to wrap, and "10²" is a
    # real thing a person types into a spreadsheet cell. Only ASCII 0-9 are
    # digits for a check digit's purposes.
    if len(cleaned) != 8 or not (cleaned[:7].isascii() and cleaned[:7].isdigit()):
        return False
    total = sum(int(d) * w for d, w in zip(cleaned[:7], range(8, 1, -1)))
    remainder = total % 11
    expected = "0" if remainder == 0 else ("X" if remainder == 1 else str(11 - remainder))
    return cleaned[7] == expected


def normalize_issn(issn: str | None) -> str | None:
    """An ISSN as eight characters, whatever a spreadsheet did to it first.

    Two things happen to ISSNs on the way in, both from being read as numbers:

    - A trailing ".0" from a float. Stripping non-digits made "2728842.0" into
      "27288420" -- eight characters, so it passed the length check and was
      returned as "2728-8420", a real-looking ISSN belonging to nobody. A
      wrong match is worse than no match, because it attaches another
      journal's quartile to this one, and quartile is a term in the payout.
    - A lost leading zero: ISSN 0272-8842 arrives as "2728842". Seven
      characters failed the check and were passed through unchanged, so it
      never matched the reference data, which stores the zero.

    Nine thousand nine hundred and ninety-three reference rows carry the
    first, and the claim table carries the second.
    """
    # A whitespace-only value is a blank value. Returning "" for it while an
    # empty string returned None made the function disagree with itself:
    # normalising once gave "", normalising that gave None. Every empty-ish
    # input now gives the same answer, so the function is idempotent.
    if not issn or not str(issn).strip():
        return None
    text = issn.strip()
    # Only when the whole value looks like a float, so an ISSN legitimately
    # ending in 0 is untouched.
    if re.fullmatch(r"\d+\.0+", text):
        text = text.split(".")[0]
    cleaned = re.sub(r"[^0-9Xx]", "", text).upper()
    if len(cleaned) < 8:
        # More than one leading zero can be gone. "0010-0161" read as a number
        # is 100161 -- six characters, not seven -- and padding a single zero
        # never reaches it, which left 823 Scimago and 3,291 SNIP rows
        # unmatchable after the earlier repairs.
        #
        # Padding is a guess, so it is checked rather than trusted: an ISSN's
        # last character is a mod-11 check digit over the first seven, and a
        # wrong number of zeros almost never satisfies it. That turns this from
        # inventing an identifier into recovering one, and it is the difference
        # that matters -- a fabricated ISSN belongs to a real journal that is
        # not this one, and quartile is a term in the payout.
        # There has to be something left to pad. "not an issn" strips to
        # nothing, pads to "00000000", and all zeros satisfy the checksum
        # trivially -- so without this the one input the check digit was meant
        # to reject is the one input it waves through, and a junk value comes
        # back looking like the perfectly good ISSN 0000-0000. Four characters
        # is the floor because the shortest real loss in the data is three
        # zeros ("0001-2505" arriving as "12505").
        padded = cleaned.rjust(8, "0")
        if len(cleaned) >= 4 and cleaned.strip("0") and issn_check_digit_ok(padded):
            cleaned = padded
        elif len(cleaned) == 7:
            # Kept unconditional for the single-zero case, which is what the
            # claim table carries and what the earlier repairs assumed.
            cleaned = "0" + cleaned
    if len(cleaned) != 8:
        return issn.strip()
    return f"{cleaned[:4]}-{cleaned[4:]}"
