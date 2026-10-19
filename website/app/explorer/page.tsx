import type { Metadata } from "next";
import Link from "next/link";
import PilotConsole from "@/components/PilotConsole";

export const metadata: Metadata = {
  title: "Replay Explorer — BisectPilot",
  description:
    "Interactive side-by-side run explorer for bisecting AI agent regressions down to the first causal turn, tool schema diff, or prompt change.",
  alternates: {
    canonical: "/explorer",
  },
};

const quickShortcuts = [
  { key: "j / k", label: "Step next / previous turn" },
  { key: "/", label: "Focus trail search" },
  { key: "First drift", label: "Jump to root divergence" },
  { key: "Diff / Current / Good", label: "Switch comparison lens" },
];

export default function ExplorerPage() {
  return (
    <main className="explorer-page">
      <header className="site-header">
        <div className="shell header-inner">
          <Link className="wordmark" href="/" aria-label="BisectPilot home">
            <span className="wordmark-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>BisectPilot</span>
          </Link>

          <nav className="main-nav" aria-label="Explorer navigation">
            <Link href="/">Overview</Link>
            <Link href="/explorer" className="nav-active" aria-current="page">
              Explorer
            </Link>
            <Link href="/docs">Docs</Link>
          </nav>

          <Link className="header-cta" href="/docs">
            Read bisection guide <span aria-hidden="true">→</span>
          </Link>
        </div>
      </header>

      <section className="explorer-hero shell" aria-labelledby="explorer-heading">
        <div className="explorer-hero-top">
          <div>
            <p className="eyebrow">
              <span className="eyebrow-dot" />
              Interactive bisection workbench / live specimens
            </p>
            <h1 id="explorer-heading" className="explorer-title">
              Trace the exact turn where{" "}
              <em>behavior diverged.</em>
            </h1>
          </div>

          <div className="explorer-shortcuts" aria-label="Keyboard and toolbar controls">
            {quickShortcuts.map((item) => (
              <div className="shortcut-chip" key={item.key}>
                <kbd>{item.key}</kbd>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="explorer-workspace shell" aria-label="Replay console">
        <PilotConsole fullPage />
      </section>

      <section className="explorer-diagnostics shell" aria-labelledby="diagnostics-heading">
        <div className="diagnostics-grid">
          <div className="diagnostic-item">
            <p className="eyebrow">01 / binary search</p>
            <h2 id="diagnostics-heading">Isolate the boundary turn</h2>
            <p>
              Turns 01–02 hold invariant across both runs. Turn 03 introduces a wider retriever window
              (<code>top_k: 4 → 6</code>), and Turn 04 flips the planner decision.
            </p>
          </div>
          <div className="diagnostic-item">
            <p className="eyebrow">02 / side-by-side payload diff</p>
            <h2>Compare inputs, not theories</h2>
            <p>
              Toggle between <strong>side-by-side diff</strong>, <strong>current</strong>, and{" "}
              <strong>known-good</strong> lenses to inspect exact prompt digests, tool schemas, and latency deltas.
            </p>
          </div>
          <div className="diagnostic-item">
            <p className="eyebrow">03 / reproducible handoff</p>
            <h2>Attach commit &amp; CLI repro</h2>
            <p>
              Switch to the <strong>evidence</strong> or <strong>notes</strong> tab to copy the exact CLI
              bisection command and record engineering hypotheses directly on the suspect turn.
            </p>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="shell footer-inner">
          <Link className="wordmark" href="/" aria-label="BisectPilot home">
            <span className="wordmark-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>BisectPilot</span>
          </Link>
          <p>Deterministic regression bisection for production AI systems.</p>
          <div className="footer-links">
            <Link href="/">Home</Link>
            <Link href="/docs">Docs</Link>
            <span>© 2026</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
