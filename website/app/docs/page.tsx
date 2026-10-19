import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How BisectPilot works",
  description:
    "The BisectPilot method: compare runs, walk the turns, and attach the first divergence to evidence.",
  alternates: {
    canonical: "/docs",
  },
};

export default function DocsPage() {
  return (
    <main className="docs-page">
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
          <nav className="main-nav" aria-label="Documentation navigation">
            <Link href="/">Overview</Link>
            <Link href="/explorer">Explorer</Link>
            <Link href="/docs" className="nav-active" aria-current="page">
              Docs
            </Link>
          </nav>
          <Link className="header-cta" href="/explorer">
            Open replay explorer <span aria-hidden="true">↘</span>
          </Link>
        </div>
      </header>

      <div className="shell docs-main">
        <p className="eyebrow">
          <span className="eyebrow-dot" />
          Field notes / getting oriented
        </p>
        <h1>Make the first bad turn impossible to miss.</h1>
        <p className="docs-intro">
          BisectPilot is a small, opinionated surface for a common debugging problem:
          the answer changed, but the reason is spread across prompts, tools, settings,
          and time.
        </p>

        <div className="docs-grid">
          <nav className="docs-nav" aria-label="On this page">
            <a href="#start">Start here</a>
            <a href="#compare">Compare runs</a>
            <a href="#divergence">Find divergence</a>
            <a href="#evidence">Keep evidence</a>
          </nav>

          <article className="docs-copy">
            <section id="start">
              <p className="eyebrow">01 / the premise</p>
              <h2>Start with two truths.</h2>
              <p>
                Pick one run that did what you wanted and one run that did not. They are
                your known-good and current snapshots. The goal is not to label a run
                “bad”; it is to find the earliest moment the two stop telling the same story.
              </p>
              <div className="docs-callout">
                Good bisection asks: “What is the smallest difference that explains the
                biggest change?”
              </div>
            </section>

            <section id="compare">
              <p className="eyebrow">02 / the frame</p>
              <h2>Compare the context, not just the output.</h2>
              <p>
                A final answer is the end of a chain. Keep the inputs that shaped it in the
                frame so a behavioral change can be read against its surroundings.
              </p>
              <h3>Signals worth keeping close</h3>
              <ul>
                <li>Prompt and system-policy versions, including the exact rendered text.</li>
                <li>Model, temperature, tool schema, and retrieval settings.</li>
                <li>Tool arguments, response shape, latency, and retry history.</li>
              </ul>
            </section>

            <section id="divergence">
              <p className="eyebrow">03 / the move</p>
              <h2>Walk until the story changes.</h2>
              <p>
                Replay each turn in order. Stable turns become your boundary. Changed turns
                become your shortlist. When the first semantic drift appears, stop: that is
                where the investigation gets specific.
              </p>
              <div className="docs-callout">
                BisectPilot highlights a difference; it never pretends a correlation is a
                root cause. Attach the commit, prompt revision, or tool response that still
                needs a human decision.
              </div>
            </section>

            <section id="evidence">
              <p className="eyebrow">04 / the handoff</p>
              <h2>Leave a trail for the next fix.</h2>
              <p>
                A useful debugging artifact answers three questions: what changed, where it
                first mattered, and what to try next. Keep the run IDs and the selected
                evidence together so the handoff survives the context switch.
              </p>
              <Link className="docs-back" href="/explorer">
                Open the interactive replay explorer <span aria-hidden="true">↘</span>
              </Link>
            </section>
          </article>
        </div>
      </div>

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
            <Link href="/">Home</Link>
            <Link href="/explorer">Explorer</Link>
            <a href="mailto:hello@bisectpilot.dev">Contact</a>
            <span>© 2026</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
