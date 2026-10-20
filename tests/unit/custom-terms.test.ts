import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTermsOption,
  validateBisectTerm,
  validateConfig,
  DEFAULT_EXECUTION_POLICY,
  type BisectConfigV1,
} from "../../src/contracts/config.js";
import { LocalBisectEngine } from "../../src/application/index.js";
import { runCli } from "../../src/cli/index.js";
import { readLedgerEvents } from "../../src/ledger/index.js";

test("Feature A — Custom Bisect Terms: Validation and parsing", async (t) => {
  await t.test("accepts valid custom terms", () => {
    const res = parseTermsOption("fast,slow");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.value, { old: "fast", new: "slow" });
    }

    const res2 = parseTermsOption("v1.0-clean,v2.0-broken");
    assert.equal(res2.ok, true);
    if (res2.ok) {
      assert.deepEqual(res2.value, { old: "v1.0-clean", new: "v2.0-broken" });
    }
  });

  await t.test("rejects malformed terms inputs", () => {
    assert.equal(parseTermsOption("").ok, false);
    assert.equal(parseTermsOption("singleterm").ok, false);
    assert.equal(parseTermsOption("one,two,three").ok, false);
    assert.equal(parseTermsOption(",new").ok, false);
    assert.equal(parseTermsOption("old,").ok, false);
  });

  await t.test("rejects identical terms", () => {
    const res = parseTermsOption("broken,broken");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /identical/i);
    }
  });

  await t.test("rejects terms with invalid git characters", () => {
    assert.equal(validateBisectTerm("term with space").ok, false);
    assert.equal(validateBisectTerm("term~1").ok, false);
    assert.equal(validateBisectTerm("term^2").ok, false);
    assert.equal(validateBisectTerm("term:colon").ok, false);
    assert.equal(validateBisectTerm("term..range").ok, false);
    assert.equal(validateBisectTerm("-starts-with-dash").ok, false);
  });

  await t.test("rejects reserved Git bisect keywords", () => {
    assert.equal(validateBisectTerm("start").ok, false);
    assert.equal(validateBisectTerm("reset").ok, false);
    assert.equal(validateBisectTerm("skip").ok, false);
    assert.equal(validateBisectTerm("replay").ok, false);
    assert.equal(validateBisectTerm("log").ok, false);
    assert.equal(validateBisectTerm("run").ok, false);
    assert.equal(validateBisectTerm("terms").ok, false);
  });

  await t.test("validateConfig validates config.terms", () => {
    const baseConfig: BisectConfigV1 = {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: ".",
      workingDirectory: ".",
      goodRef: "HEAD~1",
      badRef: "HEAD",
      oracle: {
        mode: "in-tree",
        command: { command: "npm", args: ["test"], timeoutMs: 30_000 },
      },
      execution: {
        ...DEFAULT_EXECUTION_POLICY,
        confirmBeforeExecutingCode: false,
      },
    };

    const valid = validateConfig({
      ...baseConfig,
      terms: { old: "fast", new: "slow" },
    });
    assert.equal(valid.ok, true);

    const invalid = validateConfig({
      ...baseConfig,
      terms: { old: "same", new: "same" },
    });
    assert.equal(invalid.ok, false);
  });
});

test("Feature A — Custom Bisect Terms: CLI integration", async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-cli-terms-"));
  const cfgPath = path.join(tmpDir, "config.json");

  const config: BisectConfigV1 = {
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: tmpDir,
    workingDirectory: ".",
    goodRef: "HEAD~1",
    badRef: "HEAD",
    oracle: {
      mode: "in-tree",
      command: { command: "node", args: ["-e", "process.exit(0)"], timeoutMs: 30_000 },
    },
    execution: {
      ...DEFAULT_EXECUTION_POLICY,
      confirmBeforeExecutingCode: false,
    },
  };
  writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf-8");

  await t.test("CLI rejects invalid --terms flag", async () => {
    const code = await runCli(["plan", "--config", cfgPath, "--terms", "invalid"]);
    assert.equal(code, 2);
  });

  await t.test("CLI rejects missing argument for --terms", async () => {
    const code = await runCli(["plan", "--config", cfgPath, "--terms"]);
    assert.equal(code, 2);
  });

  rmSync(tmpDir, { recursive: true, force: true });
});

test("Feature A — Custom Bisect Terms: Real Git repository bisection", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-git-terms-test-"));
  try {
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: tmpDir, stdio: "ignore" });

    // Commit 1: good / fast
    writeFileSync(path.join(tmpDir, "bench.txt"), "time=10", "utf-8");
    execSync("git add bench.txt && git commit -m 'c1: fast'", { cwd: tmpDir, stdio: "ignore" });
    const c1Sha = execSync("git rev-parse HEAD", { cwd: tmpDir }).toString().trim().toLowerCase();

    // Commit 2: bad / slow (the regression)
    writeFileSync(path.join(tmpDir, "bench.txt"), "time=100", "utf-8");
    execSync("git add bench.txt && git commit -m 'c2: introduced slow delay'", { cwd: tmpDir, stdio: "ignore" });
    const c2Sha = execSync("git rev-parse HEAD", { cwd: tmpDir }).toString().trim().toLowerCase();

    // Commit 3: still slow
    writeFileSync(path.join(tmpDir, "bench.txt"), "time=105", "utf-8");
    execSync("git add bench.txt && git commit -m 'c3: still slow'", { cwd: tmpDir, stdio: "ignore" });
    const c3Sha = execSync("git rev-parse HEAD", { cwd: tmpDir }).toString().trim().toLowerCase();

    // Oracle: fail (exit 1) if time > 50, pass (exit 0) if time <= 50
    const config: BisectConfigV1 = {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: tmpDir,
      workingDirectory: ".",
      goodRef: c1Sha,
      badRef: c3Sha,
      terms: { old: "fast", new: "slow" },
      oracle: {
        mode: "in-tree",
        command: {
          command: "node",
          args: [
            "-e",
            'const fs = require("fs"); const val = parseInt(fs.readFileSync("bench.txt", "utf-8").replace("time=", ""), 10); process.exit(val > 50 ? 1 : 0);',
          ],
          timeoutMs: 30_000,
        },
      },
      execution: {
        ...DEFAULT_EXECUTION_POLICY,
        endpointFlakeRuns: 1,
        boundaryConfirmRuns: 1,
        confirmBeforeExecutingCode: false,
      },
    };

    const engine = new LocalBisectEngine();
    const manifest = await engine.start(config);

    assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
    assert.equal(manifest.conclusion?.candidateSha, c2Sha);
    assert.equal(manifest.conclusion?.parentSha, c1Sha);
    assert.match(manifest.conclusion?.explanation ?? "", /first slow commit/i);

    // Verify session ledger records custom terms in session_created
    const events = readLedgerEvents(manifest.ledgerPath);
    const createdEvent = events.find((e) => e.type === "session_created");
    assert.ok(createdEvent);
    assert.deepEqual(createdEvent.terms, { old: "fast", new: "slow" });

    // Verify resume compatibility: status returns manifest with terms intact
    const status = await engine.status(manifest.id, path.dirname(manifest.sessionDir));
    assert.deepEqual(status.manifest.config.terms, { old: "fast", new: "slow" });

    await engine.cleanup(manifest.id, { dryRun: false }, path.dirname(manifest.sessionDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
