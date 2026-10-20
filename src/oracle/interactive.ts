import readline from "node:readline";
import type { CommandSpec, OracleOutcome } from "../contracts/index.js";
import { makeOutcome } from "../domain/classification.js";
import { redactSensitiveText } from "../reports/index.js";

export interface PromptStreams {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
}

export async function promptHumanClassification(params: {
  readonly commitSha: string;
  readonly commandSpec: CommandSpec;
  readonly automatedOutcome: OracleOutcome;
  readonly capturedOutput?: { readonly stdout: string; readonly stderr: string };
  readonly executionInfo?: string;
  readonly streams?: PromptStreams;
  readonly abortSignal?: AbortSignal;
}): Promise<OracleOutcome> {
  const input = params.streams?.input ?? process.stdin;
  const output = params.streams?.output ?? process.stdout;
  const isInteractive =
    params.streams?.isTTY !== undefined
      ? params.streams.isTTY
      : params.streams?.input !== undefined
        ? Boolean((input as { isTTY?: boolean }).isTTY ?? true)
        : Boolean(process.stdin.isTTY);

  if (params.abortSignal?.aborted) {
    return makeOutcome("abort", "cancelled", "Cancelled while awaiting interactive prompt");
  }

  if (!isInteractive) {
    output.write(
      `[prompt] Stdin is non-interactive; accepting automated outcome (${params.automatedOutcome.kind}: ${params.automatedOutcome.reasonCode})\n`
    );
    return params.automatedOutcome;
  }

  const redactedStdout = redactSensitiveText(params.capturedOutput?.stdout ?? "");
  const redactedStderr = redactSensitiveText(params.capturedOutput?.stderr ?? "");
  const combinedOutput = [
    redactedStdout ? `--- stdout ---\n${redactedStdout.trim()}` : "",
    redactedStderr ? `--- stderr ---\n${redactedStderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const promptMessage = [
    `\n=== BisectPilot Interactive Oracle Prompt ===`,
    `Commit:    ${params.commitSha.slice(0, 8)} (${params.commitSha})`,
    `Command:   ${params.commandSpec.command} ${params.commandSpec.args.join(" ")}`,
    `Outcome:   ${params.automatedOutcome.kind} (${params.automatedOutcome.reasonCode}): ${redactSensitiveText(params.automatedOutcome.detail)}`,
    params.executionInfo ? `Info:      ${redactSensitiveText(params.executionInfo)}` : "",
    combinedOutput ? `\nCaptured Output:\n${combinedOutput}\n` : "",
  ]
    .filter(Boolean)
    .join("\n");

  output.write(`${promptMessage}\n`);

  return new Promise<OracleOutcome>((resolve) => {
    let resolved = false;
    const rl = readline.createInterface({
      input,
      output,
      terminal: false,
    });

    const finish = (outcome: OracleOutcome) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve(outcome);
    };

    const onAbort = () => {
      finish(makeOutcome("abort", "cancelled", "Cancelled while awaiting interactive prompt"));
    };

    if (params.abortSignal) {
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const ask = () => {
      rl.question("Classify this revision as (g)ood, (b)ad, or (s)kip? ", (answer) => {
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === "g" || trimmed === "good") {
          finish(
            makeOutcome(
              "good",
              "oracle_passed",
              `Classified as good by human operator (was ${params.automatedOutcome.kind})`,
              "human"
            )
          );
        } else if (trimmed === "b" || trimmed === "bad") {
          finish(
            makeOutcome(
              "bad",
              params.automatedOutcome.kind === "bad"
                ? params.automatedOutcome.reasonCode
                : "oracle_failed_expected_regression",
              `Classified as bad by human operator (was ${params.automatedOutcome.kind})`,
              "human"
            )
          );
        } else if (trimmed === "s" || trimmed === "skip") {
          finish(
            makeOutcome(
              "skip",
              params.automatedOutcome.kind === "skip"
                ? params.automatedOutcome.reasonCode
                : "build_prerequisite_failed",
              `Classified as skip by human operator (was ${params.automatedOutcome.kind})`,
              "human"
            )
          );
        } else {
          output.write(`Invalid choice "${answer.trim()}". Please enter 'g' for good, 'b' for bad, or 's' for skip.\n`);
          ask();
        }
      });
    };

    rl.once("close", () => {
      if (!resolved) {
        finish(params.automatedOutcome);
      }
    });

    ask();
  });
}

