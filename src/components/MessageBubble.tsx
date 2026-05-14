import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { AlertCircle } from "lucide-react";
import type { Message } from "@/lib/types";
import { extractCitations } from "@/lib/citations";
import { AgentTrace } from "@/components/AgentTrace";

interface Props {
  message: Message;
  isDark: boolean;
}

export function MessageBubble({ message, isDark }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Build citation index map for superscript links
  const citationIndex = useRef(new Map<string, number>());
  citationIndex.current = new Map();
  if (message.role === "assistant") {
    const cites = extractCitations(message.content);
    cites.forEach((c, i) => citationIndex.current.set(c.url, i + 1));
  }

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [message.content]);

  if (message.role === "user") {
    return (
      <div ref={ref} className="group flex justify-end animate-fade-in">
        <div className="max-w-[85%]">
          <div className="rounded-2xl rounded-tr-sm bg-muted px-4 py-2.5 text-foreground whitespace-pre-wrap break-words">
            {message.content}
          </div>
          <div className="mt-1 text-right text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity font-mono">
            {new Date(message.createdAt).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="group animate-fade-in">
      {/* The signature view: the agent's tool-use loop, rendered live. */}
      {message.trace && message.trace.length > 0 && (
        <AgentTrace trace={message.trace} streaming={!!message.streaming} />
      )}
      <div className={`prose-msg ${message.streaming ? "streaming-cursor" : ""}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              const idx = href ? citationIndex.current.get(href) : undefined;
              if (idx) {
                return (
                  <>
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      title={String(children)}
                      className="citation-ref"
                    >
                      {idx}
                    </a>
                  </>
                );
              }
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            },
            code({ className, children, ...props }: any) {
              const match = /language-(\w+)/.exec(className || "");
              const inline = !match && !String(children).includes("\n");
              if (inline) {
                return <code className={className} {...props}>{children}</code>;
              }
              return (
                <SyntaxHighlighter
                  language={match?.[1] || "text"}
                  style={isDark ? oneDark : oneLight}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    padding: "1rem",
                    background: "transparent",
                    fontSize: "0.85rem",
                  }}
                >
                  {String(children).replace(/\n$/, "")}
                </SyntaxHighlighter>
              );
            },
          }}
        >
          {message.content || (message.streaming ? "" : "")}
        </ReactMarkdown>
      </div>
      {message.error && (
        <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          {message.error}
        </div>
      )}
      {!message.streaming && message.content && (
        <div className="mt-2 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity font-mono">
          {new Date(message.createdAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
