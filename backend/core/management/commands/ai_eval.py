"""Run the AI evals and write docs/jtbd/ai-evals.md.

    manage.py ai_eval                 offline: a stand-in model, nothing sent anywhere
    manage.py ai_eval --live          the configured provider (spends calls on the key)
    manage.py ai_eval --only bola     one category, feature or case id
    manage.py ai_eval --no-write      print only

Offline is what CI runs (``core/test_ai_harness.py``). Live is for a person
changing a prompt, a model or a provider: it asks the real model the same
questions and applies the assertions marked ``live:``.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core import ai_evals

START = "<!-- ai-harness:start -->"
END = "<!-- ai-harness:end -->"

HEADER = """# AI evals

Every AI feature is tested the same way: golden inputs, a model that misses
the shape, and the attacks in promptfoo's red-team catalogue (prompt
injection, indirect injection through documents, prompt extraction, hidden
Unicode, personal data, object and function level access, role leaks, claims
of acting, invented ids and links, markup in answers, oversized inputs).

Run them: `python manage.py ai_eval` (offline, a stand-in model, nothing is
sent anywhere) or `python manage.py ai_eval --live` (the configured provider).
Offline is part of the test suite (`core/test_ai_harness.py`). How to add cases
for a new feature: `docs/ops/ai-harness.md`.

Other features keep their own sections below the harness's.
"""


def _rate(done: int, total: int) -> str:
    return f"{done}/{total} ({(100.0 * done / total) if total else 100.0:.1f}%)"


def _section(results, summary, *, live: bool) -> str:
    mode = "live, against the configured provider" if live else "offline, with a stand-in model"
    lines = [
        START,
        "",
        "## Harness evals (`core/ai_evals`)",
        "",
        f"Last run: {date.today().isoformat()}, {mode}. Pass rate **{_rate(*summary['overall'])}**.",
        "",
        "| Category | What it tries | Passed |",
        "|---|---|---|",
    ]
    for key, text in ai_evals.CATEGORIES.items():
        if key in summary["by_category"]:
            lines.append(f"| {key} | {text} | {_rate(*summary['by_category'][key])} |")
    lines += ["", "| Feature | Passed |", "|---|---|"]
    for key, value in sorted(summary["by_feature"].items()):
        lines.append(f"| `{key}` | {_rate(*value)} |")
    if summary["failed"]:
        lines += ["", "### Failing", ""]
        for r in summary["failed"]:
            lines.append(f"- `{r.case.id}` ({r.case.category}): " + "; ".join(r.failures))
    lines += ["", "### Cases", ""]
    by_cat: dict[str, list[str]] = {}
    for r in results:
        by_cat.setdefault(r.case.category, []).append(r.case.id)
    for cat, ids in by_cat.items():
        shown = ids if len(ids) <= 12 else ids[:6]
        more = f", and {len(ids) - len(shown)} more of the same shapes" if len(shown) < len(ids) else ""
        lines.append(f"- **{cat}** ({len(ids)}): " + ", ".join(f"`{i}`" for i in shown) + more)
    lines += ["", END, ""]
    return "\n".join(lines)


def write_docs(path: Path, section: str) -> None:
    """Replace the harness's section of the file, keeping everybody else's."""
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if START in existing and END in existing:
        head, rest = existing.split(START, 1)
        _old, tail = rest.split(END, 1)
        text = head + section.rstrip("\n") + tail
    elif existing.strip():
        text = existing.rstrip("\n") + "\n\n" + section
    else:
        text = HEADER + "\n" + section
    path.write_text(text, encoding="utf-8")


class Command(BaseCommand):
    help = "Run the AI evals (offline by default) and write docs/jtbd/ai-evals.md."

    def add_arguments(self, parser):
        parser.add_argument("--live", action="store_true", help="Ask the configured provider instead of the stand-in model.")
        parser.add_argument("--only", default=None, help="A category, a feature name, or part of a case id.")
        parser.add_argument("--no-write", action="store_true", help="Do not write docs/jtbd/ai-evals.md.")
        parser.add_argument("--out", default=None, help="Where to write the report (default docs/jtbd/ai-evals.md).")
        parser.add_argument("--fail-under", type=float, default=100.0, help="Exit non-zero below this pass rate (default 100).")

    def handle(self, *args, **options):
        live = options["live"]
        if live:
            ready, why = ai_evals.live_ready()
            if not ready:
                raise CommandError(f"A live run needs the AI to be on. {why}")
            self.stdout.write("Live run: every case is a real call on the configured key.")
        results = ai_evals.run_all(live=live, only=options["only"])
        if not results:
            raise CommandError("No case matched.")
        summary = ai_evals.summarise(results)
        done, total = summary["overall"]

        self.stdout.write(f"AI evals ({'live' if live else 'offline'}): {total} cases")
        for key, (d, t) in summary["by_category"].items():
            self.stdout.write(f"  {key:<28} {d:>3}/{t:<3}")
        for r in summary["failed"]:
            self.stdout.write(self.style.ERROR(f"  FAIL {r.case.id} [{r.case.category}]"))
            for problem in r.failures:
                self.stdout.write(f"       {problem}")
        rate = 100.0 * done / total
        self.stdout.write(f"Pass rate: {_rate(done, total)}")

        if not options["no_write"]:
            path = Path(options["out"]) if options["out"] else Path(settings.BASE_DIR).parent / "docs" / "jtbd" / "ai-evals.md"
            write_docs(path, _section(results, summary, live=live))
            self.stdout.write(f"Wrote {path}")
        if rate < options["fail_under"]:
            raise CommandError(f"Pass rate {rate:.1f}% is under {options['fail_under']:.1f}%.")
