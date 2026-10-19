import json
import tempfile
import unittest
from pathlib import Path

from bisectpilot import (
    align_turns,
    bisect_traces,
    canonicalize,
    export_web_run,
    main,
    sanitize_run_id,
)


class TestBisectPilot(unittest.TestCase):
    def test_canonicalize_strips_timestamps_and_uuids_and_sorts_keys(self) -> None:
        raw = '{"b": "2026-10-19T09:14:02.184Z", "a": "id=550e8400-e29b-41d4-a716-446655440000"}'
        norm = canonicalize(raw, raw_mode=False)
        self.assertEqual(norm, '{\n  "a": "id=<UUID>",\n  "b": "<TS>"\n}')
        self.assertEqual(canonicalize(raw, raw_mode=True), raw)

    def test_lookahead_alignment_handles_inserted_retry_turn(self) -> None:
        base = [
            {"id": "01", "kind": "prompt", "label": "sys", "output": "ok"},
            {"id": "02", "kind": "tool", "label": "retrieve", "output": "k=4"},
            {"id": "03", "kind": "result", "label": "verdict", "output": "P1"},
        ]
        curr = [
            {"id": "01", "kind": "prompt", "label": "sys", "output": "ok"},
            {"id": "01b", "kind": "tool", "label": "retry", "output": "backoff"},
            {"id": "02", "kind": "tool", "label": "retrieve", "output": "k=4"},
            {"id": "03", "kind": "result", "label": "verdict", "output": "P1"},
        ]
        pairs = align_turns(base, curr)
        self.assertEqual(len(pairs), 4)
        scenario = bisect_traces(base, curr, scenario_id="retry-test")
        changed_ids = [t["id"] for t in scenario["turns"] if t["changed"]]
        self.assertEqual(changed_ids, ["02"])
        self.assertEqual(scenario["firstDriftTurn"], "02")

    def test_cli_diff_and_bisect_subcommands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            b_file = p / "run_base.jsonl"
            c_file = p / "run_curr.jsonl"
            b_file.write_text(
                '{"kind":"prompt","label":"system / baseline","output":"v1"}\n'
                '{"kind":"result","label":"final / verdict","output":"P1"}\n',
                encoding="utf-8",
            )
            c_file.write_text(
                '{"kind":"prompt","label":"system / baseline","output":"v1"}\n'
                '{"kind":"result","label":"final / verdict","output":"P2"}\n',
                encoding="utf-8",
            )
            out_diff = p / "diff.json"
            rc1 = main(["diff", str(b_file), str(c_file), "--id", "t1", "--out", str(out_diff)])
            self.assertEqual(rc1, 0)
            data = json.loads(out_diff.read_text(encoding="utf-8"))
            self.assertEqual(data["firstDriftTurn"], "02")
            self.assertTrue(data["turns"][1]["firstDrift"])

            out_bisect = p / "bisect.json"
            rc2 = main(["bisect", f"{b_file}..{c_file}", "--turn", "02", "--out", str(out_bisect)])
            self.assertEqual(rc2, 0)
            b_data = json.loads(out_bisect.read_text(encoding="utf-8"))
            self.assertEqual(b_data["firstDriftTurn"], "02")

    def test_sanitize_and_atomic_export_web(self) -> None:
        self.assertEqual(sanitize_run_id("../../etc/passwd"), "etc-passwd")
        with tempfile.TemporaryDirectory() as tmp:
            runs_dir = Path(tmp) / "runs"
            scenario = bisect_traces(
                [{"kind": "prompt", "label": "sys", "output": "a"}],
                [{"kind": "prompt", "label": "sys", "output": "b"}],
                scenario_id="../unsafe/id",
            )
            written = export_web_run(scenario, runs_dir=runs_dir)
            self.assertEqual(written.name, "unsafe-id.json")
            index = json.loads((runs_dir / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(len(index), 1)
            self.assertEqual(index[0]["id"], "unsafe-id")


if __name__ == "__main__":
    unittest.main()
