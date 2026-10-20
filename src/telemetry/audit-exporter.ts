import * as http from "node:http";
import * as https from "node:https";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { verifyLedgerChain, type LedgerEvent } from "../ledger/index.js";
import { defaultMetrics } from "./metrics.js";

export interface AuditExportOptions {
  readonly batchSize?: number;
  readonly verifyChainBeforeExport?: boolean;
}

export interface AuditExportResult {
  readonly success: boolean;
  readonly exportedCount: number;
  readonly totalProcessed: number;
  readonly lastSequenceNumber?: number;
  readonly lastEventHash?: string;
  readonly error?: string;
}

export interface AuditEventExporter {
  readonly name: string;
  exportEvents(events: readonly LedgerEvent[]): Promise<AuditExportResult>;
  shutdown(): Promise<void>;
}

export class InMemoryAuditEventExporter implements AuditEventExporter {
  readonly name = "in-memory";
  private exported: LedgerEvent[] = [];
  private lastSeq = 0;
  private readonly options: AuditExportOptions;

  constructor(options: AuditExportOptions = {}) {
    this.options = options;
  }

  async exportEvents(events: readonly LedgerEvent[]): Promise<AuditExportResult> {
    if (this.options.verifyChainBeforeExport !== false && events.length > 0) {
      const check = verifyLedgerChain(events);
      if (!check.valid) {
        defaultMetrics.auditEventsExportedTotal.inc(1, { status: "failure" });
        return {
          success: false,
          exportedCount: 0,
          totalProcessed: events.length,
          error: `Ledger chain verification failed: ${check.reason ?? "unknown"}`,
        };
      }
    }

    const newEvents = events.filter((e) => e.seq > this.lastSeq);
    if (newEvents.length === 0) {
      return {
        success: true,
        exportedCount: 0,
        totalProcessed: events.length,
        lastSequenceNumber: this.lastSeq,
      };
    }

    this.exported.push(...newEvents);
    this.lastSeq = newEvents[newEvents.length - 1]!.seq;
    const lastHash = newEvents[newEvents.length - 1]!.eventHash;

    defaultMetrics.auditEventsExportedTotal.inc(newEvents.length, { status: "success" });

    return {
      success: true,
      exportedCount: newEvents.length,
      totalProcessed: events.length,
      lastSequenceNumber: this.lastSeq,
      lastEventHash: lastHash,
    };
  }

  getExportedEvents(): readonly LedgerEvent[] {
    return [...this.exported];
  }

  clear(): void {
    this.exported = [];
    this.lastSeq = 0;
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}

export class FileAuditEventExporter implements AuditEventExporter {
  readonly name = "file";
  private readonly filePath: string;
  private readonly options: AuditExportOptions;
  private lastSeq = 0;

  constructor(filePath: string, options: AuditExportOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.options = options;
  }

  async exportEvents(events: readonly LedgerEvent[]): Promise<AuditExportResult> {
    if (this.options.verifyChainBeforeExport !== false && events.length > 0) {
      const check = verifyLedgerChain(events);
      if (!check.valid) {
        defaultMetrics.auditEventsExportedTotal.inc(1, { status: "failure" });
        return {
          success: false,
          exportedCount: 0,
          totalProcessed: events.length,
          error: `Ledger chain verification failed: ${check.reason ?? "unknown"}`,
        };
      }
    }

    const newEvents = events.filter((e) => e.seq > this.lastSeq);
    if (newEvents.length === 0) {
      return {
        success: true,
        exportedCount: 0,
        totalProcessed: events.length,
        lastSequenceNumber: this.lastSeq,
      };
    }

    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload = newEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
      appendFileSync(this.filePath, payload, "utf-8");

      this.lastSeq = newEvents[newEvents.length - 1]!.seq;
      const lastHash = newEvents[newEvents.length - 1]!.eventHash;

      defaultMetrics.auditEventsExportedTotal.inc(newEvents.length, { status: "success" });

      return {
        success: true,
        exportedCount: newEvents.length,
        totalProcessed: events.length,
        lastSequenceNumber: this.lastSeq,
        lastEventHash: lastHash,
      };
    } catch (err: unknown) {
      defaultMetrics.auditEventsExportedTotal.inc(1, { status: "failure" });
      return {
        success: false,
        exportedCount: 0,
        totalProcessed: events.length,
        error: `Failed to append events to ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}

export interface WebhookExporterOptions extends AuditExportOptions {
  readonly timeoutMs?: number;
  readonly headers?: Record<string, string>;
}

export class WebhookAuditEventExporter implements AuditEventExporter {
  readonly name = "webhook";
  private readonly endpoint: URL;
  private readonly options: WebhookExporterOptions;
  private lastSeq = 0;

  constructor(endpointUrl: string, options: WebhookExporterOptions = {}) {
    this.endpoint = new URL(endpointUrl);
    this.options = options;
  }

  async exportEvents(events: readonly LedgerEvent[]): Promise<AuditExportResult> {
    if (this.options.verifyChainBeforeExport !== false && events.length > 0) {
      const check = verifyLedgerChain(events);
      if (!check.valid) {
        defaultMetrics.auditEventsExportedTotal.inc(1, { status: "failure" });
        return {
          success: false,
          exportedCount: 0,
          totalProcessed: events.length,
          error: `Ledger chain verification failed: ${check.reason ?? "unknown"}`,
        };
      }
    }

    const newEvents = events.filter((e) => e.seq > this.lastSeq);
    if (newEvents.length === 0) {
      return {
        success: true,
        exportedCount: 0,
        totalProcessed: events.length,
        lastSequenceNumber: this.lastSeq,
      };
    }

    const body = JSON.stringify({
      events: newEvents,
      exportedAt: new Date().toISOString(),
      eventCount: newEvents.length,
    });

    const isHttps = this.endpoint.protocol === "https:";
    const transport = isHttps ? https : http;

    return new Promise<AuditExportResult>((resolve) => {
      const req = transport.request(
        this.endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...(this.options.headers ?? {}),
          },
          timeout: this.options.timeoutMs ?? 5000,
        },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            this.lastSeq = newEvents[newEvents.length - 1]!.seq;
            const lastHash = newEvents[newEvents.length - 1]!.eventHash;
            defaultMetrics.auditEventsExportedTotal.inc(newEvents.length, { status: "success" });
            resolve({
              success: true,
              exportedCount: newEvents.length,
              totalProcessed: events.length,
              lastSequenceNumber: this.lastSeq,
              lastEventHash: lastHash,
            });
          } else {
            defaultMetrics.auditEventsExportedTotal.inc(1, { status: "failure" });
            resolve({
              success: false,
              exportedCount: 0,
              totalProcessed: events.length,
              error: `Webhook returned status ${res.statusCode ?? "unknown"}`,
            });
          }
        }
      );

      req.on("error", (err) => {
        defaultMetrics.auditEventsExportedTotal.inc(1, { status: "failure" });
        resolve({
          success: false,
          exportedCount: 0,
          totalProcessed: events.length,
          error: `Webhook request failed: ${err.message}`,
        });
      });

      req.on("timeout", () => {
        req.destroy();
        defaultMetrics.auditEventsExportedTotal.inc(1, { status: "failure" });
        resolve({
          success: false,
          exportedCount: 0,
          totalProcessed: events.length,
          error: "Webhook request timed out",
        });
      });

      req.write(body);
      req.end();
    });
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}
