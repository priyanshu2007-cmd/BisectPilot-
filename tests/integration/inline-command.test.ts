import assert from "node:assert/strict";
import test from "node:test";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";
import { runCli } from "../../src/cli/index.js";

test("inline start bisects a fixture repository without a config file", async () => {
  const fixture = await buildFixtureRepo([
    {
      message: "initial good",
      files: {
        "value.txt": "good\n",
        "check.js": "const fs = require('node:fs'); process.exit(fs.readFileSync('value.txt', 'utf8').trim() === 'good' ? 0 : 1);\n",
      },
    },
    {
      message: "introduce regression",
      files: { "value.txt": "bad\n" },
    },
    {
      message: "unrelated change",
      files: { "other.txt": "unrelated\n" },
    },
  ]);

  const originalCwd = process.cwd();
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    process.chdir(fixture.repoDir);
    const code = await runCli([
      "start",
      "--good",
      fixture.commitShas[0]!,
      "--bad",
      fixture.commitShas[2]!,
      "--yes",
      "--json",
      "--",
      "node",
      "check.js",
    ]);

    assert.equal(code, 0);
    const manifest = JSON.parse(output) as {
      conclusion?: { outcome?: string; candidateSha?: string };
    };
    assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
    assert.equal(manifest.conclusion?.candidateSha, fixture.commitShas[1]);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    fixture.cleanup();
  }
});
