"use client";

import { useEffect } from "react";

/**
 * Last resort: a throw in the root layout itself, where `error.tsx` cannot help
 * because the layout that would wrap it is the thing that failed. It has to render
 * its own `<html>`/`<body>`, so it gets no theme, no fonts and no Tailwind tokens —
 * hence the inline styles.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[root render]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#1e1e2e",
          color: "#cdd6f4",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: "32rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>
            The dashboard failed to load
          </h1>
          <p style={{ color: "#a6adc8", fontSize: "0.9rem", lineHeight: 1.6 }}>
            The game servers are unaffected — this is the web app only. Reload, and if
            it keeps happening check the <code>yoshling-web-1</code> container log.
          </p>
          <p
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.75rem",
              color: "#a6adc8",
              background: "#181825",
              padding: "0.75rem",
              borderRadius: "0.5rem",
              wordBreak: "break-word",
            }}
          >
            {error.message || "No message"}
            {error.digest ? ` (${error.digest})` : ""}
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: "0.5rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "1px solid #45475a",
              background: "#313244",
              color: "#cdd6f4",
              cursor: "pointer",
              font: "inherit",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
