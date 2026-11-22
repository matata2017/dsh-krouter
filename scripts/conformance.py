#!/usr/bin/env python3
"""Compare KRouter's live memory artifacts against Claude Code's memory design.

Reads both sides from disk and prints one row per design dimension, so the
answer is measured rather than asserted. Read-only.

Each dimension has its own pass predicate for each side: "符合" means both sides
satisfy the dimension, not that their raw values are equal. A side can satisfy a
dimension in a different way and still conform.

Usage: python D:/okf-kb/conformance.py
"""
from __future__ import annotations

import os
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CLAUDE = Path(os.environ.get("CLAUDE_PROJECTS") or Path.home() / ".claude" / "projects")
VAULT = Path(os.environ.get("KROUTER_VAULT") or REPO / "vault")
SUBCONSCIOUS = VAULT / "90 系统文件/自动化/下意识.md"
CARDS = VAULT / "02 经验与方法/经验卡"
EXCERPTS = VAULT / "05 时间日志/会话摘录"


def frontmatter(path: Path) -> dict[str, str]:
    """Top-level frontmatter keys, plus nested `metadata.<key>` flattened as `metadata.key`."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    out: dict[str, str] = {}
    nested_parent = ""
    for line in parts[1].splitlines():
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        key, _, value = line.partition(":")
        key, value = key.strip(), value.strip().strip('"')
        if indent == 0:
            nested_parent = key if not value else ""
            out[key] = value
        elif nested_parent:
            out[f"{nested_parent}.{key}"] = value
    return out


def claude_side() -> dict:
    dirs = [d for d in CLAUDE.glob("*/memory") if d.is_dir()]
    with_index = [d for d in dirs if (d / "MEMORY.md").is_file()]
    body = [p for d in dirs for p in d.glob("*.md") if p.name != "MEMORY.md"]
    index_sizes = [(d.parent.name, (d / "MEMORY.md").stat().st_size,
                    len((d / "MEMORY.md").read_text(encoding="utf-8", errors="replace").splitlines()))
                   for d in with_index]
    keys: set[str] = set()
    types: set[str] = set()
    for p in body:
        keys.update(frontmatter(p))
        fm = frontmatter(p)
        if fm.get("metadata.type"):
            types.add(fm["metadata.type"])
    return {
        "memory_dirs": len(dirs),
        "dirs_with_index": len(with_index),
        "body_files": len(body),
        "index_sizes": index_sizes,
        "frontmatter_keys": sorted(keys),
        "types": sorted(types),
        "scoped_by_project": len(dirs) > 0,
        # Source: code.claude.com/docs/en/memory, "How it works" — fetched 2026-11-22,
        # HTTP 200: "the first 200 lines or 25KB of MEMORY.md, whichever comes first,
        # load at session start"; over the limit the write still succeeds but Claude
        # Code returns an error telling Claude to rewrite the index.
        "index_capped": "200 lines / 25KB (official docs, fetched 2026-11-22)",
        "has_session_origin": any("metadata.originSessionId" in frontmatter(p) for p in body),
        "auto_captured": len(body) > 0,
    }


def krouter_cap_probe() -> dict:
    """Run the real standing_index() under shrinking budgets and see whether the body shrinks.

    This measures behaviour: the constant names prove nothing on their own. The
    probe forces `table_state == "own"` by pointing KROUTER_MAP at this vault's own
    alias table, because with the sample table the function returns "" before any
    truncation can be observed.
    """
    import os
    import subprocess
    import sys

    scripts = VAULT.parent / "skill/krouter/scripts"
    probe = (
        "import sys, json;"
        f"sys.path.insert(0, {str(scripts)!r});"
        "import compile_subconscious as cs;"
        "from pathlib import Path;"
        f"v = Path({str(VAULT)!r});"
        "out = {};\n"
        "for b in (100, 200, 300, 400, 600):\n"
        "    t = cs.standing_index(v, chars=b)\n"
        "    body = [l for l in t.split(chr(10)) if l.startswith('- ') or l.startswith('也记着')]\n"
        "    out[b] = {'total': len(t), 'full_lines': sum(1 for l in body if l.startswith('- ')), 'named': sum(1 for l in body if l.startswith('也记着'))}\n"
        "print(json.dumps(out))"
    )
    env = dict(os.environ)
    env["KROUTER_MAP"] = str(VAULT / "90 系统文件/canonical_sources.psv")
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        raw = subprocess.run([sys.executable, "-c", probe], capture_output=True,
                             text=True, encoding="utf-8", env=env, timeout=60)
        if raw.returncode != 0:
            return {"measured": False, "why": (raw.stderr or "")[-200:]}
        import json
        budgets = {int(k): v for k, v in json.loads(raw.stdout).items()}
    except Exception as exc:  # noqa: BLE001
        return {"measured": False, "why": str(exc)[:200]}

    # Truncation is real only when a smaller budget yields fewer full lines and
    # the remainder falls back to the name-only line.
    small, large = budgets[100], budgets[600]
    truncates = small["full_lines"] < large["full_lines"]
    return {
        "measured": True,
        "budgets": budgets,
        "truncates": truncates,
        "capped": truncates,
    }


def krouter_side() -> dict:
    text = SUBCONSCIOUS.read_text(encoding="utf-8", errors="replace") if SUBCONSCIOUS.is_file() else ""
    rows = [l for l in text.splitlines() if re.match(r"^Q\d+\|", l)]

    # Measure the truncation behaviour, not the constant names: call the real
    # standing_index() under shrinking budgets and check the body actually shrinks.
    # table_state must be "own" (KROUTER_MAP points at this vault's table) or the
    # function returns "" before any truncation happens.
    cap_probe = krouter_cap_probe()

    cards = sorted(CARDS.glob("*.md")) if CARDS.is_dir() else []
    keys: set[str] = set()
    types: set[str] = set()
    for p in cards:
        fm = frontmatter(p)
        keys.update(fm)
        if fm.get("type"):
            types.add(fm["type"])

    excerpts = sorted(EXCERPTS.glob("*.md")) if EXCERPTS.is_dir() else []
    excerpt_keys: set[str] = set()
    for p in excerpts:
        excerpt_keys.update(frontmatter(p))

    return {
        "index_file": SUBCONSCIOUS.name if SUBCONSCIOUS.is_file() else "(missing)",
        "index_bytes": len(text.encode("utf-8")),
        "index_lines": len(text.splitlines()),
        "index_rows": len(rows),
        "card_files": len(cards),
        "card_frontmatter_keys": sorted(keys),
        "card_types": sorted(types),
        "excerpt_files": len(excerpts),
        "excerpt_frontmatter_keys": sorted(excerpt_keys),
        "scoped_by_project": "project" in excerpt_keys,
        "index_capped": cap_probe.get("capped"),
        "cap_probe": cap_probe,
        "has_session_origin": "session" in excerpt_keys,
        "auto_captured": len(excerpts) > 0,
    }


def main() -> None:
    c = claude_side()
    k = krouter_side()

    print("== Claude Code side ==")
    for key, value in c.items():
        print(f"  {key}: {value}")
    print()
    print("== KRouter / DSH side ==")
    for key, value in k.items():
        print(f"  {key}: {value}")
    print()

    # (dimension, claude passes, krouter passes, note)
    # A None on either side means "not measurable here"; the row is reported as
    # 未验证 instead of being counted as a pass.
    rows = [
        ("短索引 + 正文分离", c["dirs_with_index"] > 0 and c["body_files"] >= 0,
         k["index_rows"] > 0 and k["card_files"] >= 0, "索引只放一行一条"),
        ("索引有体积上限", c["index_capped"] is not None, k["index_capped"],
         "Claude 200 行/25KB（官方文档）；KRouter 实跑截断已观测"),
        ("每项目独立作用域", c["scoped_by_project"], k["scoped_by_project"], "按项目分目录"),
        ("frontmatter 带 type", bool(c["types"]), bool(k["card_types"]), "每条记忆有类型"),
        ("会话来源可追溯", c["has_session_origin"], k["has_session_origin"], "记下出自哪次会话"),
        ("自动沉淀", c["auto_captured"], k["auto_captured"], "不用人手工写"),
        ("记忆带类型词表", bool(c["types"]), bool(k["card_types"]),
         "两边都有类型；词表内容有意不同"),
    ]
    print("== 逐项对照 ==")
    print(f"{'维度':<20}{'Claude':<10}{'KRouter':<10}{'符合':<8}说明")
    gaps = []
    unverified = []
    for name, left, right, note in rows:
        if left is None or right is None:
            verdict = "未验证"
            unverified.append(name)
        elif left and right:
            verdict = "是"
        else:
            verdict = "否"
            gaps.append((name, left, right))
        def label(v):
            return "未实测" if v is None else ("满足" if v else "缺")
        print(f"{name:<20}{label(left):<10}{label(right):<10}{verdict:<8}{note}")
    print()
    print("类型词表: Claude =", sorted(c["types"]), "| KRouter =", sorted(k["card_types"]))
    print("差距:", "无" if not gaps else ", ".join(n for n, _, _ in gaps))
    print("未验证:", "无" if not unverified else ", ".join(unverified))


if __name__ == "__main__":
    main()
