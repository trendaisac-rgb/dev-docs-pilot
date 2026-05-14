export type Citation = {
  title: string;
  url: string;
  relevance: number;
};

export type ToolStatus = {
  tool: string;
  input?: Record<string, unknown>;
};

// One chunk the retriever actually surfaced, as seen by the agent. Carries
// both scores so the UI can show *why* it ranked where it did: raw vector
// similarity vs. the LLM-as-judge sufficiency relevance.
export type RetrievedChunk = {
  title: string;
  section: string;
  url: string;
  similarity: number;
  rerankRelevance?: number;
  content: string;
};

// One step in the agent's reasoning loop, surfaced live from SSE events.
// This is what makes the agent *visible*: the user watches it classify
// the question, decide what to search for (and re-search), then compose.
export type TraceStep = {
  id: string;
  kind: "intent" | "search" | "cite" | "compose";
  label: string;
  detail?: string; // the actual search query, or a short result summary
  result?: string; // post-retrieval summary, e.g. "8 chunks · top 0.95"
  chunks?: RetrievedChunk[]; // retrieved chunks, for the Retrieval Inspector
  status: "running" | "done";
  startedAt: number;
  endedAt?: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  streaming?: boolean;
  toolStatus?: ToolStatus | null;
  error?: string | null;
  citations?: Citation[];
  trace?: TraceStep[];
};

// In-memory multi-conversation state. Sessions aren't persisted server-side
// (the Edge Function is stateless — history is passed per request), so the
// sidebar's conversation list lives in component state for the session.
export type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  sessionId: string | null;
  createdAt: number;
};
