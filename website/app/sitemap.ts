import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  return [
    {
      url: baseUrl,
      lastModified: new Date("2026-01-01"),
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${baseUrl}/explorer`,
      lastModified: new Date("2026-01-01"),
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/docs`,
      lastModified: new Date("2026-01-01"),
      changeFrequency: "monthly",
      priority: 0.7,
    },
  ];
}
