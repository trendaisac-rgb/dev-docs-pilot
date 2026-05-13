import type { Citation } from "./types";

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

export function extractCitations(markdown: string): Citation[] {
  const seen = new Map<string, { title: string; firstIndex: number }>();
  let m: RegExpExecArray | null;
  let order = 0;
  while ((m = LINK_RE.exec(markdown)) !== null) {
    const title = m[1].trim();
    const url = m[2].trim();
    if (!seen.has(url)) {
      seen.set(url, { title, firstIndex: order++ });
    }
  }
  const total = seen.size;
  if (total === 0) return [];
  return Array.from(seen.entries()).map(([url, v]) => ({
    url,
    title: v.title,
    relevance: total === 1 ? 1 : 1 - (v.firstIndex / (total - 1)) * 0.7, // 1.0 → 0.3
  }));
}
