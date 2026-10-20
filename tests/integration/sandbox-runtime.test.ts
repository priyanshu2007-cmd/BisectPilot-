import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { discoverRootlessSandboxRuntimes, runSandboxedProcess } from "../../src/process/index.js";

it("runs a real rootless sandbox when an explicit local digest-pinned image is available", async (t) => {
  const runtimes = await discoverRootlessSandboxRuntimes();
  if (runtimes.length === 0) {
    t.skip("No usable rootless Docker/Podman runtime was detected");
    return;
  }
  const image = process.env.BISECTPILOT_SANDBOX_IMAGE;
  if (!image) {
    t.skip("BISECTPILOT_SANDBOX_IMAGE is not set to an explicitly selected local digest-pinned image");
    return;
  }
  if (!/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    t.skip("BISECTPILOT_SANDBOX_IMAGE is not a lowercase digest-pinned image reference");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "bp-sandbox-runtime-"));
  try {
    const result = await runSandboxedProcess({
      policy: {
        runtime: runtimes[0]!,
        image,
        network: "none",
        resources: { cpus: 1, memoryMb: 256, pidsLimit: 64, tmpfsMb: 32 },
      },
      workspaceRoot: root,
      cwd: root,
      command: "sh",
      args: ["-c", "test \"$(id -u)\" -ne 0 && grep -Eq '^CapEff:[[:space:]]*0{16}$' /proc/self/status && grep -Eq '^NoNewPrivs:[[:space:]]*1$' /proc/self/status"],
      env: { CI: "1", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/tmp" },
      timeoutMs: 15_000,
      killGraceMs: 1_000,
      ownerId: "integration-test",
    });
    if (result.sandboxFailureCode === "image_unavailable") {
      t.skip("The explicitly selected image is not available locally; image pulls are intentionally disabled");
      return;
    }
    assert.equal(result.sandboxFailureCode, undefined, result.sandboxFailureMessage);
    assert.equal(result.exitCode, 0);
    assert.equal(result.sandbox.rootlessVerified, true);
    assert.equal(result.sandbox.network, "none");
    assert.equal(result.sandbox.cleanup, "verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
