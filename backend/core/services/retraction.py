"""Whether a paper looks retracted.

There is no field in the data we hold that says "this paper was retracted".
Scopus does not expose a retraction flag on a search entry, and its document
subtypes distinguish an erratum from an article but not a live article from a
withdrawn one. What publishers do, consistently, is rewrite the title: IEEE,
Elsevier, Springer, Wiley and Taylor & Francis all prefix a withdrawn paper
with "RETRACTED", "Retraction", "WITHDRAWN" or similar, on the article page
and in the metadata every index then copies.

So this reads the title, and says so. It is a signal, not a determination:

- It finds a retraction only once the publisher has renamed the paper, which
  can be months after the decision, and never for a retraction the publisher
  handled quietly.
- It can be wrong the other way: a paper *about* retractions, or an editorial
  announcing one, carries the same words.

Both directions are why nothing here decides anything on its own. A hit
raises a verification issue, which the claimant can contest with a note, and
which reaches the research cell as a flagged request they have to action --
the same route a missing quartile takes. Anyone with better evidence, in
either direction, is the one who settles it.

The alternative -- checking a retraction database such as Retraction Watch --
would be a stronger signal, and would need a data source the college does not
currently license or hold. Wiring one in later means replacing the body of
looks_retracted(); nothing else here changes.
"""

from __future__ import annotations

import re

#: Publisher prefixes, as they are actually written. Anchored to the start of
#: the title: a paper *about* retraction says the word in the middle of a
#: sentence, while a retracted one is renamed from the front.
_PREFIXES = re.compile(
    r"""^\s*[\[\(<]*\s*
        (
            retracted            # "RETRACTED: Deep learning for ..."
          | retraction           # "Retraction: Deep learning for ..."
          | withdrawn            # "WITHDRAWN: Deep learning for ..."
          | withdrawal           # "Withdrawal: ..."
          | expression\s+of\s+concern
        )
        \b[\s:.\]\)>-]*""",
    re.IGNORECASE | re.VERBOSE,
)

#: The same words in the sort of phrase an editor writes about somebody else's
#: paper. Matched anywhere, because these are whole announcements.
_ANNOUNCEMENTS = re.compile(
    r"""(
            retraction\s+(notice|note|statement)
          | notice\s+of\s+retraction
          | this\s+article\s+has\s+been\s+(retracted|withdrawn)
          | article\s+withdrawn
        )""",
    re.IGNORECASE | re.VERBOSE,
)


def looks_retracted(title: str | None) -> str | None:
    """The phrase that matched, or None.

    Returning the phrase rather than True is deliberate: the claimant is told
    what was seen in their own title, so they can judge it themselves rather
    than argue with a verdict.
    """
    text = (title or "").strip()
    if not text:
        return None
    hit = _PREFIXES.match(text) or _ANNOUNCEMENTS.search(text)
    if not hit:
        return None
    return hit.group(1).strip()
