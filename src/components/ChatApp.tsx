import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { Moon, Sun, Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageBubble } from "@/components/MessageBubble";
import { SourcesPanel } from "@/components/SourcesPanel";
import { Composer } from "@/components/Composer";
import { SettingsSheet } from "@/components/SettingsSheet";
import type { Message, Citation } from "@/lib/types";
import { extractCitations } from "@/lib/citations";
import { streamSSE } from "@/lib/sse";
import { FUNCTIONS_BASE, SUPABASE_HEADERS } from "@/lib/config";

const EXAMPLES = [
  "How do I stream a response from the Messages API in Python?",
  "What is the MCP connector and what can it do?",
  "How does prompt caching work?",
  "What's the difference between tool_use and tool_result?",
];

type Action =
  | { type: "add"; message: Message }
  | { type: "patch"; id: string; patch: Partial<Message> }
  | { type: "reset" };

function reducer(state: Message[], action: Action): Message[] {
  switch (action.type) {
    case "add":
      return [...state, action.message];
    case "patch":
      return state.map((m) => (m.id === action.id ? { ...m, ...action.patch } : m));
    case "reset":
      return [];
  }
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export function ChatApp() {
  const [isDark, setIsDark] = useState(true);
  // Default backend = the Supabase Edge Function base. The chat function
  // lives at `${backendUrl}/chat`. Overridable in Settings for local
  // `supabase functions serve` development.
  const [backendUrl, setBackendUrl] = useState(FUNCTIONS_BASE);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [messages, dispatch] = useReducer(reducer, []);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
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

  const handleClear = useCallback(() => {
    // The Edge Function is stateless — sessions aren't persisted server-side
    // (history is passed per-request). Clearing is a pure client-side reset.
    abortRef.current?.abort();
    setSessionId(null);
    dispatch({ type: "reset" });
    setStreaming(false);
  }, []);

  const tokenBuffersRef = useRef<Map<string, string>>(new Map());
  const appendToken = useCallback((id: string, token: string) => {
    const cur = tokenBuffersRef.current.get(id) ?? "";
    const next = cur + token;
    tokenBuffersRef.current.set(id, next);
    dispatch({ type: "patch", id, patch: { content: next, toolStatus: null } });
  }, []);
  const finalizeCitations = useCallback((id: string) => {
    const content = tokenBuffersRef.current.get(id) ?? "";
    const cites = extractCitations(content);
    dispatch({ type: "patch", id, patch: { citations: cites } });
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
      dispatch({ type: "add", message: userMsg });
      dispatch({ type: "add", message: assistantMsg });
      setInput("");
      setStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        {
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
                if (payload.session_id) setSessionId(payload.session_id);
                break;
              case "tool_use":
                dispatch({
                  type: "patch",
                  id: assistantId,
                  patch: { toolStatus: { tool: payload.tool, input: payload.input } },
                });
                break;
              case "token": {
                const tok = payload.token ?? "";
                appendToken(assistantId, tok);
                break;
              }
              case "done":
                dispatch({
                  type: "patch",
                  id: assistantId,
                  patch: { streaming: false },
                });
                finalizeCitations(assistantId);
                break;
              case "error":
                dispatch({
                  type: "patch",
                  id: assistantId,
                  patch: { streaming: false, error: payload.message ?? "Unknown error" },
                });
                toast.error(payload.message ?? "Stream error");
                break;
            }
          }
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        dispatch({
          type: "patch",
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
    [backendUrl, sessionId, streaming, appendToken, finalizeCitations],
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={handleClear}
                  disabled={messages.length === 0}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear conversation</TooltipContent>
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
      <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-[oklch(0.7_0.16_150)]" : connected === false ? "bg-destructive" : "bg-muted-foreground"}`} />
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
        A focused chat agent grounded in the official developer documentation. Streamed answers, with citations.
      </p>
      <div className="mt-10 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
        {EXAMPLES.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="group rounded-lg border border-border bg-card p-3 text-left text-sm text-foreground/90 hover:border-primary/40 hover:bg-accent transition-colors"
          >
            {q}
            <span className="ml-1 text-primary opacity-0 group-hover:opacity-100 transition-opacity">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}
