import * as crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

export interface SpanStatus {
  readonly code: "unset" | "ok" | "error";
  readonly message?: string;
}

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

export interface SpanEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes?: SpanAttributes;
}

export interface SpanRecord {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: TraceContext;
  readonly parentSpanId?: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly attributes: SpanAttributes;
  readonly events: readonly SpanEvent[];
}

export interface SpanOptions {
  readonly kind?: SpanKind;
  readonly parent?: TraceContext;
  readonly attributes?: Record<string, SpanAttributeValue | undefined>;
  readonly startTime?: number;
}

export interface SpanExporter {
  export(spans: readonly SpanRecord[]): Promise<void> | void;
  shutdown(): Promise<void> | void;
}

export interface Span {
  context(): TraceContext;
  isRecording(): boolean;
  setAttribute(key: string, value: SpanAttributeValue): this;
  setAttributes(attributes: Record<string, SpanAttributeValue | undefined>): this;
  addEvent(name: string, attributes?: Record<string, SpanAttributeValue | undefined>): this;
  setStatus(code: "unset" | "ok" | "error", message?: string): this;
  recordException(error: unknown): this;
  end(endTime?: number): void;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
  withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options?: SpanOptions
  ): Promise<T>;
}

const SECRET_KEY_PATTERN = /token|secret|key|password|authorization|cookie|credential|cert/i;
const MAX_ATTR_STRING_LENGTH = 1024;

export function sanitizeAttributeValue(key: string, value: SpanAttributeValue): SpanAttributeValue {
  if (SECRET_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string" && value.length > MAX_ATTR_STRING_LENGTH) {
    return `${value.slice(0, MAX_ATTR_STRING_LENGTH)}...[TRUNCATED]`;
  }
  return value;
}

export function sanitizeAttributes(
  raw: Record<string, SpanAttributeValue | undefined>
): Record<string, SpanAttributeValue> {
  const result: Record<string, SpanAttributeValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    result[k] = sanitizeAttributeValue(k, v);
  }
  return result;
}

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ALL_ZERO_TRACE_ID = "00000000000000000000000000000000";
const ALL_ZERO_SPAN_ID = "0000000000000000";

export function parseTraceParent(header: string | undefined | null): TraceContext | null {
  if (!header || typeof header !== "string") return null;
  const match = TRACEPARENT_REGEX.exec(header.trim());
  if (!match) return null;
  const traceId = match[1]!.toLowerCase();
  const spanId = match[2]!.toLowerCase();
  const traceFlags = parseInt(match[3]!, 16);

  if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
    return null;
  }

  return { traceId, spanId, traceFlags };
}

export function formatTraceParent(context: TraceContext): string {
  const flags = context.traceFlags.toString(16).padStart(2, "0");
  return `00-${context.traceId.toLowerCase()}-${context.spanId.toLowerCase()}-${flags}`;
}

export function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export class InMemorySpanExporter implements SpanExporter {
  private spans: SpanRecord[] = [];
  private isShutdown = false;

  export(spans: readonly SpanRecord[]): void {
    if (this.isShutdown) return;
    this.spans.push(...spans);
  }

  getSpans(): readonly SpanRecord[] {
    return [...this.spans];
  }

  getFinishedSpans(): readonly SpanRecord[] {
    return [...this.spans];
  }

  clear(): void {
    this.spans = [];
  }

  shutdown(): void {
    this.isShutdown = true;
    this.spans = [];
  }
}

export class NoopSpan implements Span {
  private readonly ctx: TraceContext;

  constructor(context?: TraceContext) {
    this.ctx = context ?? {
      traceId: ALL_ZERO_TRACE_ID,
      spanId: ALL_ZERO_SPAN_ID,
      traceFlags: 0,
    };
  }

  context(): TraceContext {
    return this.ctx;
  }

  isRecording(): boolean {
    return false;
  }

  setAttribute(): this {
    return this;
  }

  setAttributes(): this {
    return this;
  }

  addEvent(): this {
    return this;
  }

  setStatus(): this {
    return this;
  }

  recordException(): this {
    return this;
  }

  end(): void {
    // no-op
  }
}

