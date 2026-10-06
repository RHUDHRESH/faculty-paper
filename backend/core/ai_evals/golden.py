"""Golden cases: ordinary inputs, and a model that misses the shape.

Each feature declares, once, what it really gets and what a good answer looks
like (``register_eval``). Both this file and ``redteam.py`` build their cases
from that declaration, so a feature that registers here is attacked in every
way the red-team set knows with no further work. A feature added in its own
module registers from ``core/ai_evals/features_<name>.py``, which
``ai_evals.load_features`` imports on its own.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from core.ai_evals import Case
from core.services import ai
from core.services import ai_harness as harness


@dataclass
class FeatureEval:
    """What the evals need to know about one feature."""

    feature: str
    #: The data block that takes free text from a person or a document: where
    #: an attack goes.
    slot: str
    #: The inputs the feature really gets: ``(label, text)`` per data block.
    blocks: list[tuple[str, Any]]
    #: A reply a well-behaved model would give, in the feature's own shape.
    benign: Any
    #: Per-call guards, as the feature passes them (ids the server supplied).
    guards: Callable[[], list] | None = None
    #: A second block that carries other people's words (a colleague's post).
    indirect_slot: str | None = None
    #: The module that defines the feature, imported before the evals run.
    module: str = ""
    #: True when the slot is a person's own typed question, not a document.
    direct: bool = False
    #: Who asks, for the role guards (a staff-only feature is not asked as a faculty member).
    role: str = "FACULTY"


EVALS: dict[str, FeatureEval] = {}


def register_eval(
    feature: str,
    *,
    slot: str,
    blocks: list[tuple[str, Any]],
    benign: Any,
    guards: Callable[[], list] | None = None,
    indirect_slot: str | None = None,
    module: str = "",
    direct: bool = False,
    role: str = "FACULTY",
) -> FeatureEval:
    EVALS[feature] = FeatureEval(feature, slot, blocks, benign, guards, indirect_slot, module, direct, role)
    return EVALS[feature]


def blocks_for(feature: str, injected: str | None = None, *, slot: str | None = None) -> list[tuple[str, Any]]:
    """The feature's inputs, with ``injected`` swapped into ``slot`` (default: the usual one)."""
    spec = EVALS[feature]
    if injected is None:
        return list(spec.blocks)
    target = slot or spec.slot
    return [(label, injected if label == target else text) for label, text in spec.blocks]


def guards_for(feature: str):
    return EVALS[feature].guards


# --------------------------------------------------------------------------- #
# The features that are on the harness today                                  #
# --------------------------------------------------------------------------- #

_SCOUT_RECORD = json.dumps(
    {"name": "Dr Eval", "department": "ECE", "papers": 4, "topics": ["Edge Computing"], "venues": ["IEEE Access"]}
)
_SCOUT_CANDIDATES = json.dumps(
    [{"user_id": "u1", "name": "R Kumar", "department": "CSE", "shared_topics": ["Edge Computing"], "their_topics": ["Blockchain"]}]
)


def scout_guards() -> list:
    """What `scout.scout` adds per call: the candidates it handed over, the links its search returned."""
    return [
        harness.grounded_ids(["u1"], keys=("user_id",)),
        harness.no_urls_except(["https://a.org/call"]),
    ]


