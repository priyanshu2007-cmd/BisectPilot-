import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_EXECUTION_POLICY, validateConfig } from "../../src/contracts/index.js";
import { classifyOracleStep } from "../../src/domain/index.js";
import { buildSandboxEnvironment, discoverRootlessSandboxRuntimes, runSafeProcess, runSandboxedProcess, type SandboxCommandResult, type SandboxRuntimeExecutor } from "../../src/process/index.js";

const IMAGE = "ghcr.io/example/bisectpilot@sha256:" + "a".repeat(64);

function sandboxPolicy() {
  return {
    runtime: "docker" as const,
    image: IMAGE,
    network: "none" as const,
    resources: { cpus: 1, memoryMb: 256, pidsLimit: 64, tmpfsMb: 32 },
  };
}

function outcomeResult(code: "cleanup_failed" | "runtime_unavailable" | "policy_rejected") {
  return {
    executable: "docker",
    args: [],
    exitCode: null,
    signal: null,
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "",
    truncatedStdout: false,
    truncatedStderr: false,
    stdoutSha256: "",
    stderrSha256: "",
    sandboxFailureCode: code,
    sandboxFailureMessage: code,
  } as const;
}

class FakeRuntime implements SandboxRuntimeExecutor {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  constructor(
    private readonly imageAvailable = true,
    private readonly rootless = true,
    private readonly ownerMatches = true,
    private readonly startMode?: "cancel" | "timeout",
    private readonly stopSucceeds = true,
  ) {}

  async run(command: string, args: readonly string[], _options?: Parameters<SandboxRuntimeExecutor["run"]>[2]): Promise<SandboxCommandResult> {
    this.calls.push({ command, args });
    const effectiveArgs = args[0] === "--context" ? args.slice(2) : args[0] === "--remote=false" ? args.slice(1) : args;
    if (effectiveArgs[0] === "--version") return { exitCode: 0, signal: null, stdout: "Docker version test", stderr: "", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "info") return { exitCode: 0, signal: null, stdout: this.rootless ? '{"SecurityOptions":["name=rootless"]}' : '{"SecurityOptions":[]}', stderr: "", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "image") return { exitCode: this.imageAvailable ? 0 : 1, signal: null, stdout: "", stderr: "missing image", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "context") return { exitCode: 0, signal: null, stdout: '"unix:///var/run/docker.sock"\n', stderr: "", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "create") return { exitCode: 0, signal: null, stdout: "container-123\n", stderr: "", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "start") return { exitCode: this.startMode ? null : 0, signal: this.startMode ? "SIGTERM" : null, stdout: "", stderr: "", timedOut: this.startMode === "timeout", cancelled: this.startMode === "cancel" };
    if (effectiveArgs[0] === "wait") return { exitCode: 0, signal: null, stdout: "0\n", stderr: "", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "logs") return { exitCode: 0, signal: null, stdout: "hello\n", stderr: "", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "inspect") {
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          Config: {
            Labels: { "io.bisectpilot.managed": "true", "io.bisectpilot.owner": this.ownerMatches ? "job-owner" : "different-owner" },
            Entrypoint: null,
            User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          },
          HostConfig: {
            ReadonlyRootfs: true,
            NetworkMode: "none",
            CapDrop: ["ALL"],
            CapAdd: [],
            Privileged: false,
            SecurityOpt: ["no-new-privileges:true"],
            PidsLimit: 64,
            Memory: 256 * 1024 * 1024,
            NanoCpus: 1_000_000_000,
            Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=32m" },
          },
        }),
        stderr: "",
        timedOut: false,
        cancelled: false,
      };
    }
    if (effectiveArgs[0] === "wait") return { exitCode: 0, signal: null, stdout: "0\n", stderr: "", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "logs") return { exitCode: 0, signal: null, stdout: "hello\n", stderr: "", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "stop") return { exitCode: this.stopSucceeds ? 0 : 1, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false };
    if (effectiveArgs[0] === "kill") return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false };
    return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false };
  }
}

