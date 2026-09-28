"""Is "R. Subhashini" the same person as "Subhashini Ramesh"?

Indian names reach us in every order and every degree of abbreviation: the
roster says "Ms. S.S. Kiruthika", OpenAlex says "Kiruthika S S", a journal
says "Kiruthika Sundaram". A name is reduced to its *full* tokens (two or more
letters) and its *initials*, and two names are compared as follows:

- they must share at least one full token (a given name);
- every remaining full token on one side must be explained by an initial on
  the other ("Ramesh" by "R.");
- what is left over after that is *extra* detail. Extra detail on one side
  only is missing information ("S. Joyal Isac" / "Joyal Isac": 0.85; a whole
  missing name, "V. Sai Muthukumar" / "V. Muthukumar", 0.8). Extra
  detail on both sides is a contradiction ("R. Subhashini" / "K. Subhashini":
  0) -- two different people.

A score is a similarity, not a decision. The matcher decides, and it only
decides when exactly one person in the college scores highest.
"""

from __future__ import annotations

import re
import unicodedata

TITLES = frozenset({"dr", "mr", "mrs", "ms", "miss", "prof", "professor", "er", "sri", "smt", "thiru", "selvi"})


def _ascii(value: str) -> str:
    return unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()


def name_parts(name: str | None) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """(full tokens, initials), lower-case, titles dropped, order kept."""
    raw = _ascii(name or "")
    all_caps = raw.upper() == raw
    full: list[str] = []
    initials: list[str] = []
    for chunk in re.split(r"[\s.,_\-]+", raw):
        token = re.sub(r"[^A-Za-z]", "", chunk)
        if not token:
            continue
        low = token.lower()
        if low in TITLES:
            continue
        if len(token) == 1:
            initials.append(low)
        elif len(token) <= 3 and token.isupper() and not all_caps:
            # "Gowri Ganesh NS": glued initials.
            initials.extend(low)
        else:
            full.append(low)
    return tuple(full), tuple(initials)


def name_key(name: str | None) -> str:
    """A stable key for a name that is not anybody we know: sorted parts."""
    full, initials = name_parts(name)
    return " ".join(sorted(full) + sorted(initials))


def name_score(a: str | None, b: str | None) -> float:
    fa, ia = name_parts(a)
    fb, ib = name_parts(b)
    if not fa or not fb:
        return 0.0
    if "".join(fa) == "".join(fb) and (fa != fb):
        # "Joyalisac" / "Joyal Isac"
        return 0.9
    common = set(fa) & set(fb)
    if not common:
        return 0.0
    rest_a = [t for t in fa if t not in common]
    rest_b = [t for t in fb if t not in common]
    ia_left = list(ia)
    ib_left = list(ib)
    expanded = False
    expanded_b = False
    left_a: list[str] = []
    for token in rest_a:
        if token[0] in ib_left:
            ib_left.remove(token[0])
            expanded = True
        else:
            left_a.append(token)
    left_b: list[str] = []
    for token in rest_b:
        if token[0] in ia_left:
            ia_left.remove(token[0])
            expanded_b = True
        else:
            left_b.append(token)
    # Initials that match each other.
    for letter in list(ia_left):
        if letter in ib_left:
            ia_left.remove(letter)
            ib_left.remove(letter)
    # An initial may abbreviate a shared token ("J. Isac" / "Joyal Isac").
    extra_a = left_a + [x for x in ia_left if x not in {t[0] for t in fb}]
    extra_b = left_b + [x for x in ib_left if x not in {t[0] for t in fa}]
    if extra_a and extra_b:
        return 0.0
    extra = len(extra_a) + len(extra_b)
    if extra:
        # A missing initial is routine; a whole missing name ("V. Sai
        # Muthukumar" / "V. Muthukumar") is weaker evidence, below the bar
        # the name matcher acts on by itself.
        whole = sum(1 for x in extra_a + extra_b if len(x) > 1)
        return max(0.85 - 0.05 * (extra - 1) - (0.05 if whole else 0), 0.7)
    if expanded and expanded_b:
        # Each side's name explained only by the other's initial: "R. Monish
        # Kumar" / "Rakesh Kumar M" share nothing but "Kumar". Too weak alone.
        return 0.8
    return 0.92 if (expanded or expanded_b) else 1.0


#: Department codes on the roster, and words a raw affiliation uses for them.
DEPARTMENT_WORDS: dict[str, tuple[str, ...]] = {
    "EEE": ("electrical and electronics", "electrical & electronics", "eee"),
    "ECE": ("electronics and communication", "electronics & communication", "ece"),
    "EIE": ("electronics and instrumentation", "instrumentation"),
    "CSE": ("computer science",),
    "CSE - CS": ("cyber security", "cybersecurity"),
    "CSE - IoT": ("internet of things", "iot"),
    "IT": ("information technology",),
    "AI&DS": ("artificial intelligence and data science", "data science"),
    "AI&ML": ("artificial intelligence and machine learning", "machine learning"),
    "MECH": ("mechanical",),
    "CIVIL": ("civil",),
    "CHEMICAL": ("chemical engineering",),
    "BME": ("biomedical", "bio medical", "bio-medical"),
    "MBA": ("management studies", "business administration", "mba"),
    "AGRI": ("agricultur",),
    "MED": ("medical electronics",),
    "S&H-CHY": ("chemistry",),
    "S&H-PHY": ("physics",),
    "S&H-MATHS": ("mathematics", "maths"),
    "S&H-ENGLISH": ("english",),
}


def departments_in(affiliation: str | None) -> set[str]:
    text = (affiliation or "").lower()
    return {code for code, words in DEPARTMENT_WORDS.items() if any(w in text for w in words)}
