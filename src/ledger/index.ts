import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
} from "node:fs";
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
  if (raw.length === 0) return [];
  const endsWithNewline = raw.endsWith("\n");
  const rawLines = raw.split("\n");
  const linesToParse = endsWithNewline ? rawLines.slice(0, -1) : rawLines;

  const events: LedgerEvent[] = [];
  let tornTail = false;

  for (let i = 0; i < linesToParse.length; i++) {
    const line = linesToParse[i]!;
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      const isLast = i === linesToParse.length - 1;
      if (isLast && !endsWithNewline) {
        tornTail = true;
      } else {
        throw new Error(`Corrupt JSONL ledger line ${i + 1} in ${ledgerPath}`);
      }
    }
  }

  if (tornTail) {
    (events as any).ledgerTornTail = true;
  }
  return events;
}

export interface LedgerVerificationResult {
  readonly valid: boolean;
  readonly brokenAtSeq?: number;
  readonly reason?: string;
  readonly ledgerTornTail?: boolean;
  readonly finalHash?: string;
}

export function verifyLedgerChain(
  events: readonly LedgerEvent[],
  options?: { readonly expectedLastHash?: string }
): LedgerVerificationResult {
  const tornTail = Boolean((events as any).ledgerTornTail);
  if (events.length === 0) {
    return {
      valid: false,
      reason: "ledger file empty or has no events",
      ...(tornTail ? { ledgerTornTail: true } : {}),
    };
  }
  let expectedPrevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.seq !== i + 1) {
      return {
        valid: false,
        brokenAtSeq: ev.seq,
        reason: `Expected seq ${i + 1}, got ${ev.seq}`,
        ...(tornTail ? { ledgerTornTail: true } : {}),
      };
    }
    if (ev.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAtSeq: ev.seq,
        reason: `prevHash mismatch at seq ${ev.seq}`,
        ...(tornTail ? { ledgerTornTail: true } : {}),
      };
    }
    const { eventHash, ...rest } = ev;
    const recomputed = computeEventPayloadHash(rest as Omit<LedgerEvent, "eventHash">);
    if (recomputed !== eventHash) {
      return {
        valid: false,
        brokenAtSeq: ev.seq,
        reason: `eventHash tamper detected at seq ${ev.seq}`,
        ...(tornTail ? { ledgerTornTail: true } : {}),
      };
    }
    expectedPrevHash = eventHash;
  }
  const lastEvent = events[events.length - 1]!;
  if (
    options?.expectedLastHash &&
    lastEvent.eventHash.toLowerCase() !== options.expectedLastHash.toLowerCase()
  ) {
    return {
      valid: false,
      reason: `Expected final chain hash ${options.expectedLastHash}, got ${lastEvent.eventHash}`,
      finalHash: lastEvent.eventHash,
      ...(tornTail ? { ledgerTornTail: true } : {}),
    };
  }
  return {
    valid: true,
    finalHash: lastEvent.eventHash,
    ...(tornTail ? { ledgerTornTail: true } : {}),
  };
}

export function verifyLedgerFile(
  ledgerPath: string,
  options?: { readonly expectedLastHash?: string }
): LedgerVerificationResult {
  if (!existsSync(ledgerPath)) {
    return { valid: false, reason: `ledger file missing: ${ledgerPath}` };
  }
  let events: LedgerEvent[];
  try {
    events = readLedgerEvents(ledgerPath);
  } catch (err: unknown) {
    return { valid: false, reason: (err as Error)?.message ?? String(err) };
  }
  if (events.length === 0) {
    return {
      valid: false,
      reason: `ledger file empty or has no events: ${ledgerPath}`,
      ...((events as any).ledgerTornTail ? { ledgerTornTail: true } : {}),
    };
  }
  return verifyLedgerChain(events, options);
}

interface LedgerTailInfo {
  readonly lastEvent: LedgerEvent | null;
  readonly tornTailBytes: number;
  readonly validLength: number;
}

function inspectLedgerTail(ledgerPath: string): LedgerTailInfo {
  if (!existsSync(ledgerPath)) {
    return { lastEvent: null, tornTailBytes: 0, validLength: 0 };
  }
  const stat = statSync(ledgerPath);
  const fileSize = stat.size;
  if (fileSize === 0) {
    return { lastEvent: null, tornTailBytes: 0, validLength: 0 };
  }

  const fd = openSync(ledgerPath, "r");
  try {
    const lastByteBuf = Buffer.alloc(1);
    readSync(fd, lastByteBuf, 0, 1, fileSize - 1);
    const endsWithNewline = lastByteBuf[0] === 0x0a;

    let buffer = Buffer.alloc(0);
    let foundLastEvent: LedgerEvent | null = null;
    let tornTailBytes = 0;
    let validLength = fileSize;
    let readOffset = fileSize;
    const CHUNK_SIZE = 64 * 1024;

    while (readOffset > 0) {
      const toRead = Math.min(CHUNK_SIZE, readOffset);
      readOffset -= toRead;
      const chunk = Buffer.alloc(toRead);
      readSync(fd, chunk, 0, toRead, readOffset);
      buffer = Buffer.concat([chunk, buffer]);

      const text = buffer.toString("utf-8");
      const lines = text.split("\n");

      if (!endsWithNewline && tornTailBytes === 0) {
        const lastNlIndex = buffer.lastIndexOf(0x0a);
        if (lastNlIndex >= 0) {
          validLength = readOffset + lastNlIndex + 1;
          tornTailBytes = fileSize - validLength;
        } else if (readOffset === 0) {
          validLength = 0;
          tornTailBytes = fileSize;
          return { lastEvent: null, tornTailBytes, validLength: 0 };
        }
      }

      const searchLines = endsWithNewline ? lines.slice(0, -1) : lines.slice(0, -1);
      for (let j = searchLines.length - 1; j >= 0; j--) {
        const line = searchLines[j]!.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as LedgerEvent;
          if (parsed && typeof parsed.seq === "number" && typeof parsed.eventHash === "string") {
            foundLastEvent = parsed;
            break;
          }
        } catch {
          if (readOffset === 0) {
            throw new Error(`Corrupt JSONL ledger line in ${ledgerPath}`);
          }
        }
      }

      if (foundLastEvent) {
        break;
      }
    }

    return {
      lastEvent: foundLastEvent,
      tornTailBytes,
      validLength,
    };
  } finally {
    closeSync(fd);
  }
}

export function appendLedgerEvent(
  ledgerPath: string,
  input: LedgerEventInput,
  onEvent?: (event: LedgerEvent) => void
): LedgerEvent {
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const tailInfo = inspectLedgerTail(ledgerPath);

  if (tailInfo.tornTailBytes > 0) {
    truncateSync(ledgerPath, tailInfo.validLength);
    const repairEvent: LedgerEventInput = {
      type: "ledger_repaired",
      sessionId: input.sessionId,
      action: "torn_tail_truncated",
      bytesTruncated: tailInfo.tornTailBytes,
      detail: `Truncated ${tailInfo.tornTailBytes} bytes of torn trailing line`,
    };
    appendLedgerEvent(ledgerPath, repairEvent, onEvent);
    return appendLedgerEvent(ledgerPath, input, onEvent);
  }

  const lastEvent = tailInfo.lastEvent;
  const seq = lastEvent ? lastEvent.seq + 1 : 1;
  const prevHash = lastEvent ? lastEvent.eventHash : GENESIS_PREV_HASH;
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
