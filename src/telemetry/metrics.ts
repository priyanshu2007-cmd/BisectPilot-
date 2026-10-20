export type MetricType = "counter" | "gauge" | "histogram";

export interface Metric {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly labelNames: readonly string[];
  scrape(): string;
  reset(): void;
}

export type MetricLabels = Readonly<Record<string, string>>;

function formatLabels(labelNames: readonly string[], labels: MetricLabels | undefined): string {
  if (!labels || labelNames.length === 0) return "";
  const parts: string[] = [];
  for (const name of labelNames) {
    const value = labels[name];
    if (value !== undefined) {
      const escaped = String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
      parts.push(`${name}="${escaped}"`);
    }
  }
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

function labelKey(labelNames: readonly string[], labels: MetricLabels | undefined): string {
  if (!labels || labelNames.length === 0) return "";
  return labelNames.map((k) => `${k}:${labels[k] ?? ""}`).join("|");
}

export class Counter implements Metric {
  readonly type = "counter" as const;
  private values = new Map<string, { value: number; labels?: MetricLabels }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = []
  ) {}

  inc(amount?: number, labels?: MetricLabels): void;
  inc(labels: MetricLabels, amount?: number): void;
  inc(amountOrLabels?: number | MetricLabels, labelsOrAmount?: MetricLabels | number): void {
    let amount = 1;
    let actualLabels: MetricLabels | undefined;
    if (typeof amountOrLabels === "number") {
      amount = amountOrLabels;
      actualLabels = typeof labelsOrAmount === "object" ? labelsOrAmount : undefined;
    } else if (typeof amountOrLabels === "object" && amountOrLabels !== null) {
      actualLabels = amountOrLabels;
      amount = typeof labelsOrAmount === "number" ? labelsOrAmount : 1;
    }
    if (amount < 0) throw new Error(`Counter ${this.name} increment must be non-negative, got ${amount}`);
    if (isNaN(amount) || !isFinite(amount)) return;
    const key = labelKey(this.labelNames, actualLabels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      this.values.set(key, { value: amount, labels: actualLabels });
    }
  }

  get(labels?: MetricLabels): number {
    const key = labelKey(this.labelNames, labels);
    return this.values.get(key)?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  scrape(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0) {
      if (this.labelNames.length === 0) {
        lines.push(`${this.name} 0`);
      }
    } else {
      for (const entry of this.values.values()) {
        const lbls = formatLabels(this.labelNames, entry.labels);
        lines.push(`${this.name}${lbls} ${entry.value}`);
      }
    }
    return lines.join("\n");
  }
}

export class Gauge implements Metric {
  readonly type = "gauge" as const;
  private values = new Map<string, { value: number; labels?: MetricLabels }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = []
  ) {}

  set(valOrLabels: number | MetricLabels, valOrLabels2?: number | MetricLabels): void {
    let val = 0;
    let actualLabels: MetricLabels | undefined;
    if (typeof valOrLabels === "number") {
      val = valOrLabels;
      actualLabels = typeof valOrLabels2 === "object" ? valOrLabels2 : undefined;
    } else if (typeof valOrLabels === "object" && valOrLabels !== null) {
      actualLabels = valOrLabels;
      val = typeof valOrLabels2 === "number" ? valOrLabels2 : 0;
    }
    if (isNaN(val) || !isFinite(val)) return;
    const key = labelKey(this.labelNames, actualLabels);
    this.values.set(key, { value: val, labels: actualLabels });
  }

  inc(amountOrLabels?: number | MetricLabels, labels?: MetricLabels): void {
    let amount = 1;
    let actualLabels = labels;
    if (typeof amountOrLabels === "number") {
      amount = amountOrLabels;
    } else if (typeof amountOrLabels === "object" && amountOrLabels !== null) {
      actualLabels = amountOrLabels;
    }
    if (isNaN(amount) || !isFinite(amount)) return;
    const key = labelKey(this.labelNames, actualLabels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      this.values.set(key, { value: amount, labels: actualLabels });
    }
  }

  dec(amountOrLabels?: number | MetricLabels, labels?: MetricLabels): void {
    let amount = 1;
    let actualLabels = labels;
    if (typeof amountOrLabels === "number") {
      amount = amountOrLabels;
    } else if (typeof amountOrLabels === "object" && amountOrLabels !== null) {
      actualLabels = amountOrLabels;
    }
    if (isNaN(amount) || !isFinite(amount)) return;
    const key = labelKey(this.labelNames, actualLabels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value = Math.max(0, existing.value - amount);
    } else {
      this.values.set(key, { value: 0, labels: actualLabels });
    }
  }

  get(labels?: MetricLabels): number {
    const key = labelKey(this.labelNames, labels);
    return this.values.get(key)?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  scrape(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this.values.size === 0) {
      if (this.labelNames.length === 0) {
        lines.push(`${this.name} 0`);
      }
    } else {
      for (const entry of this.values.values()) {
        const lbls = formatLabels(this.labelNames, entry.labels);
        lines.push(`${this.name}${lbls} ${entry.value}`);
      }
    }
    return lines.join("\n");
  }
}

