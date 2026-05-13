# Lovable prompt — docs-agent frontend

Copy everything between the lines below into Lovable. Tweak after the first generation
if it gets details wrong; don't try to perfect in one shot.

---

Build a single-page web app called **docs-agent** — a chat interface for an AI agent that answers questions over Anthropic's developer documentation. The agent runs on a FastAPI backend that I'm running separately at `http://localhost:8000`. Your job is the chat UI.

## Visual style

- Clean, technical, developer-product aesthetic — think Vercel docs / Anthropic console / Linear, NOT a consumer chat app.
- Dark mode by default with a light-mode toggle in the header. Both modes should look intentional, not inverted.
- Monospace for code blocks (use `JetBrains Mono` or `IBM Plex Mono` via Google Fonts); sans-serif for body (use `Inter`).
- Subtle warm accent — a coral/amber `#D97757` (Anthropic's signature) used sparingly for the send button, focus rings, and brand mark.
- Generous whitespace. No emoji-heavy UI. No gradients. No glassmorphism.
- Use shadcn/ui components throughout (button, input, scroll-area, card, badge, tooltip, separator).

## Layout

Single page, three regions:

1. **Header** (sticky, ~56px): brand mark "docs-agent" on the left in monospace, dark/light mode toggle on the right, and a small connection status pill next to the toggle ("● Connected" / "● Disconnected") that hits `GET /healthz` every 30s.

2. **Main chat area** (flex-grow, max-width 800px centered): vertically scrolling message list, then a sticky composer at the bottom. When empty, show a centered welcome state with the brand mark and 4 example question chips the user can click to send.

3. **Sources panel** (right sidebar, 360px, collapsible): shows the structured citation list for the most recent answer. Each citation is a card with title, section path, and a relevance bar (0-1 normalized). Clicking a card opens the URL in a new tab.

## Example question chips (welcome state)

These should be clickable; clicking inserts the text into the composer and sends:

- "How do I stream a response from the Messages API in Python?"
- "What is the MCP connector and what can it do?"
- "How does prompt caching work?"
- "What's the difference between tool_use and tool_result?"

## Composer

Sticky to the bottom of the chat area. A multi-line textarea (autoexpands up to ~6 rows), an enter-to-send hint, and a send button with the coral accent. Shift+Enter inserts a newline. Disable the button when the input is empty or when a response is streaming.

## Messages

Two roles: `user` (right-aligned bubble, neutral background) and `assistant` (left-aligned, no bubble — just typography on the page background, like Claude's interface). Both should have a subtle hover-to-show timestamp.

Assistant messages render **markdown**: headings, bold, lists, code blocks (with syntax highlighting via `react-syntax-highlighter` or `shiki`), and inline links. **Inline citation links** should be visually distinct: small superscript number badges that, on hover, show a tooltip with the source title.

## Streaming behavior — IMPORTANT, this is the core UX

When the user sends a message, hit `POST http://localhost:8000/chat` with:

```json
{ "question": "<text>", "session_id": "<uuid or null>" }
```

The response is a `text/event-stream` (Server-Sent Events) with these events:

- `meta` — `{ "session_id": "..." }` — store this and reuse on every subsequent request
- `tool_use` — `{ "tool": "mcp__docs-agent__search_knowledge_base", "input": {...} }` — render an inline status row in the assistant message like: `🔎 Searching the docs…` (use a Lucide icon, not the literal emoji). Replace this status row when the next `token` event arrives.
- `token` — `{ "token": "<string>" }` — append to the streaming assistant message. Render incrementally.
- `done` — `{}` — stop streaming. Parse the assistant message for inline markdown links, populate the Sources panel.
- `error` — `{ "message": "..." }` — show an inline error badge in the assistant message.

Implementation note for SSE: use the native `EventSource` API, or `fetch` + `ReadableStream` if you need to send a POST body (which you do here — `EventSource` only supports GET). Parse `event:` and `data:` lines manually.

While streaming, show a small typing/cursor indicator at the end of the assistant message.

## Sources panel — when an answer is done

Parse all markdown links in the assistant's answer (regex `\[([^\]]+)\]\((https?://[^\)]+)\)`). Dedupe by URL. Render each as a card:

```
┌─────────────────────────────────────┐
│ <Title >  <Section?>                │
│ <URL>                                │
│ [▰▰▰▰▰░░░░░] relevance 0.84         │
└─────────────────────────────────────┘
```

(Relevance is the order they appeared — first cited gets 1.0, last gets a lower bar. This is a proxy, not exact.)

If the answer has no citations, show an empty state: "No sources cited for this answer."

## Session handling

- The first message creates a session (backend assigns and returns via `meta`). Store it in `useState` (NOT localStorage — per project guidance).
- All subsequent messages reuse that session_id.
- Add a "Clear conversation" button in the header that resets the session: clears messages and clears session_id.
- Hit `DELETE http://localhost:8000/session/{session_id}` when clearing, to free the backend session.

## Settings drawer

A gear icon in the header opens a Sheet from the right with one field:

- **Backend URL** (default `http://localhost:8000`) — persist in component state so the dev can repoint to a deployed backend.

## Connection status

Background ping `GET ${backendUrl}/healthz` every 30 seconds. The pill in the header reflects the latest state. If the most recent send failed because the backend is unreachable, show a toast: "Can't reach backend at <URL>. Check that uvicorn is running."

## Error handling

- Network errors → toast + inline message in chat
- 429 rate limit → toast "Rate limit — try again in a moment"
- 5xx → toast with status code + inline assistant message saying "I hit an error. Try again or check the backend logs."

## What NOT to do

- No user authentication, no profiles, no login screen.
- No localStorage / sessionStorage — keep everything in component state.
- No fake/mocked responses — every message MUST hit the backend.
- No animations beyond subtle fade-in on message append and the streaming cursor blink.
- No "Powered by Lovable" badges. No emoji in the UI chrome.

## Tech requirements

- React 18 + TypeScript + Vite + Tailwind + shadcn/ui (Lovable defaults).
- Markdown rendering: `react-markdown` with `remark-gfm`. Code blocks: `react-syntax-highlighter` (Prism theme that matches the dark/light scheme).
- Icons: `lucide-react`.
- No state library — `useState` + `useReducer` for the message list is enough.
- Keep the entire app in a small number of files; this is a focused demo, not a product.

## Backend contract — paste this verbatim into a file the assistant can reference

```
POST /chat
  Body: { "question": string, "session_id": string | null }
  Response: text/event-stream
  Events:
    meta:     { session_id: string }
    tool_use: { tool: string, input: object }
    token:    { token: string }
    done:     {}
    error:    { message: string }

POST /ask
  Body: { "question": string, "session_id": string | null }
  Response (JSON):
    { session_id: string, answer: string, citations: [{title, url}], tool_calls: number }

DELETE /session/{session_id}
  Response: { status: "closed" | "not_found" }

GET /healthz
  Response: { status: "ok" }
```

Use `POST /chat` (SSE streaming) as the primary path. `POST /ask` is the non-streaming fallback if streaming has issues; add a small toggle in Settings to switch between them.

Ship the app. Make it feel like a tool a senior engineer at a small AI agency would actually want to use day-to-day.
