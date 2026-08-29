"""One-shot migration: split backend/core/api.py into the core.api package.

Reads the single 11k-line module, cuts it at its section banners, writes one
module per section into backend/core/api/, and leaves core/api/__init__.py as
the composition root. Every section body is moved VERBATIM -- the script only
generates docstrings, import blocks and __all__ lists.

Rules the split preserves:
  * Route registration order == original source order, because __init__.py
    star-imports the modules in the order the sections appeared. django-ninja
    resolves routes in registration order, so reordering these imports would
    change which endpoint a path matches.
  * A name defined in more than one section is imported from the LAST section
    that defines it -- the single-module behaviour, since function bodies bind
    names late and see the final definition.
  * A name defined in section A but used in section B becomes an explicit
    import in B. If that creates an import cycle, the shared definitions are
    relocated into common.py (never an @api-decorated endpoint -- endpoints
    are not imported across modules, and moving one would change the order).

Run from the repo root:  python scripts/split_api.py
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "backend" / "core" / "api.py"
OUT = ROOT / "backend" / "core" / "api"
PKG = "core.api"

# Section boundaries as (start_line, end_line, module_name, title). Line
# numbers are 1-based, inclusive, and were read off the banner layout of the
# file this script was written against; the assertions below check them.
SECTIONS = [
    (1, 325, "common", "shared setup: the NinjaAPI instance, logging, exception handlers"),
    (326, 857, "schemas", "request and response schemas"),
    (858, 1167, "deps", "the auth dependency, and the endpoints reachable while a password change is owed"),
    (1168, 1608, "auth", "sign-in, sessions, passwords"),
    (1609, 1774, "profile_requests", "the queue profile-correction requests land in"),
    (1775, 2173, "lookups", "lookups"),
    (2174, 2436, "teams", "student project teams"),
    (2437, 2821, "claims", "claims"),
    (2822, 3883, "journals", "journals, and the retired chain kept for old clients"),
    (3884, 4652, "director", "the director: authorising what the principal approved"),
    (4653, 5720, "dashboard", "dashboards"),
    (5721, 6128, "discussions", "notifications and discussions"),
    (6129, 6345, "calendar", "the calendar"),
    (6346, 6670, "notes", "notes on a ticket, and lookup"),
    (6671, 6888, "accreditation", "the accreditation rows, and correcting them"),
    (6889, 7124, "data_removal", "removing rows, and emptying the system"),
    (7125, 7322, "collaborate", "who has worked with whom"),
    (7323, 8094, "discover", "what to write next, and where to send it"),
    (8095, 8851, "hod", "head of department"),
    (8852, 9201, "data_explorer", "data explorer"),
    (9202, 9383, "budget", "budget"),
    (9384, 9499, "duplicates", "duplicate findings"),
    (9500, 9691, "superadmin", "super-admin powers"),
    (9692, 9863, "operations", "operations: what is wrong right now"),
    (9864, 10568, "admin", "admin"),
    (10569, 10899, "masters", "process queue, SNIP and faculty master"),
    (10900, 11170, "finance", "finance ledger and monthly batches"),
]

FUTURE = "from __future__ import annotations"


def main() -> None:
    text = SRC.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    tree = ast.parse(text)

    # --- check the boundaries still match the file -------------------------
    for start, _end, _mod, _title in SECTIONS[1:]:
        line = lines[start - 1].lstrip()
        assert line.startswith("#"), f"line {start} is not a section comment: {lines[start - 1]!r}"

    # --- external import map: name -> (import line, statement order) -------
    externals: dict[str, tuple[str, int]] = {}
    for order, node in enumerate(tree.body):
        if isinstance(node, ast.Import):
            src = f"import {', '.join(_import_clause(node))}"
            for alias in node.names:
                externals[alias.asname or alias.name.split(".")[0]] = (src, order)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            if node.module == "__future__":
                continue
            names = [a.name for a in node.names]
            src = f"from {node.module} import {', '.join(names)}"
            for a in node.names:
                externals[a.asname or a.name] = (src, order)

    # --- per-section: body text, defined names, used names -----------------
    all_defined: set[str] = set()
    mods: list[dict] = []
    for start, end, mod, title in SECTIONS:
        body = "".join(lines[start - 1 : end])
        seg_tree = ast.parse(body)
        defined = _defined_names(seg_tree)
        all_defined |= defined
        mods.append(
            {
                "name": mod,
                "title": title,
                "body": body,
                "tree": seg_tree,
                "defined": defined,
                "relocated_in": [],
            }
        )

    known = all_defined | set(externals)

    # first pass of used-name analysis, before any relocation
    for m in mods:
        m["used"] = _used_names(m["tree"], known)

    # --- force every cross-module import to point BACKWARD -----------------
    # __init__.py imports the modules in section order, and that import order
    # is what route registration order must follow. But a module's own imports
    # run first: if an early section imports a name defined in a later one,
    # Python loads the later module early and its routes register out of
    # order. So every forward edge is eliminated by relocating the needed
    # definitions into common (which nothing can be "ahead of"). This also
    # breaks any import cycle, since a cycle necessarily contains a forward
    # edge.
    to_common: set[str] = set()
    order_index = {m["name"]: i for i, m in enumerate(mods)}
    for _round in range(40):
        definer = {}
        for m in mods:
            for n in sorted(m["defined"] - to_common):
                definer[n] = m  # later modules overwrite earlier ones
        forward: list[tuple[str, str, set[str]]] = []
        for m in mods:
            if m["name"] == "common":
                m["imports_from"] = {}
                continue
            imp: dict[str, set[str]] = {}
            for n in m["used"]:
                if n in to_common or n in m["defined"]:
                    continue
                src_mod = definer.get(n)
                if src_mod is not None and src_mod is not m:
                    imp.setdefault(src_mod["name"], set()).add(n)
            m["imports_from"] = imp
            for src_mod_name, names in imp.items():
                if order_index[src_mod_name] > order_index[m["name"]]:
                    forward.append((m["name"], src_mod_name, names))
        if not forward:
            break
        moved = False
        for a, b, names in forward:
            print(f"forward edge {a} -> {b}: relocating {', '.join(sorted(names))}")
            for n in names:
                if _is_endpoint(mods, n):
                    sys.exit(f"cannot relocate {n}: it is an endpoint")
                to_common.add(n)
                moved = True
        if not moved:
            sys.exit("no progress breaking forward edges")
    else:
        sys.exit("forward-edge elimination did not converge")

    # --- move relocated sources out of their modules, into common ----------
    relocated_src: list[str] = []
    if to_common:
        owner_lines: dict[str, list[str]] = {}
        for m in mods:
            for node, n in _top_level_named_nodes(m["tree"]):
                # a name defined twice binds to its LAST definition, so that
                # is the source relocation must carry into common
                if n in to_common:
                    owner_lines[n] = _node_source(body_lines(m["body"]), node)
        seen: set[str] = set()
        for m in mods:  # keep original definition order
            for n in _definition_order(m["tree"]):
                if n in to_common and n not in seen and n in owner_lines:
                    relocated_src.extend(owner_lines[n])
                    seen.add(n)
        for m in mods:
            if m["defined"] & to_common:
                m["body"] = _strip_defs(m["body"], m["tree"], to_common)
                m["defined"] = m["defined"] - to_common
    mods[0]["relocated_in"] = sorted(to_common)

    # --- emit --------------------------------------------------------------
    OUT.mkdir(exist_ok=True)
    order = [m["name"] for m in mods]
    for m in mods:
        path = OUT / f"{m['name']}.py"
        parts: list[str] = []
        parts.append(
            f'"""{m["title"]}.\n'
            "\n"
            "Moved verbatim from the former single-module core/api.py; the\n"
            "import order in core/api/__init__.py fixes route registration\n"
            'order and must not be casually reordered.\n"""\n\n'
        )
        parts.append(FUTURE + "\n\n")
        if m["name"] != "common":
            for src_mod in order:
                names = sorted(m["imports_from"].get(src_mod, set()))
                if names:
                    parts.append(f"from {PKG}.{src_mod} import {', '.join(names)}\n")
            if m["imports_from"]:
                parts.append("\n")
            parts.append(_external_imports(m["used"], externals))
        body = m["body"]
        if m["name"] == "common":
            if body.startswith(FUTURE):
                body = body[len(FUTURE) :].lstrip("\n")
            parts.append(body)
            if relocated_src:
                parts.append(
                    "\n\n# Definitions shared by several sections below, relocated here so the\n"
                    "# package stays importable (they would otherwise make two sections\n"
                    "# import each other).\n\n"
                )
                parts.append("".join(relocated_src))
        else:
            parts.append(body)
        names = sorted(m["defined"] | set(m["relocated_in"]))
        if names:
            rendered = "".join(f"    {n!r},\n" for n in names)
            parts.append(f"\n\n__all__ = [\n{rendered}]\n")
        path.write_text("".join(parts), encoding="utf-8")
        print(f"{path.relative_to(ROOT)}: {len(''.join(parts).splitlines())} lines, "
              f"{len(names)} names, imports from {len(m['imports_from'])} siblings")

    init_doc = (
        '"""The API package: one module per section of the former core/api.py.\n\n'
        "The star imports below run in the order the sections appeared in the\n"
        "original file, and that order is what decides route registration\n"
        "order -- django-ninja resolves the first matching path, so sections\n"
        "registered earlier win. Do not reorder these imports without\n"
        "re-checking the route table (scripts/dump_routes.py).\n\n"
        "Every public and private name of every module is re-exported here so\n"
        '`from core.api import anything` keeps working for callers and tests.\n"""\n\n'
    )
    init = [init_doc, FUTURE + "\n\n"]
    for m in mods:
        init.append(f"from {PKG}.{m['name']} import *  # noqa: F401,F403\n")
    (OUT / "__init__.py").write_text("".join(init), encoding="utf-8")
    print(f"{OUT / '__init__.py'} written")

    SRC.unlink()
    print("removed backend/core/api.py")


