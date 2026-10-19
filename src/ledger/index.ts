import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  GENESIS_PREV_HASH,
  type LedgerEvent,
  type LedgerEventInput,
} from "../contracts/ledger.js";

export * from "../contracts/ledger.js";

function computeEventPayloadHash(eventWithoutHash: Omit<LedgerEvent, "eventHash">): string {
  return createHash("sha256")
    .update(JSON.stringify(eventWithoutHash))
    .digest("hex");
}

export function readLedgerEvents(ledgerPath: string): LedgerEvent[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as LedgerEvent;
    } catch {
      throw new Error(`Corrupt JSONL ledger line ${index + 1} in ${ledgerPath}`);
    }
  });
}

export function verifyLedgerChain(events: readonly LedgerEvent[]): {
  readonly valid: boolean;
  readonly brokenAtSeq?: number;
  readonly reason?: string;
} {
  let expectedPrevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.seq !== i + 1) {
      return { valid: false, brokenAtSeq: ev.seq, reason: `Expected seq ${i + 1}, got ${ev.seq}` };
    }
    if (ev.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAtSeq: ev.seq,
        reason: `prevHash mismatch at seq ${ev.seq}`,
      };
    }
    const { eventHash, ...rest } = ev;
    const recomputed = computeEventPayloadHash(rest as Omit<LedgerEvent, "eventHash">);
    if (recomputed !== eventHash) {
      return {
        valid: false,
        brokenAtSeq: ev.seq,
        reason: `eventHash tamper detected at seq ${ev.seq}`,
      };
    }
    expectedPrevHash = eventHash;
  }
  return { valid: true };
}

export function appendLedgerEvent(
  ledgerPath: string,
  input: LedgerEventInput,
  onEvent?: (event: LedgerEvent) => void
): LedgerEvent {
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const existing = readLedgerEvents(ledgerPath);
  const seq = existing.length + 1;
  const prevHash = existing.length > 0 ? existing[existing.length - 1]!.eventHash : GENESIS_PREV_HASH;
  const timestamp = new Date().toISOString();

  const baseWithoutHash = {
    ...input,
    schemaVersion: 1 as const,
    seq,
    timestamp,
    prevHash,
  };
  const eventHash = computeEventPayloadHash(baseWithoutHash as Omit<LedgerEvent, "eventHash">);
  const fullEvent = {
    ...baseWithoutHash,
    eventHash,
  } as LedgerEvent;

  appendFileSync(ledgerPath, JSON.stringify(fullEvent) + "\n", "utf-8");
  onEvent?.(fullEvent);
  return fullEvent;
}
