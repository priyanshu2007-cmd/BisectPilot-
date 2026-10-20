# Performance Regression Bisection

### Performance Regression Bisection (`--metric`)

When investigating a latency or throughput regression rather than a pass/fail test failure:

```bash
bisectpilot start \
  --config bisectpilot.config.json \
  --metric p95_latency_ms \
  --unit ms \
  --threshold 120 \
  --relative-regression 15% \
  --direction higher_is_worse \
  --warmup 1 \
  --samples 5 \
  --max-samples 10 \
  --alpha 0.05 \
  --yes
```

- **Metric output format:** Your oracle command must print the metric to `stdout` or `stderr` as JSON (e.g., `{"p95_latency_ms": 142.5}` or `{"metrics": {"p95_latency_ms": 142.5}}`) or key-value text (e.g., `p95_latency_ms: 142.5 ms`). Non-finite values (`NaN`, `Infinity`) or unit mismatches are rejected.
- **Decision rule:** Preflight collects baseline statistics at `goodRef` and verifies the regression at `badRef`. During bisection, a revision is classified `bad` only when it breaches the practical threshold (`--threshold` and/or `--relative-regression`) **and** achieves statistical significance ($p < \alpha$ via Welch's two-sample t-test).
- **Limitations:** Statistical tests reduce false positives from normal variance on a quiet machine, but they cannot eliminate host-level CPU contention, thermal throttling, or external network jitter. Run performance bisections on an idle machine with sufficient `--warmup` and `--samples`, and treat high-variance `inconclusive` outcomes as a signal to increase sample counts or quiet the host.