export const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
]);

interface HistogramEntry {
  readonly labels?: MetricLabels;
  count: number;
  sum: number;
  readonly bucketCounts: number[];
}

export class Histogram implements Metric {
  readonly type = "histogram" as const;
  readonly buckets: readonly number[];
  private entries = new Map<string, HistogramEntry>();

  constructor(
    readonly name: string,
    readonly help: string,
    options?: {
      readonly labelNames?: readonly string[];
      readonly buckets?: readonly number[];
    }
  ) {
    this.labelNames = options?.labelNames ?? [];
    this.buckets = options?.buckets ? [...options.buckets].sort((a, b) => a - b) : DEFAULT_HISTOGRAM_BUCKETS;
  }

  readonly labelNames: readonly string[];

  observe(valOrLabels: number | MetricLabels, valOrLabels2?: number | MetricLabels): void {
    let val = 0;
    let labels: MetricLabels | undefined;
    if (typeof valOrLabels === "number") {
      val = valOrLabels;
      labels = typeof valOrLabels2 === "object" ? valOrLabels2 : undefined;
    } else if (typeof valOrLabels === "object" && valOrLabels !== null) {
      labels = valOrLabels;
      val = typeof valOrLabels2 === "number" ? valOrLabels2 : 0;
    }
    if (isNaN(val) || !isFinite(val) || val < 0) return;
    const key = labelKey(this.labelNames, labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        labels,
        count: 0,
        sum: 0,
        bucketCounts: new Array(this.buckets.length).fill(0),
      };
      this.entries.set(key, entry);
    }

