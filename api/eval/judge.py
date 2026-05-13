"""LLM-as-judge for answer quality.

Rubric (all 0..1, judged independently):
  - faithfulness:        does the answer stay within what the docs actually say?
  - completeness:        does the answer address the user's actual question?
  - citation_correctness: are the citations real, and do they support the claims?
  - hallucination:       a binary flag (1 = something made up beyond the docs)

Why per-axis scores instead of one "quality" score:
- Aggregate scores hide the failure mode. "Quality 0.6" tells you nothing
  about whether your retriever is missing answers or your prompt is letting
  the model invent. Per-axis lets us point at the cause.
- They also map directly to the anti-hallucination rules in the system
  prompt, so a regression in `faithfulness` is a clear signal to revisit
  AH-1..AH-6.

Model: claude-haiku-4-5 by default — cheap, fast, plenty accurate for
judging factuality against a ground truth + retrieved context.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from anthropic import AsyncAnthropic

from docs_agent.config import get_settings

JUDGE_SYSTEM = """You are an evaluator for a Q&A system over Anthropic's documentation.

You will receive:
  - The user's QUESTION
  - The GROUND TRUTH (a known-correct one-sentence summary of the answer)
  - The EXPECTED CITATION URLs (the canonical docs pages)
  - The AGENT'S ANSWER (a markdown response, may include inline links and a Sources block)

Score the agent's answer on FOUR axes, each independently:

1. **faithfulness** (0.0–1.0):
   Is every factual claim in the answer supported by the ground truth (or a reasonable
   superset that doesn't contradict it)? Penalise inventions, even plausible-sounding ones.
   1.0 = all claims supported · 0.5 = partially supported with extra invention · 0.0 = wrong/invented.

2. **completeness** (0.0–1.0):
   Does the answer address the actual question? Penalise partial answers, off-topic
   answers, and answers that punt to clarifiers when a direct answer was possible.
   1.0 = fully addresses · 0.5 = partial · 0.0 = off-topic or no-answer when answer existed.

3. **citation_correctness** (0.0–1.0):
   Do the citation URLs in the answer match the EXPECTED CITATION URLs (path-level,
   anchors don't matter)? Penalise: missing citations, inventing URLs, citing the
   wrong doc.
   1.0 = correct & complete · 0.5 = partial overlap · 0.0 = wrong or missing entirely.

4. **hallucination** (boolean):
   Did the agent state any specific fact (number, name, parameter, behaviour) that is
   NOT in the ground truth and NOT a generic safe statement? Strict: when in doubt, mark true.
   true = hallucinated · false = clean.

Output ONLY a JSON object, no commentary, no markdown:
{
  "faithfulness": 0.95,
  "completeness": 0.90,
  "citation_correctness": 1.00,
  "hallucination": false,
  "rationale": "<one-sentence summary of the call>"
}
"""


@dataclass
class JudgeScore:
    faithfulness: float
    completeness: float
    citation_correctness: float
    hallucination: bool
    rationale: str

    def to_dict(self) -> dict[str, object]:
        return {
            "faithfulness": self.faithfulness,
            "completeness": self.completeness,
            "citation_correctness": self.citation_correctness,
            "hallucination": self.hallucination,
            "rationale": self.rationale,
        }


_client: AsyncAnthropic | None = None


def _anthropic() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(api_key=get_settings().anthropic_api_key)
    return _client


async def judge(
    *,
    question: str,
    ground_truth: str,
    expected_urls: list[str],
    answer: str,
) -> JudgeScore:
    settings = get_settings()
    user_payload = (
        f"QUESTION:\n{question}\n\n"
        f"GROUND TRUTH:\n{ground_truth}\n\n"
        f"EXPECTED CITATION URLs:\n{json.dumps(expected_urls, indent=2)}\n\n"
        f"AGENT'S ANSWER:\n{answer}"
    )

    res = await _anthropic().messages.create(
        model=settings.anthropic_judge_model,
        max_tokens=400,
        temperature=0,
        system=JUDGE_SYSTEM,
        messages=[{"role": "user", "content": user_payload}],
    )
    raw = res.content[0].text if res.content else "{}"
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```")

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # Fail-open: degenerate score so the run still finishes, but
        # surfaced clearly in the report.
        return JudgeScore(
            faithfulness=0.0,
            completeness=0.0,
            citation_correctness=0.0,
            hallucination=True,
            rationale=f"Judge produced unparseable output: {raw[:200]}",
        )

    return JudgeScore(
        faithfulness=float(parsed.get("faithfulness", 0.0)),
        completeness=float(parsed.get("completeness", 0.0)),
        citation_correctness=float(parsed.get("citation_correctness", 0.0)),
        hallucination=bool(parsed.get("hallucination", False)),
        rationale=str(parsed.get("rationale", "")),
    )
