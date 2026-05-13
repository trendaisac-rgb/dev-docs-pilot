import { createFileRoute } from "@tanstack/react-router";
import { ChatApp } from "@/components/ChatApp";

export const Route = createFileRoute("/")({
  component: ChatApp,
  head: () => ({
    meta: [
      { title: "docs-agent — chat with Anthropic's developer docs" },
      {
        name: "description",
        content:
          "A focused chat agent grounded in Anthropic's developer documentation. Streamed answers with citations.",
      },
    ],
  }),
});
