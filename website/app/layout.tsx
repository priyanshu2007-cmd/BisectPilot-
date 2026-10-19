import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "BisectPilot — Find the turn that changed everything",
    template: "%s — BisectPilot",
  },
  description:
    "BisectPilot helps AI teams trace a behavioral regression back to the prompt, tool, or model change that introduced it.",
  applicationName: "BisectPilot",
  keywords: ["AI evaluation", "agent observability", "regression analysis", "prompt testing"],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "BisectPilot",
    title: "BisectPilot — Find the turn that changed everything",
    description:
      "A focused replay console for tracing AI agent regressions to their first bad turn.",
  },
  twitter: {
    card: "summary_large_image",
    title: "BisectPilot — Find the turn that changed everything",
    description:
      "Trace an AI agent regression to the first bad turn, with evidence attached.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#111313",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
