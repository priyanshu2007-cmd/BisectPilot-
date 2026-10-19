from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

_TS_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b")
_UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_VALID_KINDS = {"prompt", "tool", "model", "result"}


def sanitize_run_id(raw_id: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", raw_id).strip("-")
    return cleaned or "run-specimen"


def canonicalize(text: str, raw_mode: bool = False) -> str:
    if raw_mode:
        return text
    stripped = text.strip()
    if stripped.startswith(("{", "[")):
        try:
            parsed = json.loads(stripped)
            stripped = json.dumps(parsed, indent=2, sort_keys=True)
        except ValueError:
            pass
    stripped = _TS_RE.sub("<TS>", stripped)
    return _UUID_RE.sub("<UUID>", stripped)


def _sig(turn: dict[str, Any] | None) -> tuple[str, str]:
    if not turn:
        return ("", "")
    kind = str(turn.get("kind", "prompt"))
    return (kind if kind in _VALID_KINDS else "prompt", str(turn.get("label", "")))


def align_turns(
    base: list[dict[str, Any]], curr: list[dict[str, Any]]
) -> list[tuple[dict[str, Any] | None, dict[str, Any] | None]]:
    pairs: list[tuple[dict[str, Any] | None, dict[str, Any] | None]] = []
    i, j = 0, 0
    while i < len(base) and j < len(curr):
        if _sig(base[i]) == _sig(curr[j]):
            pairs.append((base[i], curr[j]))
            i += 1
            j += 1
        elif j + 1 < len(curr) and _sig(base[i]) == _sig(curr[j + 1]):
            pairs.append((None, curr[j]))
            j += 1
        elif i + 1 < len(base) and _sig(base[i + 1]) == _sig(curr[j]):
            pairs.append((base[i], None))
            i += 1
        elif j + 2 < len(curr) and _sig(base[i]) == _sig(curr[j + 2]):
            pairs.extend([(None, curr[j]), (None, curr[j + 1])])
            j += 2
        elif i + 2 < len(base) and _sig(base[i + 2]) == _sig(curr[j]):
            pairs.extend([(base[i], None), (base[i + 1], None)])
            i += 2
        else:
            pairs.append((base[i], curr[j]))
            i += 1
            j += 1
    while i < len(base):
        pairs.append((base[i], None))
        i += 1
    while j < len(curr):
        pairs.append((None, curr[j]))
        j += 1
    return pairs


def bisect_traces(
    base: list[dict[str, Any]],
    curr: list[dict[str, Any]],
    scenario_id: str = "cli-specimen",
    title: str = "CLI Trace Bisection",
    baseline_id: str = "run_base",
    current_id: str = "run_curr",
    raw_mode: bool = False,
) -> dict[str, Any]:
    safe_id = sanitize_run_id(scenario_id)
    pairs = align_turns(base, curr)
    turns: list[dict[str, Any]] = []
    first_drift_id: str | None = None
    min_ratio = 1.0

    for idx, (b_turn, c_turn) in enumerate(pairs, start=1):
        tid = f"{idx:02d}"
        ref = c_turn or b_turn or {}
        kind_raw = str(ref.get("kind", "prompt"))
        kind = kind_raw if kind_raw in _VALID_KINDS else "prompt"
        label = str(ref.get("label", f"{kind} / step-{tid}"))
        b_out = canonicalize(str((b_turn or {}).get("output", (b_turn or {}).get("text", ""))), raw_mode)
        c_out = canonicalize(str((c_turn or {}).get("output", (c_turn or {}).get("text", ""))), raw_mode)
        changed = b_turn is None or c_turn is None or b_out != c_out
        # ponytail: 4KB slice for SequenceMatcher ratio; switch to line-hash diff if >4KB traces need exact ratios
        ratio = difflib.SequenceMatcher(None, b_out[:4096], c_out[:4096]).ratio() if changed else 1.0
        min_ratio = min(min_ratio, ratio)
        is_first = changed and first_drift_id is None
        if is_first:
            first_drift_id = tid

        turn_obj: dict[str, Any] = {
            "id": tid,
            "time": str(ref.get("time", f"00:00:{idx:02d}.000")),
            "latencyMs": int((c_turn or {}).get("latencyMs", 50)),
            "baselineLatencyMs": int((b_turn or {}).get("latencyMs", 50)),
            "label": label,
            "kind": kind,
            "summary": str(ref.get("summary", f"Step {tid} ({label})")),
            "baselineOutput": b_out or "(absent in baseline)",
            "currentOutput": c_out or "(absent in candidate)",
            "detail": str(ref.get("detail", f"Similarity {ratio:.2f}" if changed else "Canonical match.")),
            "changed": changed,
            "metric": "first drift" if is_first else ("drift" if changed else "stable"),
            "commitRef": str(ref.get("commitRef", "HEAD")),
            "sourceSpan": str(ref.get("sourceSpan", f"trace:{idx}")),
        }
        if is_first:
            turn_obj["firstDrift"] = True
        turns.append(turn_obj)

    b_tools = sum(1 for t in base if t.get("kind") == "tool")
    c_tools = sum(1 for t in curr if t.get("kind") == "tool")
    return {
        "id": safe_id,
        "name": title,
        "currentRunId": current_id,
        "baselineRunId": baseline_id,
        "branch": "main",
        "commit": "HEAD",
        "model": "trace-replay",
        "firstDriftTurn": first_drift_id or (turns[0]["id"] if turns else "01"),
        "driftScore": f"{1.0 - min_ratio:.2f}",
        "toolCallDelta": f"{b_tools:02d} -> {c_tools:02d}",
        "turns": turns,
    }


def _atomic_write_json(target: Path, payload: Any) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, target)


