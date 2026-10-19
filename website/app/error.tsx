"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="error-page">
      <div>
        <p className="eyebrow" style={{ justifyContent: "center" }}><span className="eyebrow-dot" />unexpected divergence / 500</p>
        <h1>The signal<br /><em>went sideways.</em></h1>
        <p>Something interrupted this view. Try the replay again, or return to the landing page.</p>
        <div className="hero-actions" style={{ justifyContent: "center", marginBottom: 0 }}>
          <button className="button button-primary" type="button" onClick={() => reset()}>Try again <span aria-hidden="true">↻</span></button>
          <Link className="text-link" href="/">Back home <span aria-hidden="true">↘</span></Link>
        </div>
      </div>
    </main>
  );
}
