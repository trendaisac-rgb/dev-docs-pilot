import { Plus, MessageSquare, Sparkles } from "lucide-react";
import type { Conversation } from "@/lib/types";

const EXAMPLES = [
  "How do I stream a response from the Messages API in Python?",
  "What is the MCP connector and what can it do?",
  "How does prompt caching work?",
  "What's the difference between tool_use and tool_result?",
];

interface Props {
  conversations: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onPickExample: (question: string) => void;
  busy: boolean;
}

/**
 * Sidebar — New chat, in-session conversation history, and example
 * questions. History is in-memory for the session (the Edge Function is
 * stateless), which is enough for a working demo and avoids browser
 * storage entirely.
 */
export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onPickExample,
  busy,
}: Props) {
  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-border bg-muted/20">
      {/* New chat */}
      <div className="p-3">
        <button
          onClick={onNewChat}
          disabled={busy}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-accent disabled:opacity-50"
        >
          <Plus className="h-4 w-4 text-primary" />
          New chat
        </button>
      </div>

      {/* Conversation history */}
      <div className="flex-1 overflow-y-auto px-3">
        {conversations.length > 0 && (
          <>
            <div className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              History
            </div>
            <ul className="space-y-0.5">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => onSelect(c.id)}
                    className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                      c.id === activeId
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
                    <span className="line-clamp-2 leading-snug">{c.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Example questions */}
      <div className="border-t border-border p-3">
        <div className="mb-1.5 flex items-center gap-1.5 px-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <Sparkles className="h-3 w-3" />
          Try asking
        </div>
        <ul className="space-y-1">
          {EXAMPLES.map((q) => (
            <li key={q}>
              <button
                onClick={() => onPickExample(q)}
                disabled={busy}
                className="w-full rounded-md px-2 py-1.5 text-left text-[11px] leading-snug text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
              >
                {q}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