    entry.count += 1;
    entry.sum += val;
    for (let i = 0; i < this.buckets.length; i++) {
      if (val <= this.buckets[i]!) {
        entry.bucketCounts[i] = (entry.bucketCounts[i] ?? 0) + 1;
        break;
      }
    }
  }

  get(labels?: MetricLabels): { count: number; sum: number; buckets: Record<string, number> } {
    const key = labelKey(this.labelNames, labels);
    const entry = this.entries.get(key);
    const bucketMap: Record<string, number> = {};
    if (entry) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += entry.bucketCounts[i]!;
        bucketMap[String(this.buckets[i])] = cumulative;
      }
      bucketMap["+Inf"] = entry.count;
      return { count: entry.count, sum: entry.sum, buckets: bucketMap };
    }
    for (const b of this.buckets) bucketMap[String(b)] = 0;
    bucketMap["+Inf"] = 0;
    return { count: 0, sum: 0, buckets: bucketMap };
  }

  reset(): void {
    this.entries.clear();
  }

  scrape(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    if (this.entries.size === 0) {
      if (this.labelNames.length === 0) {
        for (const bucket of this.buckets) {
          lines.push(`${this.name}_bucket{le="${bucket}"} 0`);
        }
        lines.push(`${this.name}_bucket{le="+Inf"} 0`);
        lines.push(`${this.name}_sum 0`);
        lines.push(`${this.name}_count 0`);
      }
    } else {
      for (const entry of this.entries.values()) {
        const baseLabels = formatLabels(this.labelNames, entry.labels);
        const prefix = baseLabels.length > 0 ? baseLabels.slice(1, -1) + "," : "";
        let cumulative = 0;
        for (let i = 0; i < this.buckets.length; i++) {
          cumulative += entry.bucketCounts[i]!;
          lines.push(`${this.name}_bucket{${prefix}le="${this.buckets[i]}"} ${cumulative}`);
        }
        lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${entry.count}`);
        lines.push(`${this.name}_sum${baseLabels} ${entry.sum}`);
        lines.push(`${this.name}_count${baseLabels} ${entry.count}`);
      }
    }

    return lines.join("\n");
  }
}

export class MetricsRegistry {
  private metrics = new Map<string, Metric>();

  registerCounter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    if (this.metrics.has(name)) {
      const existing = this.metrics.get(name)!;
      if (existing instanceof Counter) return existing;
      throw new Error(`Metric ${name} already registered with different type: ${existing.type}`);
    }
    const counter = new Counter(name, help, labelNames);
    this.metrics.set(name, counter);
    return counter;
  }

  registerGauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    if (this.metrics.has(name)) {
      const existing = this.metrics.get(name)!;
      if (existing instanceof Gauge) return existing;
      throw new Error(`Metric ${name} already registered with different type: ${existing.type}`);
    }
    const gauge = new Gauge(name, help, labelNames);
    this.metrics.set(name, gauge);
    return gauge;
  }

  registerHistogram(
    name: string,
    help: string,
    options?: { readonly labelNames?: readonly string[]; readonly buckets?: readonly number[] }
  ): Histogram {
    if (this.metrics.has(name)) {
      const existing = this.metrics.get(name)!;
      if (existing instanceof Histogram) return existing;
      throw new Error(`Metric ${name} already registered with different type: ${existing.type}`);
    }
    const histogram = new Histogram(name, help, options);
    this.metrics.set(name, histogram);
    return histogram;
  }

  getMetric(name: string): Metric | undefined {
    return this.metrics.get(name);
  }

  clear(): void {
    this.metrics.clear();
  }

  resetAll(): void {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  scrape(): string {
    const parts: string[] = [];
    for (const metric of this.metrics.values()) {
      parts.push(metric.scrape());
    }
    return parts.length > 0 ? parts.join("\n\n") + "\n" : "";
  }
}

export class StandardMetrics {
  readonly registry: MetricsRegistry;

  readonly jobsTotal: Counter;
  readonly jobRetriesTotal: Counter;
  readonly queueDepth: Gauge;
  readonly activeJobs: Gauge;
  readonly queueWaitingDuration: Histogram;
  readonly jobExecutionDuration: Histogram;

  readonly registeredWorkers: Gauge;
  readonly activeLeases: Gauge;
  readonly leaseRenewalsTotal: Counter;
  readonly leaseExpirationsTotal: Counter;

  readonly activeSessions: Gauge;
  readonly revisionsEvaluatedTotal: Counter;
  readonly bisectionClassificationsTotal: Counter;
  readonly oracleExecutionDuration: Histogram;
  readonly oracleExecutionDurationSeconds: Histogram;
  readonly benchmarkSamplesTotal: Counter;
  readonly benchmarkSampleDuration: Histogram;
  readonly candidateVerificationsTotal: Counter;
  readonly candidateBoundaryVerificationsTotal: Counter;

  readonly sandboxPreflightFailuresTotal: Counter;
  readonly containerExecutionDuration: Histogram;
  readonly containerExecutionDurationSeconds: Histogram;

  readonly processTimeoutsTotal: Counter;
  readonly cancellationsTotal: Counter;
  readonly processFailuresTotal: Counter;
  readonly recoveryRequiredSessionsTotal: Counter;
  readonly reportGenerationFailuresTotal: Counter;
  readonly auditEventsExportedTotal: Counter;

  readonly fleetSchedulingDelay: Histogram;
  readonly staleResultsRejectedTotal: Counter;
  readonly samplesTotal: Counter;
  readonly workerDisconnectionsTotal: Counter;
  readonly workerConcurrencyCapacity: Gauge;
  readonly workerConcurrencyUtilized: Gauge;

  constructor(registry: MetricsRegistry = new MetricsRegistry()) {
    this.registry = registry;

    this.jobsTotal = registry.registerCounter(
      "bisectpilot_jobs_total",
      "Total number of durable jobs processed by lifecycle state",
      ["state"]
    );
    this.jobRetriesTotal = registry.registerCounter(
      "bisectpilot_job_retries_total",
      "Total number of job retry and recovery operations initiated"
    );
    this.queueDepth = registry.registerGauge(
      "bisectpilot_queue_depth",
      "Current number of queued jobs awaiting lease"
    );
    this.activeJobs = registry.registerGauge(
      "bisectpilot_active_jobs",
      "Current number of actively leased and running jobs"
    );
    this.queueWaitingDuration = registry.registerHistogram(
      "bisectpilot_queue_waiting_duration_seconds",
      "Duration jobs spend queued before lease acquisition in seconds",
      { buckets: [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120] }
    );
    this.jobExecutionDuration = registry.registerHistogram(
      "bisectpilot_job_execution_duration_seconds",
      "Total execution duration of jobs in seconds",
      { buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600] }
    );

    this.registeredWorkers = registry.registerGauge(
      "bisectpilot_registered_workers",
      "Current count of registered pull workers by state",
      ["state"]
    );
    this.activeLeases = registry.registerGauge(
      "bisectpilot_active_leases",
      "Current number of active worker job leases"
    );
    this.leaseRenewalsTotal = registry.registerCounter(
      "bisectpilot_lease_renewals_total",
      "Total number of heartbeat lease renewals",
      ["status"]
    );
    this.leaseExpirationsTotal = registry.registerCounter(
      "bisectpilot_lease_expirations_total",
      "Total number of expired leases"
    );

    this.activeSessions = registry.registerGauge(
      "bisectpilot_active_sessions",
      "Current number of active bisection sessions"
    );
    this.revisionsEvaluatedTotal = registry.registerCounter(
      "bisectpilot_revisions_evaluated_total",
      "Total revisions evaluated by oracle classification",
      ["classification"]
    );
    this.bisectionClassificationsTotal = registry.registerCounter(
      "bisectpilot_bisection_classifications_total",
      "Cumulative bisection outcome classifications",
      ["classification"]
    );
    this.oracleExecutionDuration = registry.registerHistogram(
      "bisectpilot_oracle_execution_duration_seconds",
      "Oracle command execution duration in seconds",
      { labelNames: ["mode"], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] }
    );
    this.oracleExecutionDurationSeconds = this.oracleExecutionDuration;

    this.benchmarkSamplesTotal = registry.registerCounter(
      "bisectpilot_benchmark_samples_total",
      "Total individual benchmark samples collected",
      ["metric"]
    );
    this.benchmarkSampleDuration = registry.registerHistogram(
      "bisectpilot_benchmark_sample_duration_seconds",
      "Benchmark sample run duration in seconds",
      { buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] }
    );
    this.candidateVerificationsTotal = registry.registerCounter(
      "bisectpilot_candidate_verifications_total",
      "Total boundary candidate confirmations",
      ["outcome"]
    );
    this.candidateBoundaryVerificationsTotal = this.candidateVerificationsTotal;

    this.sandboxPreflightFailuresTotal = registry.registerCounter(
      "bisectpilot_sandbox_preflight_failures_total",
      "Total sandbox preflight and isolation validation failures",
      ["reason"]
    );
    this.containerExecutionDuration = registry.registerHistogram(
      "bisectpilot_container_execution_duration_seconds",
      "Container sandbox execution duration in seconds",
      { labelNames: ["runtime"], buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120] }
    );
    this.containerExecutionDurationSeconds = this.containerExecutionDuration;

    this.processTimeoutsTotal = registry.registerCounter(
      "bisectpilot_process_timeouts_total",
      "Total subprocess execution timeouts",
      ["phase"]
    );
    this.cancellationsTotal = registry.registerCounter(
      "bisectpilot_cancellations_total",
      "Total job or bisection cancellations requested",
      ["scope"]
    );
    this.processFailuresTotal = registry.registerCounter(
      "bisectpilot_process_failures_total",
      "Total abnormal subprocess execution failures",
      ["phase"]
    );
    this.recoveryRequiredSessionsTotal = registry.registerCounter(
      "bisectpilot_recovery_required_sessions_total",
      "Total sessions detected in non-terminal state requiring crash recovery"
    );
    this.reportGenerationFailuresTotal = registry.registerCounter(
      "bisectpilot_report_generation_failures_total",
      "Total report generation failures by format",
      ["format"]
    );
    this.auditEventsExportedTotal = registry.registerCounter(
      "bisectpilot_audit_events_exported_total",
      "Total audit ledger events exported by status",
      ["status"]
    );

    this.fleetSchedulingDelay = registry.registerHistogram(
      "bisectpilot_fleet_scheduling_delay_seconds",
      "Scheduling delay from job queue creation to worker lease acquisition",
      { buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30] }
    );
    this.staleResultsRejectedTotal = registry.registerCounter(
      "bisectpilot_stale_results_rejected_total",
      "Total worker results rejected due to stale attempts, fencing mismatches or expired leases",
      ["reason"]
    );
    this.samplesTotal = registry.registerCounter(
      "bisectpilot_samples_total",
      "Total independent oracle and benchmark samples processed across the fleet",
      ["type", "status"]
    );
    this.workerDisconnectionsTotal = registry.registerCounter(
      "bisectpilot_worker_disconnections_total",
      "Total worker disconnections and heartbeat expirations"
    );
    this.workerConcurrencyCapacity = registry.registerGauge(
      "bisectpilot_worker_concurrency_capacity",
      "Total configured concurrency capacity across all registered workers"
    );
    this.workerConcurrencyUtilized = registry.registerGauge(
      "bisectpilot_worker_concurrency_utilized",
      "Current number of concurrently active leased or running jobs"
    );
  }
}

export const defaultMetricsRegistry = new MetricsRegistry();
export const defaultMetrics = new StandardMetrics(defaultMetricsRegistry);