# ---------------------------------------------------------------------------


def _import_clause(node: ast.Import) -> list[str]:
    out = []
    for a in node.names:
        out.append(a.name if a.asname is None else f"{a.name} as {a.asname}")
    return out


def _defined_names(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in _top_level_named_nodes(tree):
        names.add(node[1])
    return names


def _definition_order(tree: ast.Module) -> list[str]:
    return [name for _node, name in _top_level_named_nodes(tree)]


def _top_level_named_nodes(tree: ast.Module) -> list[tuple[ast.stmt, str]]:
    out: list[tuple[ast.stmt, str]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.append((node, node.name))
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out.append((node, t.id))
                elif isinstance(t, ast.Tuple):
                    for e in t.elts:
                        if isinstance(e, ast.Name):
                            out.append((node, e.id))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            out.append((node, node.target.id))
    return out


def _used_names(tree: ast.Module, known: set[str]) -> set[str]:
    used: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            used.add(node.id)
        elif isinstance(node, ast.Attribute):
            n: ast.AST = node
            while isinstance(n, ast.Attribute):
                n = n.value
            if isinstance(n, ast.Name):
                used.add(n.id)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            for word in re.findall(r"\w+", node.value):
                if word in known:
                    used.add(word)
    return used & known


def _is_endpoint(mods: list[dict], name: str) -> bool:
    for m in mods:
        for node, n in _top_level_named_nodes(m["tree"]):
            if n == name and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for dec in node.decorator_list:
                    if "api" in ast.dump(dec):
                        return True
    return False


def _find_cycle(graph: list[dict], names: list[str]) -> list[str] | None:
    index = {n: i for i, n in enumerate(names)}
    state = [0] * len(names)
    stack: list[str] = []

    def dfs(u: int) -> list[str] | None:
        state[u] = 1
        stack.append(names[u])
        for v in graph[u]:
            j = index[v]
            if state[j] == 1:
                return stack[stack.index(v):]
            if state[j] == 0:
                found = dfs(j)
                if found:
                    return found
        stack.pop()
        state[u] = 2
        return None

    for i in range(len(names)):
        if state[i] == 0:
            found = dfs(i)
            if found:
                return found
    return None


def _node_source(lines: list[str], node: ast.stmt) -> list[str]:
    return lines[node.lineno - 1 : node.end_lineno]


def body_lines(body: str) -> list[str]:
    return body.splitlines(keepends=True)


def _strip_defs(body: str, tree: ast.Module, drop: set[str]) -> str:
    lines = body.splitlines(keepends=True)
    drop_ranges = [
        (node.lineno - 1, node.end_lineno)
        for node, name in _top_level_named_nodes(tree)
        if name in drop
    ]
    for a, b in drop_ranges:
        for i in range(a, b):
            lines[i] = ""
    return "".join(lines)


def _external_imports(used: set[str], externals: dict[str, tuple[str, int]]) -> str:
    wanted = sorted({externals[n] for n in used if n in externals}, key=lambda t: t[1])
    out: list[str] = []
    for src, _ in wanted:
        module, _, names = _parse_import(src)
        keep = sorted(n for n in names if n in used)
        if len(names) == len(keep) or not names:
            out.append(src)
        elif keep:
            out.append(f"from {module} import {', '.join(keep)}")
        # nothing kept: drop the statement entirely
    return "".join(line + "\n" for line in out) + ("\n" if out else "")


def _parse_import(src: str) -> tuple[str, str, set[str]]:
    tree = ast.parse(src)
    node = tree.body[0]
    assert isinstance(node, (ast.Import, ast.ImportFrom))
    if isinstance(node, ast.Import):
        return "", src, {a.asname or a.name for a in node.names}
    return node.module or "", src, {a.asname or a.name for a in node.names}


if __name__ == "__main__":
    main()