def export_web_run(scenario: dict[str, Any], runs_dir: Path | None = None) -> Path:
    out_dir = runs_dir or Path("website/public/runs")
    safe_id = sanitize_run_id(str(scenario.get("id", "cli-specimen")))
    scenario["id"] = safe_id
    run_file = out_dir / f"{safe_id}.json"
    _atomic_write_json(run_file, scenario)

    index_file = out_dir / "index.json"
    existing: list[dict[str, Any]] = []
    if index_file.exists():
        try:
            loaded = json.loads(index_file.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                existing = [item for item in loaded if isinstance(item, dict) and item.get("id") != safe_id]
        except ValueError:
            existing = []
    existing.insert(0, scenario)
    _atomic_write_json(index_file, existing)
    return run_file


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bisectpilot", description="BisectPilot trace diff & bisection CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_diff = sub.add_parser("diff", help="Diff baseline and candidate JSONL traces")
    p_diff.add_argument("baseline", type=Path)
    p_diff.add_argument("current", type=Path)
    p_diff.add_argument("--id", default="cli-specimen")
    p_diff.add_argument("--title", default="CLI Trace Bisection")
    p_diff.add_argument("--raw", action="store_true")
    p_diff.add_argument("--out", type=Path)
    p_diff.add_argument("--export-web", action="store_true")

    p_bisect = sub.add_parser("bisect", help="Bisect <baseline>..<current> trace range")
    p_bisect.add_argument("range_spec", help="Baseline..Current paths")
    p_bisect.add_argument("--turn", default=None)
    p_bisect.add_argument("--id", default="cli-specimen")
    p_bisect.add_argument("--title", default="CLI Trace Bisection")
    p_bisect.add_argument("--raw", action="store_true")
    p_bisect.add_argument("--out", type=Path)
    p_bisect.add_argument("--export-web", action="store_true")

    args = parser.parse_args(argv)
    if args.cmd == "bisect":
        if ".." not in args.range_spec:
            parser.error("range_spec must be <baseline>..<current>")
        b_str, c_str = args.range_spec.split("..", 1)
        b_path, c_path = Path(b_str), Path(c_str)
    else:
        b_path, c_path = args.baseline, args.current

    scenario = bisect_traces(
        _load_jsonl(b_path),
        _load_jsonl(c_path),
        scenario_id=args.id,
        title=args.title,
        baseline_id=b_path.stem,
        current_id=c_path.stem,
        raw_mode=args.raw,
    )
    if getattr(args, "turn", None):
        scenario["firstDriftTurn"] = args.turn

    if args.export_web:
        export_web_run(scenario)
    if args.out:
        _atomic_write_json(args.out, scenario)
    else:
        sys.stdout.write(json.dumps(scenario, indent=2) + "\n")
    return 0
