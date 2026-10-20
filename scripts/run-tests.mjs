import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dirs = ["dist/tests/unit", "dist/tests/integration", "dist/tests/safety"];
const testFiles = [];

for (const dir of dirs) {
  try {
    const files = readdirSync(dir).sort();
    for (const file of files) {
      if (file.endsWith(".test.js")) {
        testFiles.push(path.join(dir, file));
      }
    }
  } catch (err) {
    console.error(`Warning: could not read test directory ${dir}:`, err);
  }
}

if (testFiles.length === 0) {
  console.error("Error: No test files found in", dirs);
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
