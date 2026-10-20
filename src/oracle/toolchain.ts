import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { applyToolchainWrapper } from "../process/index.js";

export interface ToolchainInspection {
  readonly detectedNodeSpec?: string;
  readonly requiredMajor?: number;
  readonly runningNodeVersion: string;
  readonly runningMajor: number;
  readonly packageManager?: string;
  readonly mismatch: boolean;
}

function parseMajorVersion(spec: string): number | undefined {
  const cleaned = spec.trim().replace(/^[v^~>=<\s]+/, "");
  const match = /^(\d+)/.exec(cleaned);
  return match ? Number(match[1]) : undefined;
}

/**
 * Per-revision Node.js toolchain inspection (Section 26.9). Reads files only; never executes scripts.
 */
export function inspectRevisionToolchain(worktreePath: string): ToolchainInspection {
  const runningNodeVersion = process.versions.node;
  const runningMajor = Number(runningNodeVersion.split(".")[0] ?? "0");
  let detectedNodeSpec: string | undefined;
  let packageManager: string | undefined;

  const nvmrcPath = path.join(worktreePath, ".nvmrc");
  const nodeVersionPath = path.join(worktreePath, ".node-version");
  const pkgJsonPath = path.join(worktreePath, "package.json");

  if (existsSync(nvmrcPath)) {
    detectedNodeSpec = readFileSync(nvmrcPath, "utf-8").trim();
  } else if (existsSync(nodeVersionPath)) {
    detectedNodeSpec = readFileSync(nodeVersionPath, "utf-8").trim();
  }

  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
        engines?: { node?: string };
        packageManager?: string;
      };
      if (!detectedNodeSpec && typeof pkg.engines?.node === "string") {
        detectedNodeSpec = pkg.engines.node;
      }
      if (typeof pkg.packageManager === "string") {
        packageManager = pkg.packageManager;
      }
    } catch {
      // Ignore malformed historical package.json
    }
  }

  const requiredMajor = detectedNodeSpec ? parseMajorVersion(detectedNodeSpec) : undefined;
  const mismatch =
    requiredMajor !== undefined &&
    !detectedNodeSpec?.includes(">=") &&
    requiredMajor !== runningMajor;

  return {
    ...(detectedNodeSpec ? { detectedNodeSpec } : {}),
    ...(requiredMajor !== undefined ? { requiredMajor } : {}),
    runningNodeVersion,
    runningMajor,
    ...(packageManager ? { packageManager } : {}),
    mismatch,
  };
}


export { applyToolchainWrapper as wrapCommandWithToolchain };