register_eval(
    "discover.venues", slot="abstract", module="core.services.discover",
    blocks=[
        ("paper title", "A Study of Photovoltaic Array Fault Detection"),
        ("abstract", "We detect faults in rooftop photovoltaic arrays from inverter logs using a small neural network."),
        ("keywords", "solar, fault detection, inverter"),
    ],
    benign={"journals": [
        {"title": "Solar Energy", "why": "Covers photovoltaic arrays and their faults."},
        {"title": "Applied Energy", "why": "Fits the systems angle of the work."},
    ]},
)
register_eval(
    "discover.directions", slot="recent publications", module="core.services.discover",
    blocks=[
        ("recent publications", "- Fault detection in PV arrays (Solar Energy, 2024)\n- Inverter log mining (IEEE Access, 2023)"),
        ("domains of interest", "Energy systems"),
    ],
    benign={"directions": [
        {"topic": "Early fault detection in PV strings", "why": "Builds on your array work.",
         "first_step": "Collect a month of inverter logs from one array."},
    ]},
)
register_eval(
    "suggestions.partners", slot="recent papers", module="core.services.suggestions",
    blocks=[
        ("recent papers", "- Fault detection in PV arrays\n- Inverter log mining"),
        ("subject areas they publish in", "Renewable energy"),
        ("domains they follow", "Smart grids"),
    ],
    benign={"partners": [
        {"name": "Bharat Heavy Electricals Limited", "kind": "company", "why": "Builds power equipment.",
         "first_step": "Write to their R&D office about field data."},
    ]},
)
register_eval(
    "trends.openings", slot="recent papers", module="core.services.trends",
    blocks=[
        ("recent papers", "- Fault detection in PV arrays (2024)"),
        ("subject areas they publish in", "Renewable energy"),
        ("domains they follow", "Smart grids"),
        ("areas growing across this college", "Edge computing"),
        ("colleagues here publishing nearby", "R Kumar, S Rao"),
    ],
    benign={"openings": [
        {"topic": "Edge scheduling for inverters", "why": "Extends your fault detection work.",
         "first_step": "Re-run the benchmark on a small board.", "area": "Renewable energy", "with_whom": "R Kumar"},
    ]},
)
register_eval(
    "thread.answer", slot="the question", module="core.services.thread_agent", direct=True,
    indirect_slot="what we hold, and what has been said",
    blocks=[
        ("what we hold, and what has been said", "Paper 'Fault detection in PV arrays' (Solar Energy, 2024)."),
        ("the question", "would that venue suit the direction I have been working in?"),
    ],
    benign={
        "answer": "That direction builds on the fault detection work you have already published.",
        "journals": ["Solar Energy"],
    },
)
register_eval(
    "scout.research", slot="faculty member's record", module="core.services.scout", guards=scout_guards,
    blocks=[
        ("faculty member's record", _SCOUT_RECORD),
        ("colleagues in other departments", _SCOUT_CANDIDATES),
    ],
    benign={
        "summary": "Edge computing for energy systems is a good next step.",
        "opportunities": [{"title": "A real call", "kind": "call", "why": "Fits their work.", "url": "https://a.org/call"}],
        "directions": [{"title": "Edge fault detection", "builds_on": "PV fault paper", "why": "Natural next step.", "urls": []}],
        "external_people": [],
        "colleagues": [{"user_id": "u1", "why": "Edge and ledger work could combine."}],
    },
)


def _benign(feature: str) -> Any:
    return EVALS[feature].benign


def _case(cid: str, feature: str, category: str, replies: list[Any], asserts: list[tuple], **kw) -> Case:
    blocks = kw.pop("blocks", None)
    return Case(
        id=cid, feature=feature, category=category,
        blocks=blocks if blocks is not None else blocks_for(feature),
        replies=replies, asserts=asserts,
        guards=kw.pop("guards", guards_for(feature)), **kw,
    )


# --------------------------------------------------------------------------- #
# The cases                                                                   #
# --------------------------------------------------------------------------- #


