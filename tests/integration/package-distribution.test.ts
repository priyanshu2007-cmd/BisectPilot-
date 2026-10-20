import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import os from "node:os";
import path from "node:path";

test("Feature B — Production-Ready npm Package Distribution", async (t) => {
  const repoRoot = process.cwd();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-pack-test-"));
  let tarballPath = "";

  t.after(() => {
    if (tarballPath && existsSync(tarballPath)) {
      try {
        rmSync(tarballPath, { force: true });
      } catch {
        // Safe cleanup
      }
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Safe cleanup
    }
  });

  await t.test("packs a clean distributable tarball containing only production files", () => {
    // Pack tarball into tmpDir
    const packOutput = execSync(`npm pack --pack-destination="${tmpDir}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();

    const tarballName = packOutput.split("\n").filter(Boolean).pop()?.trim();
    assert.ok(tarballName, "npm pack must output a tarball filename");
    assert.ok(tarballName.endsWith(".tgz"), `Expected .tgz extension, got: ${tarballName}`);

    tarballPath = path.join(tmpDir, tarballName);
    assert.ok(existsSync(tarballPath), `Tarball must exist at ${tarballPath}`);

    // Inspect tarball file list
    const fileList = execSync(`tar -tf "${tarballName}"`, { cwd: tmpDir, encoding: "utf-8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    // Verify mandatory distribution files are present
    assert.ok(fileList.includes("package/package.json"));
    assert.ok(fileList.includes("package/README.md"));
    assert.ok(fileList.includes("package/LICENSE"));
    assert.ok(fileList.includes("package/dist/src/index.js"));
    assert.ok(fileList.includes("package/dist/src/index.d.ts"));
    assert.ok(fileList.includes("package/dist/src/contracts/index.js"));
    assert.ok(fileList.includes("package/dist/src/domain/minimizer.js"));

    // Verify development files, website, and toolkits are strictly excluded
    const disallowedPrefixes = [
      "package/website",
      "package/ai-agent-toolkit",
      "package/skills",
      "package/tests",
      "package/.github",
      "package/src/",
      "package/uv.lock",
      "package/.env",
    ];

    for (const file of fileList) {
      for (const disallowed of disallowedPrefixes) {
        assert.ok(
          !file.startsWith(disallowed),
          `Disallowed development or secret file packaged: ${file}`
        );
      }
    }

    // Step 9 added the daemon, queue and worker entry points, and Step 12 adds production
    // telemetry; keep the production tarball bounded without making the check depend on an exact file count.
    assert.ok(fileList.length < 150, `Package contains too many files: ${fileList.length}`);
  });

  await t.test("installs tarball into an isolated consumer project outside the repository", () => {
    const consumerDir = path.join(tmpDir, "consumer");
    mkdirSync(consumerDir, { recursive: true });

    // Initialize clean consumer package

    writeFileSync(
      path.join(consumerDir, "package.json"),
      JSON.stringify({ name: "consumer-app", type: "module" }, null, 2),
      "utf-8"
    );

    // Install the local tarball
    execSync(`npm install "${tarballPath}"`, {
      cwd: consumerDir,
      encoding: "utf-8",
      stdio: "pipe",
    });

    const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
    const pkgName = rootPkg.name as string;
    const installedPath = path.join(consumerDir, "node_modules", ...pkgName.split("/"));
    assert.ok(existsSync(installedPath), `Installed package must exist at ${installedPath}`);

    // 1. Verify executable CLI binary resolves and runs --help
    const helpOutput = execSync("npx bisectpilot --help", {
      cwd: consumerDir,
      encoding: "utf-8",
    });
    assert.ok(helpOutput.includes("BisectPilot — Local-First Git Regression Bisection Engine"));
    assert.ok(helpOutput.includes("bisectpilot minimize"));

    // 2. Verify bisectpilot doctor launches and returns actionable diagnostics
    execSync("git init", { cwd: consumerDir, stdio: "ignore" });
    const doctorOutput = execSync("npx bisectpilot doctor .", {
      cwd: consumerDir,
      encoding: "utf-8",
    });
    const parsedDoctor = JSON.parse(doctorOutput);
    assert.equal(parsedDoctor.ok, true);
    assert.ok(parsedDoctor.gitVersion);

    // 3. Verify public module library imports work cleanly

    const testScript = path.join(consumerDir, "test-import.mjs");
    writeFileSync(
      testScript,
      `
import { LocalBisectEngine, minimizeInput } from "${pkgName}";
import { GIT_BISECT_EXIT_CODES } from "${pkgName}/contracts";

if (typeof LocalBisectEngine !== "function") throw new Error("LocalBisectEngine not exported");
if (typeof minimizeInput !== "function") throw new Error("minimizeInput not exported");
if (GIT_BISECT_EXIT_CODES.good !== 0) throw new Error("Contract constants not exported");

const engine = new LocalBisectEngine();
if (typeof engine.doctor !== "function") throw new Error("engine.doctor missing");
if (typeof engine.minimize !== "function") throw new Error("engine.minimize missing");

console.log("EXPORTS_VERIFIED_CLEAN");
`,
      "utf-8"
    );

    const importResult = execSync(`node test-import.mjs`, {
      cwd: consumerDir,
      encoding: "utf-8",
    }).trim();

    assert.equal(importResult, "EXPORTS_VERIFIED_CLEAN");
  });
});
