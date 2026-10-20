import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_EXECUTION_POLICY, type BisectConfigV1 } from "../../src/contracts/index.js";
import { LocalBisectEngine } from "../../src/application/index.js";
import { readLedgerEvents, verifyLedgerChain, verifyLedgerFile } from "../../src/ledger/index.js";
import { generateMarkdownReport } from "../../src/reports/index.js";
import { getLedgerPath, getManifestPath, readSessionManifest, writeSessionManifestAtomic } from "../../src/session/index.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";

test("Bug 1 - rebuilt manifest points at the correct ledger file and ledger verification checks integrity", async (t) => {
  const fixture = await buildFixtureRepo([
    { message: "initial good", files: { "file.txt": "good\n" } },
    { message: "introduce bug", files: { "file.txt": "bad\n" } },
    { message: "unrelated change", files: { "other.txt": "hello\n" } },
  ]);

  const engine = new LocalBisectEngine();

  const makeConfig = (): BisectConfigV1 => ({
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: fixture.repoDir,
    workingDirectory: ".",
    goodRef: fixture.commitShas[0]!,
    badRef: fixture.commitShas[2]!,
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
  });

  try {
    const manifest = await engine.start(makeConfig());
    const sessionDir = manifest.sessionDir;

    // Test (a): delete manifest + tamper ledger -> verify fails naming the seq
    const manifestPath = getManifestPath(sessionDir);
    unlinkSync(manifestPath);

    // Tamper line 2 in ledger.jsonl
    const ledgerPath = path.join(sessionDir, "ledger.jsonl");
    const rawLines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    assert.ok(rawLines.length >= 2, "ledger should have at least 2 events");
    const tamperedObj = JSON.parse(rawLines[1]!) as Record<string, unknown>;
    tamperedObj.reason = "tampered reason";
    rawLines[1] = JSON.stringify(tamperedObj);
    writeFileSync(ledgerPath, rawLines.join("\n") + "\n", "utf-8");

    // Read manifest again (triggers checkpoint rebuild)
    const rebuilt = readSessionManifest(sessionDir);
    assert.equal(
      rebuilt.ledgerPath,
      path.join(sessionDir, "ledger.jsonl"),
      "rebuilt manifest should point to ledger.jsonl, not events.jsonl"
    );

    const statusAfterTamper = await engine.status(manifest.id, path.dirname(sessionDir));
    assert.equal(statusAfterTamper.ledgerValid, false, "ledgerValid should be false on tampered ledger");
    const tamperedEvents = readLedgerEvents(rebuilt.ledgerPath);
    const tamperedCheck = verifyLedgerChain(tamperedEvents);
    assert.equal(tamperedCheck.valid, false);
    assert.equal(tamperedCheck.brokenAtSeq, 2);

    // Test (b): untampered session with deleted manifest -> report lists evaluated revisions and verify passes
    const manifest2 = await engine.start(makeConfig());
    const sessionDir2 = manifest2.sessionDir;
    unlinkSync(getManifestPath(sessionDir2));

    const rebuilt2 = readSessionManifest(sessionDir2);
    const status2 = await engine.status(manifest2.id, path.dirname(sessionDir2));
    assert.equal(status2.ledgerValid, true, "untampered session should have valid ledger");
    const events2 = readLedgerEvents(rebuilt2.ledgerPath);
    const reportMd = generateMarkdownReport(rebuilt2, events2);
    assert.ok(!reportMd.includes("| (none) |"), "report should list evaluated revisions instead of (none)");

    // Test (c): missing ledger file -> verify fails
    unlinkSync(path.join(sessionDir2, "ledger.jsonl"));
    const statusMissing = await engine.status(manifest2.id, path.dirname(sessionDir2));
    assert.equal(statusMissing.ledgerValid, false, "missing ledger file must fail validation");

    const fileCheck = verifyLedgerFile(path.join(sessionDir2, "ledger.jsonl"));
    assert.equal(fileCheck.valid, false);
    assert.ok(fileCheck.reason?.includes("ledger file missing"));

    // Migration test: existing manifest on disk with events.jsonl that does not exist but ledger.jsonl exists
    const manifest3 = await engine.start(makeConfig());
    const brokenManifest = {
      ...manifest3,
      ledgerPath: path.join(manifest3.sessionDir, "events.jsonl"),
    };
    writeSessionManifestAtomic(brokenManifest);

    const migrated = readSessionManifest(manifest3.sessionDir);
    assert.equal(migrated.ledgerPath, path.join(manifest3.sessionDir, "ledger.jsonl"));
  } finally {
    fixture.cleanup();
  }
});