export class SpanImpl implements Span {
  readonly name: string;
  readonly kind: SpanKind;
  private readonly ctx: TraceContext;
  private readonly parentSpanId?: string;
  private readonly startTime: number;
  private endTime?: number;
  private status: SpanStatus = { code: "unset" };
  private attributes: Record<string, SpanAttributeValue> = {};
  private events: SpanEvent[] = [];
  private ended = false;
  private readonly onEnd: (spanRecord: SpanRecord) => void;

  constructor(
    name: string,
    options: SpanOptions | undefined,
    parentContext: TraceContext | undefined,
    onEnd: (spanRecord: SpanRecord) => void
  ) {
    this.name = name;
    this.kind = options?.kind ?? "internal";
    this.startTime = options?.startTime ?? Date.now();
    this.onEnd = onEnd;

    const parent = options?.parent ?? parentContext;
    this.parentSpanId = parent?.spanId;

    this.ctx = {
      traceId: parent?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      traceFlags: parent?.traceFlags ?? 1,
    };

    if (options?.attributes) {
      this.setAttributes(options.attributes);
    }
  }

  context(): TraceContext {
    return this.ctx;
  }

  isRecording(): boolean {
    return !this.ended;
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    if (this.ended) return this;
    this.attributes[key] = sanitizeAttributeValue(key, value);
    return this;
  }

  setAttributes(attributes: Record<string, SpanAttributeValue | undefined>): this {
    if (this.ended) return this;
    for (const [k, v] of Object.entries(sanitizeAttributes(attributes))) {
      this.attributes[k] = v;
    }
    return this;
  }

  addEvent(name: string, attributes?: Record<string, SpanAttributeValue | undefined>): this {
    if (this.ended) return this;
    this.events.push({
      name,
      timestamp: Date.now(),
      ...(attributes ? { attributes: sanitizeAttributes(attributes) } : {}),
    });
    return this;
  }

  setStatus(code: "unset" | "ok" | "error", message?: string): this {
    if (this.ended) return this;
    this.status = { code, ...(message ? { message } : {}) };
    return this;
  }

  recordException(error: unknown): this {
    if (this.ended) return this;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    this.setStatus("error", message);
    this.addEvent("exception", {
      "exception.message": message,
      ...(stack ? { "exception.stacktrace": stack } : {}),
    });
    return this;
  }

  end(endTime?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.endTime = endTime ?? Date.now();
    const durationMs = Math.max(0, this.endTime - this.startTime);

    const record: SpanRecord = {
      name: this.name,
      kind: this.kind,
      context: this.ctx,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs,
      status: this.status,
      attributes: { ...this.attributes },
      events: [...this.events],
    };

    this.onEnd(record);
  }
}

const asyncLocalStorage = new AsyncLocalStorage<TraceContext>();

export class NoopTracer implements Tracer {
  startSpan(name: string, options?: SpanOptions): Span {
    const parent = options?.parent ?? asyncLocalStorage.getStore();
    return new NoopSpan(parent);
  }

  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options?: SpanOptions
  ): Promise<T> {
    const span = this.startSpan(name, options);
    return asyncLocalStorage.run(span.context(), async () => {
      try {
        const result = await fn(span);
        return result;
      } finally {
        span.end();
      }
    });
  }
}

export class SimpleTracer implements Tracer {
  private readonly exporter?: SpanExporter;

  constructor(exporter?: SpanExporter) {
    this.exporter = exporter;
  }

  startSpan(name: string, options?: SpanOptions): Span {
    const parent = options?.parent ?? asyncLocalStorage.getStore();
    return new SpanImpl(name, options, parent, (record) => {
      if (this.exporter) {
        try {
          void this.exporter.export([record]);
        } catch {
          // Exporter failure must not throw in application path
        }
      }
    });
  }

  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options?: SpanOptions
  ): Promise<T> {
    const span = this.startSpan(name, options);
    return asyncLocalStorage.run(span.context(), async () => {
      try {
        const result = await fn(span);
        span.setStatus("ok");
        return result;
      } catch (error) {
        span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

let globalTracer: Tracer = new NoopTracer();

export function getTracer(_name = "bisectpilot"): Tracer {
  return globalTracer;
}

export function setGlobalTracer(tracer: Tracer): void {
  globalTracer = tracer;
}

export function resetGlobalTracer(): void {
  globalTracer = new NoopTracer();
}

export function getActiveTraceContext(): TraceContext | undefined {
  return asyncLocalStorage.getStore();
}

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

export function isTracingEnabled(): boolean {
  return !(globalTracer instanceof NoopTracer);
}
