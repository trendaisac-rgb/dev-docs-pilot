import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Toaster, toast } from "sonner";
import { Moon, Sun, Settings, Trash2, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageBubble } from "@/components/MessageBubble";
import { SourcesPanel } from "@/components/SourcesPanel";
import { Composer } from "@/components/Composer";
import { SettingsSheet } from "@/components/SettingsSheet";
import { Sidebar, EXAMPLES } from "@/components/Sidebar";
import type { Message, Citation, Conversation, TraceStep } from "@/lib/types";
import { extractCitations } from "@/lib/citations";
import { streamSSE } from "@/lib/sse";
import { FUNCTIONS_BASE, SUPABASE_HEADERS } from "@/lib/config";

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

// ── Conversation state ──────────────────────────────────────────────
// Multiple in-memory conversations. The Edge Function is stateless, so
// "history" lives here for the session — no browser storage needed.

type CState = { conversations: Conversation[]; activeId: string };
type CAction =
  | { type: "new" }
  | { type: "select"; id: string }
  | { type: "addMsg"; message: Message }
  | { type: "patchMsg"; id: string; patch: Partial<Message> }
  | { type: "title"; title: string }
  | { type: "session"; sessionId: string }
  | { type: "rename"; id: string; title: string }
  | { type: "delete"; id: string };

function newConversation(): Conversation {
  return {
    id: uid(),
    title: "New chat",
    messages: [],
    sessionId: null,
    createdAt: Date.now(),
  };
}

function reducer(state: CState, action: CAction): CState {
  const patchActive = (fn: (c: Conversation) => Conversation): CState => ({
    ...state,
    conversations: state.conversations.map((c) =>
      c.id === state.activeId ? fn(c) : c,
    ),
  });

  switch (action.type) {
    case "new": {
      const conv = newConversation();
      return { conversations: [conv, ...state.conversations], activeId: conv.id };
    }
    case "select":
      return { ...state, activeId: action.id };
    case "addMsg":
      return patchActive((c) => ({ ...c, messages: [...c.messages, action.message] }));
    case "patchMsg":
      return patchActive((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === action.id ? { ...m, ...action.patch } : m,
        ),
      }));
    case "title":
      return patchActive((c) => ({
        ...c,
        title: c.title === "New chat" ? action.title : c.title,
      }));
    case "session":
      return patchActive((c) => ({ ...c, sessionId: action.sessionId }));
    case "rename":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.id ? { ...c, title: action.title } : c,
        ),
      };
    case "delete": {
      const remaining = state.conversations.filter((c) => c.id !== action.id);
      // Never leave the app with zero conversations — seed a fresh one.
      if (remaining.length === 0) {
        const conv = newConversation();
        return { conversations: [conv], activeId: conv.id };
      }
      const activeId =
        state.activeId === action.id ? remaining[0].id : state.activeId;
      return { conversations: remaining, activeId };
    }
  }
}

