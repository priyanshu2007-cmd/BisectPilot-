import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FakeEngine } from "../../src/contracts/index.js";
import { CLI_OPTION_TABLES, parseCommandArguments, runCli, splitInlineCommand } from "../../src/cli/index.js";

function captureStderr(): { get(): string; restore(): void } {
  let captured = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  return {
    get: () => captured,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

test("inline command parsing preserves the command tail verbatim", () => {
  const parsed = splitInlineCommand([
    "start",
    "--good",
    "a",
    "--bad",
    "b",
    "--yes",
    "--",
    "npm",
    "test",
    "--watch=false",
  ]);

  assert.deepEqual(parsed.bisectArgs, ["start", "--good", "a", "--bad", "b", "--yes"]);
  assert.deepEqual(parsed.inlineCommand, {
    command: "npm",
    args: ["test", "--watch=false"],
  });
});

test("start without a config or inline command returns the actionable error", async () => {
  const capture = captureStderr();
  try {
    const code = await runCli(["start", "--good", "a", "--bad", "b"]);
    assert.equal(code, 2);
    assert.equal(
      capture.get(),
      'error: provide an oracle command after "--" (e.g. bisectpilot start --good A --bad B -- npm test) or pass --config <file>\n'
    );
  } finally {
    capture.restore();
  }
});

test("inline command overrides the oracle command loaded from a config", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-inline-config-"));
  try {
    const configPath = path.join(tmpDir, "bisectpilot.config.json");
    assert.equal(await runCli(["init", "--out", configPath]), 0);

    const engine = new FakeEngine();
    let capturedCommand: { command: string; args: readonly string[]; timeoutMs: number } | undefined;
    const originalPlan = engine.plan.bind(engine);
    engine.plan = async (config) => {
      capturedCommand = config.oracle.command;
      return originalPlan(config);
    };

    const code = await runCli(
      ["plan", "--config", configPath, "--", "node", "check.js", "--watch=false"],
      engine
    );

    assert.equal(code, 0);
    assert.deepEqual(capturedCommand, {
      command: "node",
      args: ["check.js", "--watch=false"],
      timeoutMs: 180_000,
    });
    assert.equal(JSON.parse(readFileSync(configPath, "utf-8")).oracle.command.command, "npm");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("inline mode requires both bounds and accepts --good auto", async () => {
  const missingGood = captureStderr();
  try {
    assert.equal(await runCli(["plan", "--bad", "b", "--", "npm", "test"]), 2);
    assert.match(missingGood.get(), /--good <ref> and --bad <ref> are required/);
  } finally {
    missingGood.restore();
  }

  const engine = new FakeEngine();
  let capturedGood = "";
  const originalPlan = engine.plan.bind(engine);
  engine.plan = async (config) => {
    capturedGood = config.goodRef;
    return originalPlan(config);
  };
  assert.equal(await runCli(["plan", "--good", "auto", "--bad", "HEAD", "--", "npm", "test"], engine), 0);
  assert.equal(capturedGood, "auto");
});

test("parseArgs accepts the documented top-level option surface", () => {
  const expected: Readonly<Record<string, readonly string[]>> = {
    doctor: ["--help", "--version"],
    init: ["--out", "--force"],
    plan: [
      "--config", "--good", "--bad", "--terms", "--cwd", "--scope", "--sandbox", "--sandbox-image",
      "--metric", "--threshold", "--relative-regression", "--direction", "--warmup", "--samples",
      "--min-samples", "--max-samples", "--alpha", "--unit", "--timeout",
    ],
    start: [
      "--config", "--good", "--bad", "--terms", "--cwd", "--scope", "--sandbox", "--sandbox-image",
      "--metric", "--threshold", "--relative-regression", "--direction", "--warmup", "--samples",
      "--min-samples", "--max-samples", "--alpha", "--unit", "--timeout", "--yes", "--background",
      "--prompt", "--noisy", "--github-summary", "--daemon-state-dir", "--repository-key",
    ],
    status: ["--session-root"],
    resume: ["--session-root"],
    report: ["--session-root", "--out", "--verify", "--github-summary", "--github-issue", "--html", "--json"],
    cleanup: ["--session-root", "--dry-run"],
    list: ["--session-root"],
    minimize: ["--input", "--test", "--arg", "--args", "--out", "--budget", "--timeout", "--granularity", "--noisy", "--force", "--json"],
  };

  for (const [command, flags] of Object.entries(expected)) {
    for (const flag of flags) {
      const key = flag.replace(/^--/, "");
      assert.ok(CLI_OPTION_TABLES[command]?.[key], `${command} should accept ${flag}`);
    }
    const args = flags.flatMap((flag) => {
      const option = CLI_OPTION_TABLES[command]![flag.replace(/^--/, "")]!;
      return option.type === "boolean" ? [flag] : [flag, flag === "--arg" ? "-e" : "value"];
    });
    assert.equal(parseCommandArguments([command, ...args]).ok, true, `${command} parser rejected a documented flag`);
  }
});

test("unknown flags name the subcommand and return exit code 2", async () => {
  const parsed = parseCommandArguments(["start", "--not-a-flag"]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /start.*not-a-flag/);

  const capture = captureStderr();
  try {
    assert.equal(await runCli(["start", "--not-a-flag"]), 2);
    assert.match(capture.get(), /start.*not-a-flag/);
  } finally {
    capture.restore();
  }
});
