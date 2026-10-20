import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function discoverTestFiles(target) {
  let dirs = ["dist/tests/unit", "dist/tests/integration", "dist/tests/safety"];
  if (target) {
    if (target === "unit") dirs = ["dist/tests/unit"];
    else if (target === "integration") dirs = ["dist/tests/integration"];
    else if (target === "safety") dirs = ["dist/tests/safety"];
    else dirs = [target];
  }
  const testFiles = [];
  for (const dir of dirs) {
    try {
      const files = readdirSync(dir).sort();
      for (const file of files) {
        if (file.endsWith(".test.js")) {
          testFiles.push(path.join(dir, file));
        }
      }
    } catch {
      // directory might not exist yet
    }
  }
  return testFiles;
}

if (process.argv[1] && process.argv[1].endsWith("run-tests.mjs")) {
  const target = process.argv[2];
  const testFiles = discoverTestFiles(target);

  if (testFiles.length === 0) {
    console.error("Error: No test files discovered for target:", target || "all");
    process.exit(1);
  }

  let failedCount = 0;
  const failedFiles = [];

  for (const file of testFiles) {
    console.log(`\n=== RUNNING: ${file} ===`);
    const res = spawnSync(process.execPath, ["--test", file], { stdio: "inherit" });
    if (res.status !== 0) {
      console.error(`>>> FAILED: ${file} (exit code ${res.status})`);
      failedCount++;
      failedFiles.push(file);
    } else {
      console.log(`>>> PASSED: ${file}`);
    }
  }

  if (failedCount > 0) {
    console.error(`\n❌ Test run completed with ${failedCount} failed file(s):`);
    for (const f of failedFiles) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  } else {
    console.log(`\n✅ All ${testFiles.length} test files passed!`);
    process.exit(0);
  }
}

