import { useEffect, useRef } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  streaming: boolean;
}

export function Composer({ value, onChange, onSend, disabled, streaming }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    const max = 6 * 24; // ~6 rows
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  }, [value]);

  return (
    <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-4">
      <div className="rounded-xl border border-border bg-card shadow-sm focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-ring/30 transition-all">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!disabled) onSend();
            }
          }}
          rows={1}
          placeholder="Ask about the Anthropic docs…"
          className="w-full resize-none bg-transparent px-4 py-3 text-sm placeholder:text-muted-foreground focus:outline-none"
          style={{ minHeight: "48px" }}
        />
        <div className="flex items-center justify-between px-3 pb-2.5">
          <span className="text-[10px] font-mono text-muted-foreground">
            {streaming ? "streaming…" : "↵ to send · ⇧↵ for newline"}
          </span>
          <Button
            size="sm"
            onClick={onSend}
            disabled={disabled}
            className="h-8 w-8 p-0 rounded-md bg-primary hover:bg-primary/90 disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
