import { ExternalLink } from "lucide-react";
import type { Citation } from "@/lib/types";

interface Props {
  citations: Citation[];
}

export function SourcesPanel({ citations }: Props) {
  return (
    <aside className="hidden lg:flex w-[360px] shrink-0 flex-col border-l border-border bg-sidebar">
      <div className="sticky top-0 z-10 border-b border-border bg-sidebar/95 backdrop-blur px-5 py-4">
        <h2 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Sources
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Citations from the latest answer
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {citations.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
            No sources cited for this answer.
          </div>
        ) : (
          citations.map((c) => <SourceCard key={c.url} citation={c} />)
        )}
      </div>
    </aside>
  );
}

function SourceCard({ citation }: { citation: Citation }) {
  const u = (() => {
    try {
      return new URL(citation.url);
    } catch {
      return null;
    }
  })();
  const host = u?.hostname.replace(/^www\./, "") ?? "";
  const path = u?.pathname.replace(/\/$/, "") ?? "";

  return (
    <a
      href={citation.url}
      target="_blank"
      rel="noreferrer"
      className="group block rounded-md border border-border bg-card p-3 hover:border-primary/40 hover:bg-accent transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium leading-snug text-foreground line-clamp-2">
          {citation.title}
        </div>
        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      {host && (
        <div className="mt-1.5 text-[11px] font-mono text-muted-foreground truncate">
          {host}
          {path}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <div className="flex h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="bg-primary"
            style={{ width: `${Math.round(citation.relevance * 100)}%` }}
          />
        </div>
        <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
          {citation.relevance.toFixed(2)}
        </span>
      </div>
    </a>
  );
}
