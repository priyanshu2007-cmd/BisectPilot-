import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendLedgerEvent,
  readLedgerEvents,
  verifyLedgerFile,
} from "../../src/ledger/index.js";

test("Bug 9 - ledger append performance, torn tail tolerance, and corruption detection", async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-ledger-test-"));
  const ledgerPath = path.join(tmpDir, "ledger.jsonl");

  try {
    // 1. Append 2,000 events and verify performance bound
    const start = Date.now();
    for (let i = 0; i < 2000; i++) {
      appendLedgerEvent(ledgerPath, {
        type: "revision_classified",
        sessionId: "perf-session",
        commitSha: "a".repeat(40),
        classification: "good",
        reasonCode: "oracle_passed",
        detail: "Passed test",
        gitExitCode: 0,
        overlayHashes: {},
      });
    }
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 3000,
      `Appending 2,000 events took ${elapsed}ms; should complete well under 3000ms`
    );

    const initialVerify = verifyLedgerFile(ledgerPath);
    assert.equal(initialVerify.valid, true);

    // 2. Torn tail write: append half a line without trailing newline
    appendFileSync(ledgerPath, '{"seq":2001,"sessionId":"perf-session","type":"tran', "utf-8");

    // readLedgerEvents should not throw, should return the 2,000 events
    const recoveredEvents = readLedgerEvents(ledgerPath);
    assert.equal(recoveredEvents.length, 2000);

    // verifyLedgerFile should be valid and note ledgerTornTail: true
    const tornVerify = verifyLedgerFile(ledgerPath);
    assert.equal(tornVerify.valid, true);
    assert.equal(tornVerify.ledgerTornTail, true);

    // Next append should truncate torn tail, record repair, and continue chain
    const nextEvent = appendLedgerEvent(ledgerPath, {
      type: "transition",
      sessionId: "perf-session",
      from: "bisect_running",
      to: "concluded",
      reason: "Bisection finished",
    });

    const finalEvents = readLedgerEvents(ledgerPath);
    // Should have 2000 initial + 1 repair + 1 transition = 2002 events
    assert.equal(finalEvents.length, 2002);
    assert.equal(finalEvents[finalEvents.length - 1]!.seq, nextEvent.seq);

    const postAppendVerify = verifyLedgerFile(ledgerPath);
    assert.equal(postAppendVerify.valid, true);

    // 3. Corrupted middle line: corrupt line 2 in a new ledger
    const corruptLedgerPath = path.join(tmpDir, "corrupt-ledger.jsonl");
    for (let i = 0; i < 3; i++) {
      appendLedgerEvent(corruptLedgerPath, {
        type: "revision_classified",
        sessionId: "corrupt-session",
        commitSha: "b".repeat(40),
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "Failed test",
        gitExitCode: 1,
        overlayHashes: {},
      });
    }

    const lines = readFileSync(corruptLedgerPath, "utf-8").trim().split("\n");
    lines[1] = '{"seq":2,CORRUPT_JSON_DATA';
    writeFileSync(corruptLedgerPath, lines.join("\n") + "\n", "utf-8");

    assert.throws(
      () => {
        readLedgerEvents(corruptLedgerPath);
      },
      /Corrupt JSONL ledger line 2/,
      "Middle line corruption must throw an error"
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
