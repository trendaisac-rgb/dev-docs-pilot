import { ExternalLink } from "lucide-react";
import type { RetrievedChunk } from "@/lib/types";

interface Props {
  chunks: RetrievedChunk[];
}

/**
 * RetrievalInspector — opens up a single search step to show the actual
 * chunks the retriever surfaced, in final ranked order, with BOTH scores:
 *
 *   - similarity   : raw pgvector cosine similarity (relatedness)
 *   - rerank       : the LLM-as-judge relevance (sufficiency)
 *
 * The split is the whole point — it shows that cosine similarity measures
 * "is this about the same topic", not "does this actually answer the
 * question", which is why the reranker exists.
 */
export function RetrievalInspector({ chunks }: Props) {
  if (!chunks || chunks.length === 0) {
    return (
      <div className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
        No chunks were returned for this search.
      </div>
    );
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex items-center gap-3 px-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-sm bg-muted-foreground/50" />
          similarity (vector)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-sm bg-primary" />
          rerank (LLM-judge)
        </span>
      </div>
      <ol className="space-y-1.5">
        {chunks.map((c, i) => (
          <ChunkRow key={`${c.url}-${i}`} chunk={c} rank={i + 1} />
        ))}
      </ol>
    </div>
  );
}

function ChunkRow({ chunk, rank }: { chunk: RetrievedChunk; rank: number }) {
  const judged = typeof chunk.rerankRelevance === "number";
  return (
    <li className="rounded-md border border-border bg-background/60 p-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-muted font-mono text-[10px] text-muted-foreground tabular-nums">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="text-xs font-medium text-foreground">
                {chunk.title}
              </span>
              {chunk.section && (
                <span className="text-xs text-muted-foreground">
                  {" "}
                  › {chunk.section}
                </span>
              )}
            </div>
            <a
              href={chunk.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
              title={chunk.url}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {/* score bars */}
          <div className="mt-1.5 space-y-1">
            <ScoreBar
              value={chunk.similarity}
              tone="muted"
              label="similarity"
            />
            <ScoreBar
              value={chunk.rerankRelevance ?? null}
              tone="primary"
              label={judged ? "rerank" : "not judged"}
            />
          </div>

          <p className="mt-1.5 line-clamp-3 font-mono text-[10.5px] leading-snug text-muted-foreground/80">
            {chunk.content}
          </p>
        </div>
      </div>
    </li>
  );
}

function ScoreBar({
  value,
  tone,
  label,
}: {
  value: number | null;
  tone: "muted" | "primary";
  label: string;
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  const barColor = tone === "primary" ? "bg-primary" : "bg-muted-foreground/50";
  return (
    <div className="flex items-center gap-2">
      <span className="w-[68px] shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground/60">
        {label}
      </span>
      <div className="flex h-1 flex-1 overflow-hidden rounded-full bg-muted">
        {value !== null && (
          <div className={barColor} style={{ width: `${pct}%` }} />
        )}
      </div>
      <span className="w-[34px] shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {value === null ? "—" : value.toFixed(2)}
      </span>
    </div>
  );
}