class OutputRuntime extends FakeRuntime {
  override async run(command: string, args: readonly string[], options?: Parameters<SandboxRuntimeExecutor["run"]>[2]): Promise<SandboxCommandResult> {
    const result = await super.run(command, args, options);
    const effectiveCommand = args[0] === "--context" ? args[2] : args[0] === "--remote=false" ? args[1] : args[0];
    if (effectiveCommand !== "logs") return result;
    const stdout = "0123456789ABCDEFGHIJ";
    return { ...result, stdout, stdoutBytes: Buffer.byteLength(stdout), stdoutSha256: createHash("sha256").update(stdout).digest("hex") };
  }
}

describe("Step 10 — rootless container sandbox", () => {
  it("validates digest-pinned, no-network sandbox policy and rejects unsafe variants", () => {
    const valid = validateConfig({
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: "/tmp/repo",
      workingDirectory: ".",
      goodRef: "good",
      badRef: "bad",
      oracle: { mode: "in-tree", command: { command: "node", args: ["check.mjs"], timeoutMs: 1000 } },
      execution: { ...DEFAULT_EXECUTION_POLICY, sandbox: sandboxPolicy() },
    });
    assert.equal(valid.ok, true);
    if (valid.ok) assert.equal(valid.value.execution.sandbox?.network, "none");

    const invalid = validateConfig({
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: "/tmp/repo",
      workingDirectory: ".",
      goodRef: "good",
      badRef: "bad",
      oracle: { mode: "in-tree", command: { command: "node", args: [], timeoutMs: 1000 } },
      execution: { ...DEFAULT_EXECUTION_POLICY, envOverrides: { SECRET_TOKEN: "never" }, sandbox: { ...sandboxPolicy(), image: "node:latest" } },
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.ok(invalid.issues.some((issue) => issue.path === "execution.sandbox.image"));
      assert.ok(invalid.issues.some((issue) => issue.path === "execution.envOverrides"));
    }
  });

  it("discovers only runtimes with structured rootless attestations", async () => {
    const executor: SandboxRuntimeExecutor = {
      run: async (command, args) => {
        const effectiveArgs = args[0] === "--context" ? args.slice(2) : args[0] === "--remote=false" ? args.slice(1) : args;
        if (effectiveArgs[0] === "--version") return { exitCode: 0, signal: null, stdout: "version", stderr: "", timedOut: false, cancelled: false };
        if (effectiveArgs[0] === "context") return { exitCode: 0, signal: null, stdout: '"unix:///var/run/docker.sock"\n', stderr: "", timedOut: false, cancelled: false };
        if (command === "docker") return { exitCode: 0, signal: null, stdout: '{"SecurityOptions":["name=rootless"]}', stderr: "", timedOut: false, cancelled: false };
        return { exitCode: 0, signal: null, stdout: '{"host":{"security":{"rootless":true}}}', stderr: "", timedOut: false, cancelled: false };
      },
    };
    assert.deepEqual(await discoverRootlessSandboxRuntimes(executor), ["docker", "podman"]);
  });

  it("runs only with verified rootless restrictions and owned cleanup", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-sandbox-"));
    try {
      const workspace = path.join(root, "worktree");
      const session = path.join(root, "session");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(session, { recursive: true });
      const input = path.join(session, "input.mjs");
      writeFileSync(input, "console.log('input')\n", "utf8");
      const runtime = new FakeRuntime();
      const result = await runSandboxedProcess({
        policy: sandboxPolicy(),
        workspaceRoot: workspace,
        cwd: workspace,
        command: "node",
        args: [input],
        env: { CI: "1", HOME: "/tmp", PATH: "/bin", CUSTOM: "allowed" },
        mounts: [{ hostPath: input, containerPath: "/bisectpilot-input/input.mjs", readOnly: true }],
        allowedReadOnlyRoots: [session],
        timeoutMs: 1000,
        killGraceMs: 100,
        ownerId: "job-owner",
        executor: runtime,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.sandbox.rootlessVerified, true);
      assert.equal(result.sandbox.cleanup, "verified");
      const create = runtime.calls.find((call) => call.args.includes("create"));
      assert.ok(create);
      assert.ok(create.args.includes("--read-only"));
      assert.ok(create.args.includes("--network") && create.args.includes("none"));
      assert.ok(create.args.includes("--cap-drop") && create.args.includes("ALL"));
      assert.ok(create.args.includes("--security-opt") && create.args.includes("no-new-privileges:true"));
      assert.ok(create.args.some((arg) => arg.includes("target=/workspace")));
      assert.ok(create.args.some((arg) => arg.includes("target=/bisectpilot-input/input.mjs,readonly")));
      assert.ok(create.args.includes("--env") && create.args.includes("HOME=/tmp"));
      assert.ok(create.args.includes("/workspace"));
      assert.ok(create.args.includes("--entrypoint") && create.args.includes(""));
      const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
      const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
      assert.ok(create.args.includes("--user") && create.args.includes(`${uid}:${gid}`));
      assert.ok(create.args.includes("--pids-limit") && create.args.includes("64"));
      const imageIndex = create.args.indexOf(IMAGE);
      assert.deepEqual(create.args.slice(imageIndex), [IMAGE, "node", "/bisectpilot-input/input.mjs"]);
      const sandboxEnv = buildSandboxEnvironment({ ...DEFAULT_EXECUTION_POLICY, sandbox: sandboxPolicy(), allowlistedEnvVars: ["CUSTOM"] }, { HOME: "/host", CUSTOM: "ok", OPENAI_API_KEY: "secret" });
      assert.equal(sandboxEnv.HOME, "/tmp");
      assert.equal(sandboxEnv.CUSTOM, "ok");
      assert.equal(sandboxEnv.OPENAI_API_KEY, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when rootless mode or the local image is unavailable", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-sandbox-fail-"));
    try {
      const noRootless = new FakeRuntime(true, false);
      const base = { policy: sandboxPolicy(), workspaceRoot: root, cwd: root, command: "node", args: [], env: {}, timeoutMs: 1000, killGraceMs: 100 } as const;
      const rootlessResult = await runSandboxedProcess({ ...base, executor: noRootless });
      assert.equal(rootlessResult.sandboxFailureCode, "policy_rejected");
      const noImage = new FakeRuntime(false, true);
      const imageResult = await runSandboxedProcess({ ...base, executor: noImage });
      assert.equal(imageResult.sandboxFailureCode, "image_unavailable");
      const outcome = classifyOracleStep({
        executable: "docker",
        args: [],
        exitCode: null,
        signal: null,
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        stdout: "",
        stderr: "",
        truncatedStdout: false,
        truncatedStderr: false,
        stdoutSha256: "",
        stderrSha256: "",
        sandboxFailureCode: "image_unavailable",
        sandboxFailureMessage: "image missing",
      }, "functional");
      assert.equal(outcome.kind, "abort");
      assert.equal(outcome.reasonCode, "sandbox_image_unavailable");
      const cleanupOutcome = classifyOracleStep({
        ...outcomeResult("cleanup_failed"),
      }, "functional");
      assert.equal(cleanupOutcome.reasonCode, "sandbox_cleanup_failed");
      const runtimeOutcome = classifyOracleStep(outcomeResult("runtime_unavailable"), "functional");
      assert.equal(runtimeOutcome.reasonCode, "sandbox_runtime_unavailable");
      const policyOutcome = classifyOracleStep(outcomeResult("policy_rejected"), "functional");
      assert.equal(policyOutcome.reasonCode, "sandbox_policy_rejected");

      const wrongOwner = new FakeRuntime(true, true, false);
      const wrongOwnerResult = await runSandboxedProcess({ ...base, ownerId: "job-owner", executor: wrongOwner });
      assert.equal(wrongOwnerResult.sandboxFailureCode, "cleanup_failed");
      assert.equal(wrongOwner.calls.some((call) => call.args.includes("stop") || call.args.includes("rm")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects writable, escaping, reserved, and overlapping mounts before runtime use", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-sandbox-mounts-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "bp-sandbox-outside-"));
    try {
      const base = { policy: sandboxPolicy(), workspaceRoot: root, cwd: root, command: "node", args: [], env: {}, timeoutMs: 1000, killGraceMs: 100 } as const;
      const writable = await runSandboxedProcess({ ...base, mounts: [{ hostPath: root, containerPath: "/bisectpilot-input/writable", readOnly: false }], executor: new FakeRuntime() });
      assert.equal(writable.sandboxFailureCode, "policy_rejected");
      const escaping = await runSandboxedProcess({ ...base, mounts: [{ hostPath: outside, containerPath: "/bisectpilot-input/outside", readOnly: true }], executor: new FakeRuntime() });
      assert.equal(escaping.sandboxFailureCode, "policy_rejected");
      const reserved = await runSandboxedProcess({ ...base, mounts: [{ hostPath: root, containerPath: "/etc", readOnly: true }], executor: new FakeRuntime() });
      assert.equal(reserved.sandboxFailureCode, "policy_rejected");
      const overlapping = await runSandboxedProcess({
        ...base,
        mounts: [
          { hostPath: root, containerPath: "/bisectpilot-input/a", readOnly: true },
          { hostPath: root, containerPath: "/bisectpilot-input/a/b", readOnly: true },
        ],
        executor: new FakeRuntime(),
      });
      assert.equal(overlapping.sandboxFailureCode, "policy_rejected");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("preserves cancellation/timeout results and uses kill fallback during cleanup", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-sandbox-termination-"));
    try {
      const base = { policy: sandboxPolicy(), workspaceRoot: root, cwd: root, command: "node", args: [], env: {}, timeoutMs: 1000, killGraceMs: 100, ownerId: "job-owner" } as const;
      const cancelledRuntime = new FakeRuntime(true, true, true, "cancel");
      const cancelled = await runSandboxedProcess({ ...base, executor: cancelledRuntime });
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.terminatedBy, "cancel");
      assert.equal(cancelled.sandbox.terminationReason, "cancel");
      assert.equal(cancelled.sandbox.cleanup, "verified");
      assert.ok(cancelledRuntime.calls.some((call) => call.args.includes("rm")));

      const timedOutRuntime = new FakeRuntime(true, true, true, "timeout", false);
      const timedOut = await runSandboxedProcess({ ...base, executor: timedOutRuntime });
      assert.equal(timedOut.timedOut, true);
      assert.equal(timedOut.terminatedBy, "timeout");
      assert.equal(timedOut.sandbox.terminationReason, "timeout");
      assert.equal(timedOut.sandbox.cleanup, "verified");
      assert.ok(timedOutRuntime.calls.some((call) => call.args.includes("kill")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves bounded output and full-stream hashes at runSafeProcess", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-sandbox-output-"));
    try {
      const result = await runSafeProcess({
        commandSpec: { command: "node", args: [], timeoutMs: 1000 },
        cwd: root,
        executionPolicy: { ...DEFAULT_EXECUTION_POLICY, maxOutputBytesPerCommand: 10, sandbox: sandboxPolicy() },
        workspaceRoot: root,
        sandboxOwnerId: "job-owner",
        sandboxRuntimeExecutor: new OutputRuntime(),
      });
      assert.equal(result.stdout, "0123456789");
      assert.equal(result.truncatedStdout, true);
      assert.equal(result.stdoutSha256, createHash("sha256").update("0123456789ABCDEFGHIJ").digest("hex"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
