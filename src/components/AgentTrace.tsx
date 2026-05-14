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
} from "lucide-react";
import type { TraceStep } from "@/lib/types";

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
          {trace.map((step, i) => {
            const Icon = ICONS[step.kind];
            const running = step.status === "running";
            const dur = stepDuration(step);
            return (
              <li
                key={step.id}
                className="relative flex items-start gap-2.5 py-1 pl-1"
              >
                {/* connector line */}
                {i < trace.length - 1 && (
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
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
