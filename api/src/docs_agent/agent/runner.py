"""Agent runner — wraps the Claude Agent SDK client with session
management and a clean async iterator interface.

Design:
- One AgentRunner instance ↔ one logical session.
- The SDK handles MCP wiring, tool-use loops, and conversation memory.
- We yield typed events (assistant tokens, tool calls, completion) so
  the API layer can stream them as SSE.
- Tracks the sources cited so the API can return a structured citation
  list separate from the prose answer.

Note on session persistence:
ClaudeSDKClient keeps in-memory conversation state for the lifetime of
the context manager. For real multi-turn over HTTP, an instance must
be kept alive between requests (e.g. in a process-local dict keyed by
session_id) OR the conversation must be re-hydrated from a transcript
each turn. We do the former in the API layer for simplicity; the
latter is documented as the production move in the README.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

from docs_agent.agent.system_prompt import SYSTEM_PROMPT
from docs_agent.agent.tools import ALLOWED_TOOLS, build_mcp_server
from docs_agent.config import get_settings


@dataclass
class AgentEvent:
    """Typed event surfaced to the API layer."""

    kind: str  # "text" | "tool_use" | "done" | "error"
    text: str | None = None
    tool_name: str | None = None
    tool_input: dict[str, Any] | None = None
    error: str | None = None


class AgentRunner:
    """One runner per session. Holds the ClaudeSDKClient open across turns."""

    def __init__(self) -> None:
        settings = get_settings()
        self._options = ClaudeAgentOptions(
            model=settings.anthropic_agent_model,
            system_prompt=SYSTEM_PROMPT,
            mcp_servers={"docs-agent": build_mcp_server()},
            allowed_tools=ALLOWED_TOOLS,
            # Conservative default; the agent rarely needs more loops
            # than this for a single Q&A turn.
            max_turns=8,
        )
        self._client: ClaudeSDKClient | None = None
        self._lock = asyncio.Lock()

    async def __aenter__(self) -> AgentRunner:
        self._client = ClaudeSDKClient(options=self._options)
        await self._client.__aenter__()
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        if self._client:
            await self._client.__aexit__(*exc_info)
            self._client = None

    async def ask(self, user_message: str) -> AsyncIterator[AgentEvent]:
        """Send a user turn and stream the agent's response as events."""
        if self._client is None:
            raise RuntimeError("AgentRunner must be used as an async context manager")

        # Serialize concurrent calls on the same session. The SDK isn't
        # designed for concurrent in-flight turns on one client.
        async with self._lock:
            await self._client.query(user_message)

            async for message in self._client.receive_response():
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            yield AgentEvent(kind="text", text=block.text)
                        elif isinstance(block, ToolUseBlock):
                            yield AgentEvent(
                                kind="tool_use",
                                tool_name=block.name,
                                tool_input=block.input,
                            )
                elif isinstance(message, ResultMessage):
                    # ResultMessage terminates the response stream.
                    yield AgentEvent(kind="done")
                    return
