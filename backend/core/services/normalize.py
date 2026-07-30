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
    if not doi:
        return None
    s = doi.strip().lower()
    s = re.sub(r"^https?://(dx\.)?doi\.org/", "", s)
    return s or None


def normalize_issn(issn: str | None) -> str | None:
    if not issn:
        return None
    cleaned = re.sub(r"[^0-9Xx]", "", issn).upper()
    if len(cleaned) != 8:
        return issn.strip()
    return f"{cleaned[:4]}-{cleaned[4:]}"
