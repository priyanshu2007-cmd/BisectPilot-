#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli/index.js";

export * from "./contracts/index.js";
export * from "./config/index.js";
export * from "./domain/index.js";
export * from "./git/index.js";
export * from "./worktree/index.js";
export * from "./process/index.js";
export * from "./oracle/index.js";
export * from "./ledger/index.js";
export * from "./session/index.js";
export * from "./reports/index.js";
export * from "./application/index.js";
export * from "./cli/index.js";
export * from "./jobs/index.js";
export * from "./daemon/index.js";
export * from "./worker/index.js";
export * from "./telemetry/index.js";

function isCliInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    const currentPath = fileURLToPath(import.meta.url);
    if (process.argv[1] === currentPath) return true;
    return realpathSync(process.argv[1]) === realpathSync(currentPath);
  } catch {
    return false;
  }
}

if (isCliInvocation()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    });
}
