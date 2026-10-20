import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendLedgerEvent,
  readLedgerEvents,
  verifyLedgerFile,
} from "../../src/ledger/index.js";
import { LocalBisectEngine } from "../../src/application/index.js";
import { runCli } from "../../src/cli/index.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";
import { DEFAULT_EXECUTION_POLICY, type BisectConfigV1 } from "../../src/contracts/index.js";

function computeHash(obj: Record<string, unknown>): string {
  const { eventHash, ...rest } = obj;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

test("Bug 10 - ledger anchor hash verification detects rewritten chain", async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-ledger-anchor-"));
  const ledgerPath = path.join(tmpDir, "ledger.jsonl");

  try {
    // Create 3 events
    for (let i = 1; i <= 3; i++) {
      appendLedgerEvent(ledgerPath, {
        type: "revision_classified",
        sessionId: "anchor-session",
        commitSha: `${i}`.repeat(40),
        classification: i === 3 ? "bad" : "good",
        reasonCode: i === 3 ? "oracle_failed_expected_regression" : "oracle_passed",
        detail: `Step ${i}`,
        gitExitCode: i === 3 ? 1 : 0,
        overlayHashes: {},
      });
    }

    const eventsBefore = readLedgerEvents(ledgerPath);
    const originalLastHash = eventsBefore[eventsBefore.length - 1]!.eventHash;

    const initialVerify = verifyLedgerFile(ledgerPath, { expectedLastHash: originalLastHash });
    assert.equal(initialVerify.valid, true);

    // Deliberate rewrite: tamper line 2, and recompute hashes for line 2 and line 3
    const rawLines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    const ev1 = JSON.parse(rawLines[0]!);
    const ev2 = JSON.parse(rawLines[1]!);
    const ev3 = JSON.parse(rawLines[2]!);

    // Change ev2 detail
    ev2.detail = "Rewritten step 2";
    ev2.eventHash = computeHash(ev2);

    // Update ev3 prevHash and recompute ev3 eventHash
    ev3.prevHash = ev2.eventHash;
    ev3.eventHash = computeHash(ev3);

    writeFileSync(ledgerPath, [JSON.stringify(ev1), JSON.stringify(ev2), JSON.stringify(ev3)].join("\n") + "\n", "utf-8");

    // Naive verification passes because all internal hashes match
    const naiveVerify = verifyLedgerFile(ledgerPath);
    assert.equal(naiveVerify.valid, true, "Naive verify passes on fully recomputed chain");

    // But verify with --expect-hash fails
    const anchoredVerify = verifyLedgerFile(ledgerPath, { expectedLastHash: originalLastHash });
    assert.equal(anchoredVerify.valid, false, "Anchored verify must fail when last hash differs");
    assert.ok(
      anchoredVerify.reason?.includes(originalLastHash),
      `Expected reason to mention original hash, got: ${anchoredVerify.reason}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Bug 10 - CLI report --verify --expect-hash rejects altered chain", async (t) => {
  const fixture = await buildFixtureRepo([
    { message: "initial good", files: { "file.txt": "good\n" } },
    { message: "introduce bug", files: { "file.txt": "bad\n" } },
  ]);

  const engine = new LocalBisectEngine();

  const config: BisectConfigV1 = {
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: fixture.repoDir,
    workingDirectory: ".",
    goodRef: fixture.commitShas[0]!,
    badRef: fixture.commitShas[1]!,
    oracle: {
      mode: "in-tree",
      command: {
        command: "sh",
        args: ["-c", "grep -q 'good' file.txt"],
        timeoutMs: 5000,
      },
    },
    execution: {
      ...DEFAULT_EXECUTION_POLICY,
      confirmBeforeExecutingCode: false,
    },
  };

  try {
    const manifest = await engine.start(config);
    const sessionRoot = path.dirname(manifest.sessionDir);
    const events = readLedgerEvents(manifest.ledgerPath);
    const originalHash = events[events.length - 1]!.eventHash;
    assert.equal(manifest.finalChainHash, originalHash);

    // Tamper line 1 and re-hash the chain
    const lines = readFileSync(manifest.ledgerPath, "utf-8").trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l));
    parsed[0].worktreePath = "/tmp/tampered";
    let prev = "0000000000000000000000000000000000000000000000000000000000000000";
    for (const ev of parsed) {
      ev.prevHash = prev;
      ev.eventHash = computeHash(ev);
      prev = ev.eventHash;
    }
    writeFileSync(manifest.ledgerPath, parsed.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    // Naive report --verify passes
    const origWrite = process.stdout.write;
    const origErr = process.stderr.write;
    process.stdout.write = (() => true) as any;
    process.stderr.write = (() => true) as any;
    try {
      const exitNaive = await runCli(["report", manifest.id, "--verify", "--session-root", sessionRoot], engine);
      assert.equal(exitNaive, 0, "Naive --verify passes on re-hashed chain");

      // Anchored report --verify --expect-hash fails
      const exitAnchored = await runCli([
        "report",
        manifest.id,
        "--verify",
        "--expect-hash",
        originalHash,
        "--session-root",
        sessionRoot,
      ], engine);
      assert.equal(exitAnchored, 1, "Anchored --verify --expect-hash fails on re-hashed chain");
    } finally {
      process.stdout.write = origWrite;
      process.stderr.write = origErr;
    }
  } finally {
    fixture.cleanup();
  }
});
