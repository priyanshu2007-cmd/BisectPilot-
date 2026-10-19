import Link from "next/link";

export default function NotFound() {
  return (
    <main className="error-page">
      <div>
        <p className="eyebrow" style={{ justifyContent: "center" }}><span className="eyebrow-dot" />signal lost / 404</p>
        <h1>That turn<br /><em>isn’t here.</em></h1>
        <p>The page you followed does not exist in this run. Return to the console and start from a known-good state.</p>
        <Link className="button button-primary" href="/">Back to BisectPilot <span aria-hidden="true">↘</span></Link>
      </div>
    </main>
  );
}
