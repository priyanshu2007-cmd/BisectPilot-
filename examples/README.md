# BisectPilot Examples & Walkthroughs

This directory contains end-to-end reproducible examples of BisectPilot isolating regressions across public repositories and local test setups.

<!-- DEMO GIF PLACEHOLDER: terminal recording not generated in headless environment -->

## Available Walkthroughs

1. [Real-World Public Regression: `vercel/ms`](#1-real-world-public-regression-vercelms)
2. [Deterministic Offline Planted Regression (`examples/planted-regression/`)](#2-deterministic-offline-planted-regression)

---

## 1. Real-World Public Regression: `vercel/ms`

In this real-world scenario, we use BisectPilot to identify the exact commit that introduced a behavior change in the popular [`vercel/ms`](https://github.com/vercel/ms) utility.

- **Repository**: `https://github.com/vercel/ms`
- **Known-Good Reference**: `fff6c4f16b6b17708a80fc59e83eff31bf70d4a3` (commit where `"1w"` support did not yet exist)
- **Known-Bad Bound**: `bf54305^` (commit where `"1w"` support is present)
- **Target First-Bad Commit**: `a2caead13ac7f9931338a1a51ab4e36ddb505e00` (`Add "week" / "w" support`)

### Reproduction Steps

1. Clone the repository:
   ```bash
   git clone https://github.com/vercel/ms.git
   cd ms
   ```

2. Run BisectPilot with an inline oracle command (zero config required):
   ```bash
   npx bisectpilot start \
     --good fff6c4f16b6b17708a80fc59e83eff31bf70d4a3 \
     --bad bf54305^ \
     --yes \
     -- node -e 'const ms = require("./index"); if (ms("1w") === 604800000) process.exit(1);'
   ```

### Verified Execution Output

```text
Session: bp-18d857d5
Result: OK
State: concluded
Outcome: candidate_confirmed
Candidate: a2caead1 — Add "week" / "w" support
Parent: e359eee3 — Add reference to ms.macro (#99)
Evaluated revisions: 7
Skipped revisions: 0
Summary: Confirmed a2caead13ac7f9931338a1a51ab4e36ddb505e00 as first bad commit (3/3 bad; parent e359eee3 3/3 good).
```

### Verification & Tamper-Evident Report

After the bisection concludes, verify the append-only cryptographic hash chain:

```bash
npx bisectpilot report --verify
```

Output:
```text
OK Ledger verified: 48 events, hash chain intact
```

---

## 2. Deterministic Offline Planted Regression

For environments without public internet access, a fully automated, offline fixture script is provided in [`examples/planted-regression/`](./planted-regression/).

### Running the Example

```bash
./examples/planted-regression/run.sh
```

This script:
1. Creates a clean temporary repository in `$TMPDIR`.
2. Generates four commits (including a clean baseline and a planted functional defect in `math.js`).
3. Executes BisectPilot against the commits using an isolated worktree.
4. Confirms that BisectPilot pinpoints the exact culprit commit.
5. Cleans up all temporary repositories and session files.
