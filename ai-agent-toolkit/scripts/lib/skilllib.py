"""Shared helpers: frontmatter parsing and keyword categorisation. Stdlib only."""
import re
from pathlib import Path

# category -> keywords matched against skill name + description (and queries)
CATEGORIES = {
    "website": ["website", "web design", "landing", "frontend", "front-end", "ui ", "ux", "css", "html", "tailwind", "shadcn", "layout", "responsive", "page"],
    "design": ["design", "taste", "typography", "animation", "visual", "aesthetic", "polish", "motion", "brand"],
    "react-nextjs": ["react", "next.js", "nextjs", "jsx", "turbopack", "server component", "vercel"],
    "accessibility": ["accessib", "a11y", "wcag", "aria", "screen reader"],
    "performance": ["performance", "optimiz", "bundle", "core web vitals", "lighthouse", "latency", "cache"],
    "seo": ["seo", "metadata", "sitemap", "open graph"],
    "coding": ["code", "coding", "refactor", "implement", "patch", "guidelines", "simplif"],
    "debugging": ["debug", "bug", "root cause", "stack trace", "regression", "diagnos"],
    "testing": ["test", "tdd", "e2e", "playwright", "verification", "verify", "qa", "coverage"],
    "browser": ["browser", "cdp", "chrome", "scrape", "scraping", "headless", "playwright", "automation"],
    "security": ["security", "vulnerab", "owasp", "pentest", "secret", "xss", "csrf", "injection", "audit", "threat"],
    "api-mcp": ["api", "mcp", "openapi", "sdk", "webhook", "endpoint", "integration", "rest "],
    "research": ["research", "documentation", "docs", "library docs", "lookup", "compare", "evidence", "search"],
    "tokens": ["token", "concise", "terse", "caveman", "context budget", "brevity", "compress"],
    "process": ["plan", "brainstorm", "workflow", "spec", "review", "worktree", "subagent", "process"],
    "diagrams": ["diagram", "architecture", "sequence", "mermaid", "flowchart"],
    "deploy": ["deploy", "ci/cd", "production", "release", "hosting"],
}

def categorize(text):
    t = " " + text.lower() + " "
    return sorted(c for c, kws in CATEGORIES.items() if any(k in t for k in kws))

def parse_frontmatter(path):
    """Return dict of top-level scalar keys from the leading --- block ({} if none)."""
    try:
        txt = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    m = re.match(r"^---\s*\n(.*?)\n---\s*(\n|$)", txt, re.S)
    if not m:
        return {}
    out, key, lines = {}, None, []
    def flush():
        if key is not None:
            v = " ".join(s.strip() for s in lines).strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            out[key] = v
    for raw in m.group(1).split("\n"):
        km = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", raw)
        if km and not raw.startswith((" ", "\t")):
            flush()
            key, v = km.group(1), km.group(2)
            lines = [] if v in ("|", ">", "|-", ">-", "") else [v]
        elif key is not None:
            lines.append(raw)
    flush()
    return out
