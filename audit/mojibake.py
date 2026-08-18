"""Find text that was UTF-8, read as cp1252, and written back out.

A rupee sign becomes "â‚¹", an arrow becomes "â†'", an em dash becomes
"â€”". Each is a run of Latin-1 characters that decodes cleanly back to
sensible UTF-8 -- which is exactly the test used here, so the scan catches
sequences nobody thought to grep for.
"""
import pathlib
import re
import sys

SUFFIXES = {".ts", ".tsx", ".css", ".py", ".mjs", ".md", ".json", ".html"}
# The audit directory is skipped: this scanner and audit.mjs both carry
# deliberate mojibake samples so they can recognise it.
ROOTS = ["frontend/src", "backend/core", "e2e"]

# Mojibake always starts with one of these lead bytes seen as cp1252.
LEAD = "ÂÃâ"
RUN = re.compile("[" + LEAD + "][-ÿ‐-›€™]{1,2}")


def main(fix: bool) -> int:
    total = 0
    for root in ROOTS:
        for f in pathlib.Path(root).rglob("*"):
            if f.suffix not in SUFFIXES or "node_modules" in f.parts:
                continue
            text = f.read_text(encoding="utf-8")
            found = []
            for m in RUN.finditer(text):
                raw = m.group(0)
                try:
                    better = raw.encode("cp1252").decode("utf-8")
                except (UnicodeEncodeError, UnicodeDecodeError):
                    continue
                found.append((raw, better))
            if not found:
                continue
            seen = set()
            for raw, better in found:
                if raw in seen:
                    continue
                seen.add(raw)
                total += text.count(raw)
                print(f"{f}: {raw!r} -> {better!r}  x{text.count(raw)}")
                if fix:
                    text = text.replace(raw, better)
            if fix:
                f.write_text(text, encoding="utf-8", newline="")
    print(f"\n{total} occurrence(s)")
    return total


if __name__ == "__main__":
    main("--fix" in sys.argv)