def cases() -> list[Case]:
    out: list[Case] = []

    # Every registered feature: an ordinary input, an ordinary good answer.
    for feature, spec in EVALS.items():
        out.append(_case(f"golden-{feature}", feature, "golden", [spec.benign],
                         [("ok",), ("calls", 1), ("one_fence_token",), ("no_pii",)]))

    # -- discover.venues: the shapes a small model produces -------------------
    v = "discover.venues"
    out += [
        _case("venues-bare-list", v, "golden", [_benign(v)["journals"]],
              [("ok",), ("path_len_min", "journals", 2), ("offline:notes", "bare list")]),
        _case("venues-junk-entries-dropped", v, "golden",
              [{"journals": ["just a string", None, {"title": "Solar Energy", "why": "fits"}, 7]}],
              [("ok",), ("path_len_max", "journals", 1), ("path_len_min", "journals", 1)]),
        _case("venues-missing-why-is-kept", v, "golden", [{"journals": [{"title": "Solar Energy"}]}],
              [("ok",), ("path_equals", "journals.0.why", "")]),
        _case("venues-too-many-capped", v, "golden",
              [{"journals": [{"title": f"Journal {i}", "why": "x"} for i in range(30)]}],
              [("ok",), ("path_len_max", "journals", 12)]),
        _case("venues-long-text-shortened", v, "golden",
              [{"journals": [{"title": "Solar Energy", "why": "word " * 400}]}],
              [("ok",), ("not_matches", r"(word ){90}")]),
        _case("venues-fenced-json-text", v, "golden",
              ['```json\n{"journals": [{"title": "Solar Energy", "why": "fits"}]}\n```'],
              [("ok",), ("path_len_min", "journals", 1)]),
    ]

    # -- the shape is wrong: ask again, then give up cleanly -------------------
    out += [
        _case("shape-reasked-once-and-fixed", v, "shape", [{"foo": 1}, _benign(v)],
              [("ok",), ("calls", 2), ("offline:prompt_contains", "Problems found"), ("offline:prompt_contains", "$.journals")]),
        _case("shape-never-valid-fails-cleanly", v, "shape", [{"foo": 1}],
              [("failed", "invalid"), ("calls", 2)]),
        _case("shape-prose-then-json", v, "shape", ["Sure, here are some journals for you!", _benign(v)],
              [("ok",), ("calls", 2), ("offline:prompt_contains", "not valid JSON")]),
        _case("shape-never-parses-fails-cleanly", v, "shape", ["I cannot do that."],
              [("failed", "unparsable"), ("calls", 2)]),
        _case("shape-a-number-where-text-was-asked", "discover.directions", "shape",
              [{"directions": [{"topic": 5, "why": "ok"}]}],
              [("ok",), ("path_equals", "directions.0.topic", "5")]),
        _case("shape-provider-down-is-a-value", v, "shape", [ai.AIError("Nothing is answering at api.groq.com.", code="unreachable")],
              [("failed", "unreachable"), ("offline:calls", 3)]),
        _case("shape-timeout-is-not-retried", v, "shape", [ai.AIError("It took too long.", code="timeout")],
              [("failed", "timeout"), ("offline:calls", 1)]),
        _case("shape-crashing-transport-is-a-value", v, "shape", [RuntimeError("boom")],
              [("failed", "error"), ("offline:calls", 1)]),
    ]

    # -- the thread answer ---------------------------------------------------------
    t = "thread.answer"
    out += [
        _case("thread-bare-string", t, "golden", ["It is a reasonable fit for that kind of work."],
              [("ok",), ("contains", "reasonable fit")]),
        _case("thread-journals-capped", t, "golden",
              [{"answer": "Look at these.", "journals": [f"Journal {i}" for i in range(20)]}],
              [("ok",), ("path_len_max", "journals", 6)]),
        _case("thread-money-sentence-removed", t, "golden",
              [{"answer": "Expect roughly 1.5 lakh for that. It is a strong venue.", "journals": []}],
              [("ok",), ("not_contains", "lakh"), ("contains", "strong venue")]),
    ]

    # -- the scout ---------------------------------------------------------------------
    s = "scout.research"
    out += [
        _case("scout-keeps-known-colleague-only", s, "hallucination",
              [{**_benign(s), "colleagues": [{"user_id": "u1", "why": "ok"}, {"user_id": "u-invented", "why": "no"}]}],
              [("ok",), ("path_len_max", "colleagues", 1), ("not_contains", "u-invented")]),
        _case("scout-link-not-searched-is-removed", s, "hallucination",
              [{**_benign(s), "opportunities": [
                  {"title": "Real", "url": "https://a.org/call", "why": "x"},
                  {"title": "Made up", "url": "https://fake.example/x", "why": "see https://fake.example/y"}]}],
              [("ok",), ("contains", "https://a.org/call"), ("not_contains", "fake.example")]),
        _case("scout-no-second-search-on-a-bad-shape", s, "shape", ["not json at all"],
              [("failed", "unparsable"), ("calls", 1)]),
    ]
    return out