export function ChatApp() {
  const [isDark, setIsDark] = useState(true);
  // Default backend = the Supabase Edge Function base. The chat function
  // lives at `${backendUrl}/chat`. Overridable in Settings for local
  // `supabase functions serve` development.
  const [backendUrl, setBackendUrl] = useState(FUNCTIONS_BASE);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    (): CState => {
      const conv = newConversation();
      return { conversations: [conv], activeId: conv.id };
    },
  );
  const active = state.conversations.find((c) => c.id === state.activeId)!;
  const messages = active.messages;
  const sessionId = active.sessionId;

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  const ping = useCallback(async () => {
    // The Edge Function has no /healthz route — a CORS preflight (OPTIONS)
    // on /chat returns 200 "ok" and proves the function is reachable.
    try {
      const res = await fetch(`${backendUrl}/chat`, {
        method: "OPTIONS",
        headers: SUPABASE_HEADERS,
      });
      setConnected(res.ok);
    } catch {
      setConnected(false);
    }
  }, [backendUrl]);

  useEffect(() => {
    ping();
    const id = setInterval(ping, 30_000);
    return () => clearInterval(id);
  }, [ping]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const latestCitations: Citation[] = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && !m.streaming) {
        return m.citations ?? extractCitations(m.content);
      }
    }
    return [];
  }, [messages]);

  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    dispatch({ type: "new" });
  }, []);

  const handleSelectChat = useCallback(
    (id: string) => {
      abortRef.current?.abort();
      setStreaming(false);
      dispatch({ type: "select", id });
    },
    [],
  );

  const handleRenameChat = useCallback((id: string, title: string) => {
    const t = title.trim();
    if (t) dispatch({ type: "rename", id, title: t.slice(0, 80) });
  }, []);

  const handleDeleteChat = useCallback(
    (id: string) => {
      // If we're deleting the conversation that's currently streaming,
      // abort the in-flight request first.
      if (state.activeId === id) {
        abortRef.current?.abort();
        setStreaming(false);
      }
      dispatch({ type: "delete", id });
    },
    [state.activeId],
  );

  // ── Token + trace accumulators (per assistant message id) ──────────
  const tokenBuffersRef = useRef<Map<string, string>>(new Map());
  const traceRef = useRef<Map<string, TraceStep[]>>(new Map());

  const commitTrace = useCallback((msgId: string) => {
    const steps = (traceRef.current.get(msgId) ?? []).map((s) => ({ ...s }));
    dispatch({ type: "patchMsg", id: msgId, patch: { trace: steps } });
  }, []);

  const traceEndRunning = useCallback(
    (msgId: string, kinds?: TraceStep["kind"][]) => {
      const steps = traceRef.current.get(msgId) ?? [];
      for (const s of steps) {
        if (s.status === "running" && (!kinds || kinds.includes(s.kind))) {
          s.status = "done";
          s.endedAt = Date.now();
        }
      }
    },
    [],
  );

  const tracePush = useCallback(
    (msgId: string, kind: TraceStep["kind"], label: string, detail?: string) => {
      const steps = traceRef.current.get(msgId) ?? [];
      steps.push({
        id: uid(),
        kind,
        label,
        detail,
        status: "running",
        startedAt: Date.now(),
      });
      traceRef.current.set(msgId, steps);
    },
    [],
  );

  const appendToken = useCallback((id: string, token: string) => {
    const cur = tokenBuffersRef.current.get(id) ?? "";
    const next = cur + token;
    tokenBuffersRef.current.set(id, next);
    dispatch({ type: "patchMsg", id, patch: { content: next, toolStatus: null } });
  }, []);

  const finalizeCitations = useCallback((id: string) => {
    const content = tokenBuffersRef.current.get(id) ?? "";
    const cites = extractCitations(content);
    dispatch({ type: "patchMsg", id, patch: { citations: cites } });
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      const userMsg: Message = {
        id: uid(),
        role: "user",
        content: trimmed,
        createdAt: Date.now(),
      };
      const assistantId = uid();
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        streaming: true,
      };
      dispatch({ type: "addMsg", message: userMsg });
      dispatch({ type: "title", title: trimmed.slice(0, 60) });
      dispatch({ type: "addMsg", message: assistantMsg });
      setInput("");
      setStreaming(true);

      // Seed the agent trace: every turn starts by understanding the question.
      traceRef.current.set(assistantId, [
        {
          id: uid(),
          kind: "intent",
          label: "Understanding the question",
          status: "running",
          startedAt: Date.now(),
        },
      ]);
      commitTrace(assistantId);

      const ac = new AbortController();
      abortRef.current = ac;
      let composeStarted = false;

      try {
        const events = streamSSE(
          `${backendUrl}/chat`,
          { question: trimmed, session_id: sessionId },
          ac.signal,
          SUPABASE_HEADERS,
        );
        for await (const ev of events) {
          let payload: any = {};
          try {
            payload = ev.data ? JSON.parse(ev.data) : {};
          } catch {
            // ignore parse errors
          }
          switch (ev.event) {
            case "meta":
              if (payload.session_id) dispatch({ type: "session", sessionId: payload.session_id });
              break;
            case "tool_use": {
              // First real signal — the agent finished understanding.
              traceEndRunning(assistantId, ["intent"]);
              if (payload.tool === "search_knowledge_base") {
                const q = payload.input?.query ?? "";
                tracePush(assistantId, "search", "Searching the docs", String(q));
              } else if (payload.tool === "format_citations") {
                const n = Array.isArray(payload.input?.sources)
                  ? payload.input.sources.length
                  : 0;
                tracePush(
                  assistantId,
                  "cite",
                  "Registering citations",
                  n ? `${n} source${n > 1 ? "s" : ""}` : undefined,
                );
              }
              commitTrace(assistantId);
              dispatch({
                type: "patchMsg",
                id: assistantId,
                patch: { toolStatus: { tool: payload.tool, input: payload.input } },
              });
              break;
            }
            case "tool_result": {
              // The most-recent running search/cite step just completed.
              // Attach the retrieval summary + chunks to that step BEFORE
              // ending it, so the Retrieval Inspector has data to show.
              const steps = traceRef.current.get(assistantId) ?? [];
              for (let i = steps.length - 1; i >= 0; i--) {
                const s = steps[i];
                if (
                  s.status === "running" &&
                  (s.kind === "search" || s.kind === "cite")
                ) {
                  if (payload.detail) s.result = String(payload.detail);
                  if (Array.isArray(payload.chunks)) s.chunks = payload.chunks;
                  break;
                }
              }
              traceEndRunning(assistantId, ["search", "cite"]);
              commitTrace(assistantId);
              break;
            }
            case "token": {
              const tok = payload.token ?? "";
              if (!composeStarted) {
                composeStarted = true;
                traceEndRunning(assistantId, ["intent", "search", "cite"]);
                tracePush(assistantId, "compose", "Writing the answer");
                commitTrace(assistantId);
              }
              appendToken(assistantId, tok);
              break;
            }
            case "done":
              traceEndRunning(assistantId);
              commitTrace(assistantId);
              dispatch({ type: "patchMsg", id: assistantId, patch: { streaming: false } });
              finalizeCitations(assistantId);
              break;
            case "sources": {
              // Authoritative citation list from the agent's format_citations
              // call — overrides the regex-extracted one.
              const cites: Citation[] = (payload.sources ?? []).map(
                (s: any, i: number, arr: any[]) => ({
                  title: s.title,
                  url: s.url,
                  relevance: arr.length === 1 ? 1 : 1 - (i / (arr.length - 1)) * 0.7,
                }),
              );
              if (cites.length) {
                dispatch({ type: "patchMsg", id: assistantId, patch: { citations: cites } });
              }
              break;
            }
            case "error":
              traceEndRunning(assistantId);
              commitTrace(assistantId);
              dispatch({
                type: "patchMsg",
                id: assistantId,
                patch: { streaming: false, error: payload.message ?? "Unknown error" },
              });
              toast.error(payload.message ?? "Stream error");
              break;
          }
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        traceEndRunning(assistantId);
        commitTrace(assistantId);
        dispatch({
          type: "patchMsg",
          id: assistantId,
          patch: {
            streaming: false,
            error: "I hit an error. Try again or check the backend logs.",
          },
        });
        toast.error(
          `Can't reach the chat function at ${backendUrl}/chat. Check the Edge Function is deployed and its secrets are set.`,
        );
        setConnected(false);
      } finally {
        setStreaming(false);
      }
    },
    [
      backendUrl,
      sessionId,
      streaming,
      appendToken,
      finalizeCitations,
      commitTrace,
      traceEndRunning,
      tracePush,
    ],
  );

  const empty = messages.length === 0;

  return (
    <TooltipProvider delayDuration={200}>
      <Toaster theme={isDark ? "dark" : "light"} position="top-center" />
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/80 backdrop-blur px-5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-primary" />
            <span className="font-mono text-sm font-medium tracking-tight">docs-agent</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ConnectionPill connected={connected} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to="/evals"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent"
                >
                  <BarChart3 className="h-4 w-4" />
                </Link>
              </TooltipTrigger>
              <TooltipContent>Evaluation dashboard</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={handleNewChat}
                  disabled={messages.length === 0}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New chat</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => setIsDark((v) => !v)}
                >
                  {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isDark ? "Light mode" : "Dark mode"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <div className="flex flex-1 min-h-0">
          <Sidebar
            conversations={state.conversations}
            activeId={state.activeId}
            onSelect={handleSelectChat}
            onNewChat={handleNewChat}
            onPickExample={(q) => send(q)}
            onRename={handleRenameChat}
            onDelete={handleDeleteChat}
            busy={streaming}
          />
          <main className="flex flex-1 flex-col min-w-0">
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[800px] px-6">
                {empty ? (
                  <Welcome onPick={(q) => send(q)} />
                ) : (
                  <div className="space-y-8 py-8">
                    {messages.map((m) => (
                      <MessageBubble key={m.id} message={m} isDark={isDark} />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="mx-auto w-full max-w-[800px] px-6">
              <Composer
                value={input}
                onChange={setInput}
                onSend={() => send(input)}
                disabled={!input.trim() || streaming}
                streaming={streaming}
              />
            </div>
          </main>
          <SourcesPanel citations={latestCitations} />
        </div>
      </div>

      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        backendUrl={backendUrl}
        onBackendUrlChange={setBackendUrl}
      />
    </TooltipProvider>
  );
}

function ConnectionPill({ connected }: { connected: boolean | null }) {
  const label = connected === null ? "Checking…" : connected ? "Connected" : "Disconnected";
  const color =
    connected === null
      ? "text-muted-foreground"
      : connected
        ? "text-[oklch(0.7_0.16_150)]"
        : "text-destructive";
  return (
    <div className="hidden sm:flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 mr-1">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          connected
            ? "bg-[oklch(0.7_0.16_150)]"
            : connected === false
              ? "bg-destructive"
              : "bg-muted-foreground"
        }`}
      />
      <span className={`text-[10px] font-mono ${color}`}>{label}</span>
    </div>
  );
}

function Welcome({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="h-3 w-3 rounded-full bg-primary" />
        <span className="font-mono text-lg font-medium tracking-tight">docs-agent</span>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Ask anything about Anthropic's docs
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        A focused agent grounded in the official developer documentation. Watch it search,
        re-rank, and cite — every answer is traceable.
      </p>
      {/* Desktop carries the examples in the sidebar; mobile has no
          sidebar, so surface them on the welcome screen. */}
      <p className="mt-6 hidden max-w-md text-xs text-muted-foreground/70 md:block">
        Pick a question from the sidebar, or type your own below.
      </p>
      <div className="mt-6 w-full max-w-md md:hidden">
        <div className="mb-2 px-1 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Try asking
        </div>
        <ul className="space-y-1.5">
          {EXAMPLES.map((q) => (
            <li key={q}>
              <button
                onClick={() => onPick(q)}
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-left text-xs leading-snug text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
              >
                {q}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
