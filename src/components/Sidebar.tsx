import { useEffect, useRef, useState } from "react";
import {
  Plus,
  MessageSquare,
  Sparkles,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import type { Conversation } from "@/lib/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Drawn from the eval dataset so the questions a reviewer clicks are exactly
// the ones the eval harness measured — see api/eval/dataset.json.
export const EXAMPLES = [
  "How do I stream a response from the Messages API in Python?",
  "What's the difference between tool_use and tool_result content blocks?",
  "How does prompt caching work and what content can be cached?",
  "What is a Claude Managed Agent and how is it different from a single Messages API call?",
  "How do I enable extended thinking on a request?",
  "What is the MCP connector and what does it let me do?",
  "What stop_reason values can the Messages API return?",
  "How should I think about choosing a Claude model for cost and latency?",
];

interface Props {
  conversations: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onPickExample: (question: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}

/**
 * Sidebar — New chat, in-session conversation history, and example
 * questions. History is in-memory for the session (the Edge Function is
 * stateless), which is enough for a working demo and avoids browser
 * storage entirely.
 *
 * Each history row has a hover ⋮ menu to rename (inline edit) or delete.
 */
export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onPickExample,
  onRename,
  onDelete,
  busy,
}: Props) {
  // Which conversation is currently being renamed inline (if any).
  const [renamingId, setRenamingId] = useState<string | null>(null);

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
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  active={c.id === activeId}
                  renaming={renamingId === c.id}
                  onSelect={() => onSelect(c.id)}
                  onStartRename={() => setRenamingId(c.id)}
                  onCommitRename={(title) => {
                    onRename(c.id, title);
                    setRenamingId(null);
                  }}
                  onCancelRename={() => setRenamingId(null)}
                  onDelete={() => onDelete(c.id)}
                />
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

interface RowProps {
  conversation: Conversation;
  active: boolean;
  renaming: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}

function ConversationRow({
  conversation: c,
  active,
  renaming,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: RowProps) {
  const [draft, setDraft] = useState(c.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // When rename mode opens, seed the draft and focus/select the input.
  useEffect(() => {
    if (renaming) {
      setDraft(c.title);
      // Focus after the input has mounted.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, c.title]);

  if (renaming) {
    return (
      <li>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename(draft);
            if (e.key === "Escape") onCancelRename();
          }}
          onBlur={() => onCommitRename(draft)}
          className="w-full rounded-md border border-primary/50 bg-card px-2 py-1.5 text-xs text-foreground outline-none"
        />
      </li>
    );
  }

  return (
    <li>
      <div
        className={`group/row flex items-center gap-1 rounded-md pr-1 transition-colors ${
          active
            ? "bg-accent"
            : "hover:bg-muted/60"
        }`}
      >
        <button
          onClick={onSelect}
          className={`flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
            active ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
          <span className="line-clamp-2 leading-snug">{c.title}</span>
        </button>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Chat options"
              className={`shrink-0 rounded p-1 text-muted-foreground transition-all hover:bg-background hover:text-foreground ${
                menuOpen
                  ? "opacity-100"
                  : "opacity-0 group-hover/row:opacity-100"
              }`}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem
              onClick={() => {
                setMenuOpen(false);
                onStartRename();
              }}
            >
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
