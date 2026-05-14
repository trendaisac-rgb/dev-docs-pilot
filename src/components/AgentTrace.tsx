import { useState } from "react";
import {
  Sparkles,
  Search,
  BookMarked,
  PenLine,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Layers,
} from "lucide-react";
import type { TraceStep } from "@/lib/types";
import { RetrievalInspector } from "@/components/RetrievalInspector";

interface Props {
  trace: TraceStep[];
  streaming: boolean;
}

const ICONS: Record<TraceStep["kind"], typeof Search> = {
  intent: Sparkles,
  search: Search,
  cite: BookMarked,
  compose: PenLine,
};

function stepDuration(step: TraceStep): string | null {
  if (!step.endedAt) return null;
  const ms = step.endedAt - step.startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * AgentTrace — the signature view. Renders the agent's tool-use loop as a
 * live timeline so the user *sees* it think: classify the question, decide
 * what to search for (and re-search when results are weak), then compose.
 *
 * Each search step can be expanded into a Retrieval Inspector — the actual
 * chunks the retriever surfaced, with vector similarity vs. LLM-judge
 * relevance side by side.
 *
 * Fed entirely by SSE events (tool_use / tool_result / token / done) — no
 * extra backend calls. Expanded while the agent runs; collapses to a
 * one-line summary once done, click to re-expand.
 */
export function AgentTrace({ trace, streaming }: Props) {
  // Expanded while running; auto-collapses once the agent is done.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  if (trace.length === 0) return null;

  const expanded = manualExpanded ?? streaming;

  const searches = trace.filter((s) => s.kind === "search").length;
  const totalMs = trace.reduce((acc, s) => {
    if (s.endedAt) return acc + (s.endedAt - s.startedAt);
    return acc;
  }, 0);
  const summary =
    searches > 0
      ? `${searches} search${searches > 1 ? "es" : ""}`
      : "reasoning";
  const totalLabel = totalMs > 0 ? ` · ${(totalMs / 1000).toFixed(1)}s` : "";

  return (
    <div className="mb-3 rounded-lg border border-border bg-muted/30 overflow-hidden">
      <button
        onClick={() => setManualExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Agent trace
        </span>
        {streaming ? (
          <Loader2 className="h-3 w-3 animate-spin text-primary" />
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {summary}
            {totalLabel}
          </span>
        )}
      </button>

      {expanded && (
        <ol className="px-3 pb-2.5 pt-0.5">
          {trace.map((step, i) => (
            <TraceStepRow
              key={step.id}
              step={step}
              isLast={i === trace.length - 1}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function TraceStepRow({ step, isLast }: { step: TraceStep; isLast: boolean }) {
  const [showChunks, setShowChunks] = useState(false);
  const Icon = ICONS[step.kind];
  const running = step.status === "running";
  const dur = stepDuration(step);
  const hasChunks = !!step.chunks && step.chunks.length > 0;

  return (
    <li className="relative flex items-start gap-2.5 py-1 pl-1">
      {/* connector line */}
      {!isLast && (
        <span className="absolute left-[11px] top-[22px] h-[calc(100%-12px)] w-px bg-border" />
      )}
      {/* status dot / icon */}
      <span
        className={`relative z-10 mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border ${
          running
            ? "border-primary/50 bg-primary/10"
            : "border-border bg-background"
        }`}
      >
        {running ? (
          <Icon className="h-2.5 w-2.5 animate-pulse text-primary" />
        ) : (
          <Check className="h-2.5 w-2.5 text-[oklch(0.7_0.16_150)]" />
        )}
      </span>
      {/* label + detail */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={`text-xs ${running ? "text-foreground" : "text-muted-foreground"}`}
          >
            {step.label}
          </span>
          {dur && (
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {dur}
            </span>
          )}
        </div>
        {step.detail && (
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
            {step.kind === "search" ? `"${step.detail}"` : step.detail}
          </div>
        )}
        {/* post-retrieval summary: "8 chunks · top 0.95 · 6 reranked" */}
        {step.result && (
          <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground/60">
            {step.result}
          </div>
        )}
        {/* expandable Retrieval Inspector — the actual chunks + both scores */}
        {hasChunks && (
          <>
            <button
              onClick={() => setShowChunks((v) => !v)}
              className="mt-1 inline-flex items-center gap-1 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Layers className="h-2.5 w-2.5" />
              {showChunks ? "hide retrieval" : "inspect retrieval"}
              {showChunks ? (
                <ChevronDown className="h-2.5 w-2.5" />
              ) : (
                <ChevronRight className="h-2.5 w-2.5" />
              )}
            </button>
            {showChunks && <RetrievalInspector chunks={step.chunks!} />}
          </>
        )}
      </div>
    </li>
  );
}
