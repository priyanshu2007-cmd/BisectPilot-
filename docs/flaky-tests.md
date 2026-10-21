# Flaky & Noisy Test Bisection

## Flaky / Noisy Test Bisection (`--noisy`)

When a test fails intermittently on broken commits:

```bash
bisectpilot start \
  --config bisectpilot.config.json \
  --noisy \
  --yes
```

- Uses sequential Bayesian updates with configurable `maxSamplesPerRevision` (`5`), `confidenceThreshold` (`0.90`), and `flakeRate` (`0.10`). If confidence does not reach the threshold within the sample budget, the revision is marked `skip` (`125`) rather than guessing.

---
