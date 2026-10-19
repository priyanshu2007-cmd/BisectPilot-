#!/usr/bin/env node
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

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    });
}
