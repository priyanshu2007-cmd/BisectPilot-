import type { Metadata } from "next";
import Link from "next/link";
import PilotConsole from "@/components/PilotConsole";

export const metadata: Metadata = {
  title: "Find the turn that changed everything",
  description:
    "A visual landing page and replay console for tracing AI agent regressions to the first bad turn.",
};

const workflow = [
  {
    title: "Capture the signal",
    description:
      "Keep the successful run and the failing run side by side. BisectPilot preserves the context humans usually lose in a log export.",
    marker: "A",
  },
  {
    title: "Walk the turns",
    description:
      "Replay the conversation, tool calls, and model settings as one continuous trail instead of a pile of disconnected traces.",
    marker: "B",
  },
  {
    title: "Name the change",
    description:
      "Attach the first divergence to a commit, prompt version, or tool response so the next fix has somewhere precise to start.",
    marker: "C",
  },
];

const signalRows = [
  ["run_id", "run_8f2a", "stable"],
  ["model", "sonnet-4.5", "stable"],
  ["tool_calls", "07 → 09", "changed"],
  ["first_drift", "turn 04", "flagged"],
];

export default function HomePage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "BisectPilot",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    description:
      "A replay console for tracing AI agent regressions to their first bad turn.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

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

          <nav className="main-nav" aria-label="Main navigation">
            <a href="#method">The method</a>
            <Link href="/explorer">Explorer</Link>
            <a href="#workflow">Workflow</a>
            <Link href="/docs">Docs</Link>
          </nav>

          <Link className="header-cta" href="/explorer">
            Open full explorer <span aria-hidden="true">↘</span>
          </Link>
        </div>
      </header>

      <section className="hero shell" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="eyebrow-dot" />
            Agent regression field notes / 001
          </p>
          <h1 id="hero-heading">
            Find the turn
            <br />
            that changed <em>everything.</em>
          </h1>
          <p className="hero-lede">
            BisectPilot makes an AI regression feel less like archaeology. Replay two
            runs, follow the evidence, and land on the first bad turn.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/explorer">
              Launch replay explorer <span aria-hidden="true">↘</span>
            </Link>
            <a className="text-link" href="#console">
              Preview inline console <span aria-hidden="true">→</span>
            </a>
          </div>
          <div className="hero-proof" aria-label="Product highlights">
            <span>
              <strong>2</strong> runs in context
            </span>
            <span>
              <strong>1</strong> first divergence
            </span>
            <span>
              <strong>0</strong> guesswork
            </span>
          </div>
        </div>

        <div className="hero-graphic" aria-label="Abstract replay timeline illustration" role="img">
          <div className="graphic-grid" aria-hidden="true" />
          <div className="orbit orbit-one" aria-hidden="true" />
          <div className="orbit orbit-two" aria-hidden="true" />
          <div className="signal-point signal-point-one" aria-hidden="true">
            <span />
          </div>
          <div className="signal-point signal-point-two" aria-hidden="true">
            <span />
          </div>
          <div className="signal-point signal-point-three" aria-hidden="true">
            <span />
          </div>
          <div className="hero-annotation annotation-top">change surface / 04</div>
          <div className="hero-annotation annotation-bottom">evidence stays attached</div>
          <div className="hero-graphic-label">
            <span className="label-line" />
            <span>
              same prompt
              <br />
              different outcome
            </span>
          </div>
        </div>
      </section>

      <section className="ticker" aria-label="BisectPilot capabilities">
        <div className="ticker-track">
          <span>Prompt diffs</span>
          <i aria-hidden="true" />
          <span>Tool replay</span>
          <i aria-hidden="true" />
          <span>Model snapshots</span>
          <i aria-hidden="true" />
          <span>Human-readable evidence</span>
          <i aria-hidden="true" />
          <span>Prompt diffs</span>
          <i aria-hidden="true" />
          <span>Tool replay</span>
          <i aria-hidden="true" />
          <span>Model snapshots</span>
          <i aria-hidden="true" />
        </div>
      </section>

      <section className="method-section shell" id="method" aria-labelledby="method-heading">
        <div className="section-intro">
          <p className="eyebrow">The method</p>
          <h2 id="method-heading">
            A regression is a story
            <br />
            with a missing page.
          </h2>
        </div>
        <div className="method-aside">
          <p>
            Logs tell you what happened. Bisection tells you when the story changed.
            BisectPilot keeps the surrounding context intact while it narrows the search.
          </p>
          <a className="text-link" href="#workflow">
            See the three moves <span aria-hidden="true">↘</span>
          </a>
        </div>
      </section>

      <section className="console-wrap" id="console" aria-labelledby="console-heading">
        <div className="shell">
          <div className="console-heading-row">
            <div>
              <p className="eyebrow">Live specimen / replay console</p>
              <h2 id="console-heading">
                A closer look at <em>run_8f2a</em>
              </h2>
            </div>
            <Link className="text-link" href="/explorer">
              Open full-screen explorer <span aria-hidden="true">↗</span>
            </Link>
          </div>
          <PilotConsole />
        </div>
      </section>

      <section className="signals-section shell" aria-labelledby="signals-heading">
        <div className="signals-copy">
          <p className="eyebrow">What stays visible</p>
          <h2 id="signals-heading">
            The useful details
            <br />
            never leave the frame.
          </h2>
          <p>
            Context is the difference between a fix and a theory. The console keeps model,
            prompt, tool, and timing signals close enough to compare in one glance.
          </p>
        </div>
        <div className="signal-table-wrap">
          <div className="signal-table-head">
            <span>signal</span>
            <span>value</span>
            <span>read</span>
          </div>
          {signalRows.map(([label, value, state]) => (
            <div className="signal-table-row" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
              <span className={`signal-state state-${state}`}>{state}</span>
            </div>
          ))}
          <div className="table-footnote">
            <span className="tiny-cross" aria-hidden="true">
              ×
            </span>{" "}
            signal changed between known-good and current
          </div>
        </div>
      </section>

      <section className="workflow-section" id="workflow" aria-labelledby="workflow-heading">
        <div className="shell">
          <div className="workflow-head">
            <div>
              <p className="eyebrow">The workflow</p>
              <h2 id="workflow-heading">
                Three moves from “weird”
                <br />
                to “we know why.”
              </h2>
            </div>
            <p>Designed for the moment after the alert, before the fix.</p>
          </div>
          <div className="workflow-grid">
            {workflow.map((step) => (
              <article className="workflow-card" key={step.marker}>
                <div className="workflow-marker" aria-hidden="true">
                  {step.marker}
                </div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
                <span className="card-rule" aria-hidden="true" />
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="closing-section shell" aria-labelledby="closing-heading">
        <div className="closing-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">Start with a question, not a dashboard</p>
        <h2 id="closing-heading">
          What changed
          <br />
          <em>right here?</em>
        </h2>
        <Link className="button button-primary" href="/explorer">
          Open the replay explorer <span aria-hidden="true">↘</span>
        </Link>
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
          <p>Regression analysis for systems that learn in public.</p>
          <div className="footer-links">
            <Link href="/explorer">Explorer</Link>
            <Link href="/docs">Docs</Link>
            <a href="mailto:hello@bisectpilot.dev">Contact</a>
            <span>© 2026</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
