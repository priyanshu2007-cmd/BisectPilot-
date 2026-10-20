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

const res = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
process.exit(res.status ?? 1);
