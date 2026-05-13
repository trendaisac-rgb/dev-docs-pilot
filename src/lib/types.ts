export type Citation = {
  title: string;
  url: string;
  relevance: number;
};

export type ToolStatus = {
  tool: string;
  input?: Record<string, unknown>;
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
};
