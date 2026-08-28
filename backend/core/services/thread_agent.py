"""The assistant that answers when somebody writes @agent in a thread.

**A lookup first, a model only where a lookup cannot go.** Every fact it
states — a quartile, a SNIP, a ticket's progress, a rupee figure — is read out
of this college's own tables or the keyless scholarly sources. That ordering
is not a performance tweak, it is the accountability argument: "Nature is Q1,
SNIP 5.2, and at author 3 of 4 that pays ₹63,000" is checkable against the
same tables the payment is made from, and a model saying the same sentence is
a guess that happens to be formatted like a fact.

What the lookups cannot do is answer a question. "Is this venue a sensible
home for the work I have been doing?" has no row to read. Since there is now a
model on this machine — no key, no quota, no cost, and nothing leaving the
loopback interface — that class of question gets an answer instead of a shrug.

Three properties hold it in place.

**The model proposes, the database disposes.** The same rule the discovery
feature follows. The model returns prose and a bare list of journal titles; it
never returns a number. Each title is resolved against `ScimagoJournal` before
it is repeated, and a title that resolves to nothing is dropped rather than
shown — a plausible venue with a confident figure beside it is how somebody
submits to a journal that does not exist.

**No amount reaches it and no amount comes back.** The prompt is scrubbed of
rupee figures before it is sent, whoever is asking, and any sentence the model
returns carrying money, a quartile, a SNIP or an SJR is dropped on the way
out. A head of department therefore cannot reach an amount through the
assistant by any wording, which is the same rule `hod.without_money` enforces
everywhere else — enforced here structurally rather than by remembering.

**It is slow and says so.** Generation runs on the CPU at roughly 4.5 tokens a
second (see `docs/LOCAL-AI.md`), so 120 tokens is about 27 seconds. The
assistant answers inside the request that posted the message, so that wait is
somebody watching a spinner. Three ways out were available and this is the one
chosen, honestly:

- *A short bounded answer* — taken. The model is asked for at most
  `ANSWER_WORDS` words of prose and at most `SHOW_JOURNALS` bare titles.
  Measured end to end against the real daemon on this machine: **12.8s with
  the model already resident, 39.1s cold**, and the answer both times was two
  useful sentences and one verified journal. `ANSWER_DEADLINE` caps it
  at a quarter of `ollama.DEFAULT_TIMEOUT`, so a wedged daemon costs a minute
  rather than four. The reply carries the elapsed time in its own footer,
  because pretending it was instant is how a feature gets blamed for the
  network — and because a reader who can see 39s can decide for themselves
  whether to ask it the next one.
- *A "thinking" post edited when the answer lands* — rejected, and not on
  taste. `answer()` returns text; the post that carries it is created by
  `api.py` afterwards, so this module has no id to edit and would have to poll
  another module's rows for a post it did not write.
- *Refusing long questions* — already true by construction: the bound above is
  what makes the answer short, rather than a rule about which questions are
  allowed.

And the lookups still come first. A question that names a journal, a paper, a
person or a department is answered from the tables in milliseconds and never
touches the model at all, which is most of what is actually asked.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any

from core.models import Claim, ClaimStatus, Mention, Role, User
from core.services import ai, rbac
from core.services.normalize import normalize_issn

logger = logging.getLogger(__name__)

#: A head of department never sees an amount, here as anywhere else.
def _may_see_money(user: User) -> bool:
    return user.role != Role.HOD


def _money(value: float | None) -> str:
    if value is None:
        return "—"
    return f"₹{value:,.0f}"


def _journal_facts(title: str) -> dict[str, Any]:
    """What we hold about a journal, and plainly what we do not.

    Goes through `lookup_scimago` and `lookup_snip_dump` rather than reading
    the tables directly: quartile is not a column on ScimagoJournal, it is
    derived from the subject categories, and SNIP is keyed on `print_issn` or
    `e_issn` with several ISSN spellings to try. Reimplementing either here
    would be a second, slightly different answer to a question the rest of the
    app already answers.
    """
    from core.services.scimago import lookup_scimago
    from core.services.verify import lookup_snip_dump

    rows = Claim.objects.filter(journal_title__iexact=title)
    sample = rows.exclude(issn__isnull=True).exclude(issn="").first() or rows.first()
    issn = normalize_issn(getattr(sample, "issn", None)) if sample else None

    scimago = lookup_scimago(issn=issn, title=title) or {}
    snip = lookup_snip_dump(issn, title)

    return {
        "title": title,
        "issn": issn,
        "quartile": scimago.get("matched_quartile") or scimago.get("quartile"),
        "sjr": scimago.get("sjr"),
        "dataset_year": scimago.get("year") or scimago.get("dataset_year"),
        "snip": snip,
        "papers_here": rows.exclude(status=ClaimStatus.DRAFT).count(),
        "known": bool(scimago.get("matched_quartile") or scimago.get("quartile") or snip),
    }


def _answer_journal(title: str, asker: User) -> str:
    facts = _journal_facts(title)
    lines: list[str] = [f"**{facts['title']}**"]

    if facts["issn"]:
        lines.append(f"ISSN {facts['issn']}")

    if not facts["known"]:
        # Said rather than filled in. This is the branch that stops the
        # assistant from being confidently wrong about a venue.
        lines.append(
            "We hold no SCImago or SNIP record for this journal, so there is no "
            "quartile and nothing can be priced against it. That does not mean "
            "the journal is not indexed — it means our reference data does not "
            "recognise this ISSN, which is worth telling the research cell."
        )
    else:
        standing = []
        if facts["quartile"]:
            standing.append(facts["quartile"])
        if facts["snip"] is not None:
            standing.append(f"SNIP {facts['snip']}")
        if facts["sjr"] is not None:
            standing.append(f"SJR {facts['sjr']}")
        if facts["dataset_year"]:
            standing.append(f"({facts['dataset_year']} data)")
        if standing:
            lines.append(" · ".join(standing))

        if _may_see_money(asker):
            estimate = _price(facts, author_position=1, total_authors=1)
            if estimate is not None:
                lines.append(
                    f"A sole-authored paper here works out at about {_money(estimate)}. "
                    "That is an estimate from the current policy for one author — "
                    "your own position and the number of authors change it."
                )

    if facts["papers_here"]:
        lines.append(
            f"{facts['papers_here']} papers from this college are on record in it."
        )
    else:
        lines.append("Nobody here has filed a paper in it yet.")

    return "\n\n".join(lines)


def _price(facts: dict[str, Any], *, author_position: int, total_authors: int) -> float | None:
    """What the current policy would pay, using the same calculator as a claim."""
    from core.models import FormulaConfig
    from core.services.remuneration import calculate_remuneration, formula_from_model

    cfg_row = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    cfg = formula_from_model(cfg_row) if cfg_row else None
    try:
        result = calculate_remuneration(
            snip=facts.get("snip"),
            quartile=facts.get("quartile"),
            total_authors=total_authors,
            author_position=author_position,
            cfg=cfg,
            indexing_level="Scopus",
            # Priced as an eligible paper so the figure answers "what is this
            # journal worth", not "what would happen if you attached nothing".
            sec_reference_count=None,
        )
    except Exception:
        return None
    return getattr(result, "remuneration", None)


def _answer_paper(claim: Claim, asker: User) -> str:
    from core.hod import progress_of

    lines = [f"**{claim.paper_title or 'Untitled'}**"]
    meta = [x for x in (claim.journal_title, str(claim.publication_year or "")) if x]
    if meta:
        lines.append(" · ".join(meta))

    if asker.role == Role.HOD or claim.owner_id == asker.id or rbac.can_view_reports(asker.role):
        lines.append(f"Where it is: {progress_of(claim.status)}")
    if claim.quartile:
        lines.append(f"Quartile {claim.quartile}")

    if _may_see_money(asker) and (
        claim.owner_id == asker.id or rbac.can_view_reports(asker.role)
    ):
        if claim.remuneration is not None:
            lines.append(f"Amount on the ticket: {_money(claim.remuneration)}")
        if claim.calc_error:
            lines.append(f"The amount could not be worked out: {claim.calc_error}")

    if claim.duplicate_warning:
        lines.append(
            "This paper carries a payment-history warning — it may already have been paid for."
        )
    return "\n\n".join(lines)


def _answer_person(person: User, asker: User) -> str:
    papers = Claim.objects.filter(owner=person).exclude(status=ClaimStatus.DRAFT)
    total = papers.count()
    q1 = papers.filter(quartile__iexact="Q1").count()
    led = papers.filter(author_position=1).count()

    lines = [f"**{person.name or person.email}**"]
    where = " · ".join(x for x in (person.department, person.designation) if x)
    if where:
        lines.append(where)
    lines.append(
        f"{total} papers on record, {q1} of them Q1, {led} led as first author."
    )

    areas = _areas_for(papers)
    if areas:
        lines.append("Works on: " + ", ".join(a for a, _ in areas[:5]) + ".")
    # No money about somebody else, whoever is asking. A colleague's payout is
    # not answerable here even for a role that could look it up elsewhere.
    return "\n\n".join(lines)


def _areas_for(queryset) -> list[tuple[str, int]]:
    from core.api import _split_subjects

    counts: dict[str, int] = {}
    for raw in queryset.values_list("subjects_json", flat=True):
        for area, _q in _split_subjects(raw):
            counts[area] = counts.get(area, 0) + 1
    return sorted(counts.items(), key=lambda kv: -kv[1])


def _answer_department(department: str, asker: User) -> str:
    papers = Claim.objects.filter(owner__department__iexact=department).exclude(
        status=ClaimStatus.DRAFT
    )
    total = papers.count()
    people = User.objects.filter(
        role=Role.FACULTY, department__iexact=department, active=True
    ).count()
    q1 = papers.filter(quartile__iexact="Q1").count()

    lines = [f"**{department}**", f"{total} papers on record from {people} faculty, {q1} of them Q1."]
    areas = _areas_for(papers)
    if areas:
        lines.append(
            "Strongest areas: " + ", ".join(f"{a} ({n})" for a, n in areas[:5]) + "."
        )
    return "\n\n".join(lines)


def _answer_search(question: str) -> str:
    """The field outside, from the keyless sources."""
    from core.services import research_search

    try:
        found = research_search.search(question, limit=5)
    except Exception:
        logger.exception("thread_agent search tool failed")
        # Logged, because this handler previously hid a TypeError in `rank`
        # and reported it to the reader as an upstream outage -- a wrong
        # answer that sounds like a right one, for as long as nobody checks.
        return (
            "I could not reach the scholarly sources just now. Nothing is wrong "
            "with the thread — try again in a moment."
        )

    results = found.get("results") or []
    if not results:
        return f"Nothing came back for “{question}”."

    lines = [f"Recent work on **{question}**:"]
    for r in results[:5]:
        bits = [r.get("title") or "Untitled"]
        tail = " · ".join(
            str(x)
            for x in (r.get("journal"), r.get("year"), f"{r.get('citations')} citations"
                      if r.get("citations") else None)
            if x
        )
        if tail:
            bits.append(tail)
        if r.get("url"):
            bits.append(r["url"])
        lines.append("- " + " — ".join(bits))

    failed = found.get("failed") or []
    if failed:
        # A thin list should read as one source being down, not a thin field.
        lines.append(
            f"({', '.join(failed)} did not answer, so there is likely more than this.)"
        )
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# The open question, and the model that is allowed a small part of it          #
# --------------------------------------------------------------------------- #

#: How much prose the model is allowed. Sized from the hardware rather than
#: from taste: about 4.5 tokens a second means every ten words is roughly
#: three seconds of somebody watching a spinner inside their own POST.
ANSWER_WORDS = 45

#: How many journal titles it may point at. Each one costs a few tokens to
#: generate and a database round trip to resolve, and a thread reply is not a
#: venue list — that is what the Discover page is for.
SHOW_JOURNALS = 2

#: A wall-clock ceiling for one thread answer, a quarter of the module default
#: of 240s. A backstop rather than a target: what actually bounds the wait is
#: `ANSWER_WORDS`, and the measured cost of that on this machine is 12.8s
#: with the model resident and 39.1s from cold. Those were gemma4:12b's
#: numbers; this answer now runs on gemma3:4b, measured at 5.4s warm and
#: 10.5s cold on the same prompt -- 3.3x faster per token, and 2.88 GB
#: resident rather than 8.90. Thirty still clears the cold case with room,
#: which is the failure worth sizing against: an assistant that works except
#: just after a restart.
ANSWER_DEADLINE = 30

#: How much text has to be left beside a mention before it counts as a
#: question. "@agent @journal:Nature" is a lookup and must stay instant;
#: "@agent @journal:Nature is that a sensible home for my work?" is not.
MODEL_MIN_QUESTION = 12

#: How much of the conversation the model is shown. Enough for "it" and "that
#: journal" to refer to something; not so much that reading the prompt costs
#: more than writing the answer.
CONTEXT_POSTS = 6
CONTEXT_CHARS = 240

#: Anything shaped like money, in any of the spellings this college writes it.
#:
#: Used twice and in opposite directions: nothing matching this is put *into*
#: a prompt, and no sentence matching it comes *out* of one. A head of
#: department is money-blind everywhere else in this system by way of
#: `hod.without_money`, and an assistant that could be talked into an estimate
#: would be a hole straight through that.
_MONEY_RE = re.compile(
    r"₹\s*[\d,]*(?:\.\d+)?"
    r"|\b(?:rs\.?|inr|rupees?)\s*[\d,]*(?:\.\d+)?"
    r"|\b\d[\d,]*(?:\.\d+)?\s*(?:lakhs?|lacs?|crores?)\b"
    r"|\b(?:lakhs?|crores?)\b",
    re.IGNORECASE,
)

#: What a sentence from the model is not allowed to contain. Money, and the
#: three metrics that only our own reference tables are entitled to state.
#: A model that says "Q1" has not looked anything up; it has guessed in the
#: house style, which is worse than guessing plainly.
_UNFOUNDED_RE = re.compile(
    r"₹|\brs\.?\b|\binr\b|\brupees?\b|\blakhs?\b|\bcrores?\b"
    r"|\bq[1-4]\b|\bsnip\b|\bsjr\b|\bimpact factor\b|\bh-?index\b",
    re.IGNORECASE,
)

#: Openings that mean "go and search the literature" rather than "answer me".
#: Those already have a keyless answer that is better than a 12b model's
#: recollection of the field, so they never reach the model.
_SEARCH_RE = re.compile(
    r"^\s*(?:find|search|look\s+up|look\s+for|show\s+me|list)\b"
    r"|\b(?:recent|latest|current)\s+(?:work|research|papers?|publications?)\b"
    r"|\b(?:papers?|publications?|literature|work)\s+(?:on|about)\b",
    re.IGNORECASE,
)

_FIRST_PERSON_RE = re.compile(r"\b(?:i|me|my|mine|myself|we|our|ours)\b", re.IGNORECASE)

#: Why the model last declined to answer, for somebody looking into it.
#:
#: The assistant fails silently on purpose — a broken reply must never eat the
#: human post underneath it — and silence is exactly what nobody can debug. So
#: every failure is logged at warning with its `AIError.code`, and the last one
#: is left here where a shell can read it:
#:
#:     from core.services import thread_agent; thread_agent.last_model_error()
_LAST_ERROR: dict[str, Any] = {}


def last_model_error() -> dict[str, Any]:
    """The most recent reason the model did not answer, or an empty dict."""
    return dict(_LAST_ERROR)


def _note_failure(reason: str, code: str, detail: str = "") -> None:
    _LAST_ERROR.clear()
    _LAST_ERROR.update(
        {"reason": reason, "code": code, "detail": detail, "at": time.time()}
    )
    logger.warning("thread_agent_model_unanswered reason=%s code=%s %s", reason, code, detail)


_ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "journals": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["answer"],
}


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", (text or "").strip()) if s.strip()]


def _keep_founded(text: str) -> tuple[str, int]:
    """The model's prose with every unfounded claim taken out of it.

    Dropped by the sentence rather than redacted word by word, because a
    sentence with a hole punched in it still reads as an assertion and the
    reader fills the hole in themselves. Returns what survived and how much
    did not, so the caller can log a model that keeps trying to price things.
    """
    kept, dropped = [], 0
    for sentence in _sentences(text):
        if _UNFOUNDED_RE.search(sentence):
            dropped += 1
            continue
        kept.append(sentence)
    return " ".join(kept), dropped


def _thread_context(post) -> list[str]:
    """What has been said in this thread already, shortest useful form.

    Only what the asker can already read — they are in the thread — and only
    the tail of it. Money is stripped by `_scrubbed` before any of this is
    sent, so an earlier agent reply quoting a payout cannot be read back out
    by somebody who is not allowed to see it.
    """
    rows = (
        post.thread.posts.filter(deleted_at__isnull=True)
        # Everything except the post being answered -- that one is handed over
        # separately as the question, and a 12b model shown the same sentence
        # twice sometimes answers the copy.
        .exclude(pk=post.pk)
        .select_related("author")
        .order_by("-created_at")[:CONTEXT_POSTS]
    )
    lines = []
    for row in reversed(list(rows)):
        who = "assistant" if row.kind == "AGENT" else (
            getattr(row.author, "name", None) or "somebody"
        )
        body = " ".join((row.body or "").split())[:CONTEXT_CHARS]
        if body:
            lines.append(f"{who}: {body}")
    return lines


def _mention_context(mentions: list, asker: User) -> list[str]:
    """The records named in the post, as facts rather than as names.

    The point of grounding: the model is told what we hold about a journal so
    it can reason about fit, and is then forbidden from repeating any of it —
    the numbers are printed from the same lookup, above its answer.
    """
    from core.hod import progress_of

    lines: list[str] = []
    for mention in mentions:
        if mention.kind == Mention.Kind.JOURNAL and mention.journal_title:
            facts = _journal_facts(mention.journal_title)
            if facts["known"]:
                bits = [f"quartile {facts['quartile']}" if facts["quartile"] else "",
                        f"SNIP {facts['snip']}" if facts["snip"] is not None else ""]
                lines.append(
                    f"Journal '{facts['title']}': "
                    + ", ".join(b for b in bits if b)
                    + f"; {facts['papers_here']} papers from this college in it."
                )
            else:
                lines.append(
                    f"Journal '{facts['title']}': we hold no reference record for it."
                )
        elif mention.kind == Mention.Kind.PAPER and mention.claim_id:
            claim = mention.claim
            lines.append(
                f"Paper '{claim.paper_title or 'Untitled'}' in "
                f"{claim.journal_title or 'an unnamed journal'} "
                f"({claim.publication_year or 'year unknown'}), "
                f"currently {progress_of(claim.status)}."
            )
        elif mention.kind == Mention.Kind.USER and mention.user_id:
            person = mention.user
            papers = Claim.objects.filter(owner=person).exclude(status=ClaimStatus.DRAFT)
            lines.append(
                f"Colleague {person.name or person.email} "
                f"({person.department or 'department unknown'}): "
                f"{papers.count()} papers on record."
            )
        elif mention.kind == Mention.Kind.DEPARTMENT and mention.department:
            papers = Claim.objects.filter(
                owner__department__iexact=mention.department
            ).exclude(status=ClaimStatus.DRAFT)
            lines.append(
                f"Department {mention.department}: {papers.count()} papers on record."
            )
    return lines


def _own_history(asker: User) -> list[str]:
    from core.services.discover import publication_history

    return [
        f"- {row['title']} ({row['journal'] or 'journal unrecorded'}, {row['year'] or 'n.d.'})"
        for row in publication_history(asker, limit=6)
    ]


def _scrubbed(text: str) -> str:
    """A prompt with every rupee figure taken out of it, whoever is asking.

    The last line of defence rather than the only one: nothing above
    deliberately puts an amount into the context. It is applied to the
    assembled prompt anyway, because the context is built from other people's
    posts and a colleague may well have typed one — and because a rule applied
    at one chokepoint is a rule that cannot be forgotten at a call site added
    next year.
    """
    return _MONEY_RE.sub("[amount withheld]", text or "")


def _build_prompt(question: str, context: list[str]) -> str:
    return _scrubbed(
        "You are the assistant in a discussion thread at an Indian engineering "
        "college. Faculty ask you about publishing.\n\n"
        + ("What we hold, and what has been said:\n" + "\n".join(context) + "\n\n"
           if context else "")
        + f"The question: {question}\n\n"
        f"Answer it in at most {ANSWER_WORDS} words of plain prose. No lists, no "
        "headings, no preamble. If you do not know, say so in one sentence rather "
        "than filling the space.\n\n"
        "You must not state any amount of money, any quartile, any SNIP, any SJR "
        "or any impact factor. Those are read out of our own tables and printed "
        "beside your answer; a number from you would be a guess wearing the same "
        "clothes as a fact, and any sentence containing one will be discarded.\n"
        "Do not name journals inside 'answer'. If journals are worth pointing at, "
        f"put at most {SHOW_JOURNALS} exact full journal titles in 'journals' and "
        "the software will look them up and print what it finds. Give no title you "
        "are not confident is a real, currently published journal — an unrecognised "
        "one is dropped, so a guess costs the reader an answer rather than gaining "
        "them one."
    )


def _resolved_journals(names: list[str], asker: User) -> list[str]:
    """Our own record for each journal the model named. The rest are dropped.

    This is the whole safety argument, borrowed intact from the venue search:
    the model contributes a name and nothing else, and every number beside it
    comes from `ScimagoJournal` and the SNIP dump. A name we cannot resolve is
    not shown as unverified here — a thread reply has no room for the
    quarantine column the Discover page has, and an unverified venue sitting
    in a sentence reads exactly like a verified one.
    """
    from core.services.discover import describe_journal, find_journal

    lines: list[str] = []
    seen: set[str] = set()
    for raw in names[: SHOW_JOURNALS * 3]:
        name = (raw or "").strip() if isinstance(raw, str) else ""
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())

        row = find_journal(name)
        if row is None:
            logger.info("thread_agent_dropped_unresolved_journal name=%r", name[:120])
            continue

        journal = describe_journal(row)
        standing = [
            journal.get("quartile") or "",
            f"SNIP {journal['snip']}" if journal.get("snip") is not None else "",
            f"SJR {journal['sjr']}" if journal.get("sjr") is not None else "",
            f"({journal['dataset_year']} data)" if journal.get("dataset_year") else "",
        ]
        line = f"**{journal['title']}** — " + " · ".join(s for s in standing if s)
        if _may_see_money(asker):
            estimate = _price(
                {"snip": journal.get("snip"), "quartile": journal.get("quartile")},
                author_position=1,
                total_authors=1,
            )
            if estimate is not None:
                line += f" — about {_money(estimate)} sole-authored, on the current policy"
        lines.append(line)
        if len(lines) >= SHOW_JOURNALS:
            break
    return lines


def _answer_with_model(question: str, context: list[str], asker: User) -> str | None:
    """One bounded question to the local model, or None and a logged reason.

    Never raises. Every path out of here that is not an answer is a `None`
    with a line in the log carrying the code, because the caller's contract is
    that a broken assistant loses its own reply and nothing else.
    """
    # Both of these must name the fast tier, and the first one especially:
    # `ai.available()` asks after the considered model, so on a machine with
    # gemma4:12b installed and gemma3:4b missing it would answer yes and this
    # would walk straight into a 404 from Ollama. The health block reads
    # `fast_code`/`fast_detail` for the same reason -- reporting the wrong
    # model's readiness sends somebody to re-pull a model they already have.
    if not ai.available(fast=True):
        state = {}
        try:
            state = ai.health()
        except Exception:  # noqa: BLE001 - a health probe must not break a post
            pass
        _note_failure(
            "unavailable",
            str(state.get("fast_code") or state.get("code") or "unknown"),
            str(state.get("fast_detail") or state.get("detail") or ""),
        )
        return None

    started = time.monotonic()
    try:
        raw = ai.ask_json(
            _build_prompt(question, context),
            schema=_ANSWER_SCHEMA,
            temperature=0.2,
            timeout=ANSWER_DEADLINE,
            # The one caller on the interactive tier. Somebody is on the page
            # watching their own post, which is a different kind of waiting
            # from the venue search they start and walk away from.
            fast=True,
        )
    except ai.AIError as exc:
        _note_failure("refused", getattr(exc, "code", "error"), str(exc))
        return None
    except Exception as exc:  # noqa: BLE001 - never let it reach the post
        logger.exception("thread_agent_model_crashed")
        _note_failure("crashed", "error", str(exc))
        return None
    elapsed = time.monotonic() - started

    # A smaller model misses its container often enough to be ordinary rather
    # than exceptional; a bare string where an object was asked for is the
    # commonest shape, and `.get` on it is an AttributeError where a shrug
    # would do.
    if isinstance(raw, str):
        raw = {"answer": raw}
    if not isinstance(raw, dict):
        _note_failure("unusable", "unparsable", f"model returned {type(raw).__name__}")
        return None

    prose, dropped = _keep_founded(str(raw.get("answer") or ""))
    if dropped:
        logger.warning(
            "thread_agent_dropped_unfounded_sentences n=%d role=%s", dropped, asker.role
        )
    if not prose:
        _note_failure(
            "empty", "empty", f"{dropped} sentences dropped as unfounded" if dropped else ""
        )
        return None

    names = raw.get("journals")
    names = names if isinstance(names, list) else []
    lines = [prose, *_resolved_journals(names, asker)]
    lines.append(
        f"*Written by the model on this machine, {elapsed:.0f}s. It is slow, and it "
        "states no figures — every number above is read from our own records.*"
    )
    return "\n\n".join(lines)


HELP = (
    "I look things up in this college's own records and in the open scholarly "
    "sources first, because those answers are exact and instant. For a question "
    "no table can answer I ask the model running on this machine — no account, "
    "nothing leaving the server, and somewhere between fifteen and forty "
    "seconds of waiting, which is what a model on a CPU costs. I keep those "
    "answers short for that reason.\n\n"
    "Mention something alongside me and I will answer about it:\n"
    "- `@agent @journal:\"Applied Soft Computing\"` — its standing, and what a paper there pays\n"
    "- `@agent @paper:ERP-001934` — where that ticket is\n"
    "- `@agent @person:r.kumar` — what they publish\n"
    "- `@agent @dept:ECE` — what a department is working on\n"
    "- `@agent find recent work on federated learning` — the field outside\n"
    "- `@agent is this journal a sensible home for the work I have been doing?` — "
    "the model, grounded in the above\n\n"
    "I will not guess. If a journal is not in our reference data I will say so "
    "rather than price it, and no figure I print comes from the model."
)


def answer(post, asker: User) -> str | None:
    """The assistant's reply to one post, or None if it was not asked.

    Driven by the mentions already resolved on the post rather than by parsing
    the text again — so what it answers about is exactly what the thread shows
    it was asked about.
    """
    mentions = list(post.mentions.all())
    if not any(m.kind == Mention.Kind.AGENT for m in mentions):
        return None

    parts: list[str] = []
    for mention in mentions:
        if mention.kind == Mention.Kind.JOURNAL and mention.journal_title:
            parts.append(_answer_journal(mention.journal_title, asker))
        elif mention.kind == Mention.Kind.PAPER and mention.claim_id:
            parts.append(_answer_paper(mention.claim, asker))
        elif mention.kind == Mention.Kind.USER and mention.user_id:
            parts.append(_answer_person(mention.user, asker))
        elif mention.kind == Mention.Kind.DEPARTMENT and mention.department:
            parts.append(_answer_department(mention.department, asker))

    question = _strip_mentions(post.body).strip()

    if parts:
        # The facts come out first and cost nothing. Only if there is a real
        # question left over — "@agent @journal:X would this suit my work?"
        # rather than "@agent @journal:X" — is the model asked anything, and
        # then it is asked once, about the records already printed above.
        if len(question) >= MODEL_MIN_QUESTION:
            extra = _answer_with_model(
                question, _thread_context(post) + _mention_context(mentions, asker), asker
            )
            if extra:
                parts.append(extra)
        return "\n\n---\n\n".join(parts)

    # Nothing was mentioned alongside it, so the rest of the sentence is the
    # question.
    if len(question) < 8:
        return HELP

    # "find recent work on X" has a keyless answer that is better than a 12b
    # model's recollection of the literature, and arrives in a second rather
    # than in thirty. It keeps that answer.
    if _SEARCH_RE.search(question):
        return _answer_search(question)

    context = _thread_context(post)
    if _FIRST_PERSON_RE.search(question):
        history = _own_history(asker)
        if history:
            context = context + ["The person asking has published:", *history]
    said = _answer_with_model(question, context, asker)
    if said:
        return said

    # The model had nothing, for whatever reason `last_model_error()` now
    # holds. What this used to do is still the right thing to do, so it still
    # happens: a keyless answer beats an apology.
    return _answer_search(question)


def _strip_mentions(body: str) -> str:
    from core.discussions import MENTION_RE

    return MENTION_RE.sub("", body or "")
