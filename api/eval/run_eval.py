"""Eval runner — loops the dataset, calls the agent, scores everything,
writes a Markdown report + persists to Supabase.

Usage:
    uv run python -m eval.run_eval
    uv run python -m eval.run_eval --dataset eval/dataset.json --no-persist

Output:
    eval/runs/<timestamp>/report.md
    eval/runs/<timestamp>/raw.json
    eval_runs row in Supabase (unless --no-persist)
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from statistics import mean

import typer
from rich.console import Console
from rich.table import Table

from docs_agent.agent.runner import AgentRunner
from docs_agent.config import get_settings
from docs_agent.db import get_client
from docs_agent.retrieval.vector_search import search
from eval.judge import JudgeScore, judge
from eval.metrics import mean_reciprocal_rank, precision_at_k, recall_at_k

app = typer.Typer(add_completion=False, no_args_is_help=False)
console = Console()

# Match markdown links: [text](url). Used to extract citations from
# the agent's answer for retrieval-precision scoring.
_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")


@dataclass
class ItemResult:
    id: str
    question: str
    expected_urls: list[str]
    retrieved_urls: list[str]
    cited_urls: list[str]
    precision_at_5: float
    recall_at_5: float
    mrr: float
    answer: str
    judge: JudgeScore
    latency_ms: int
    tool_calls: int


def _extract_citations(answer: str) -> list[str]:
    """Pull URLs out of inline markdown links + the Sources block."""
    return [m.group(2) for m in _LINK_RE.finditer(answer)]


async def _run_one(item: dict, *, top_k: int = 5) -> ItemResult:
    """Run a single Q/A item through retrieval + agent + judge."""
    qid = item["id"]
    question = item["question"]
    expected = item["expected_urls"]
    gt = item["ground_truth"]

    t0 = time.perf_counter()

    # ── Direct retrieval (for precision/recall@k that doesn't depend on
    #    whether the agent decided to call the tool or not). This is the
    #    "naive" retrieval score — the agent may improve on it via
    #    multiple search calls + rerank.
    chunks = await search(question, top_k=top_k)
    retrieved_urls = [c.url for c in chunks]

    # ── Agent invocation (fresh session per question — no state leak)
    answer_parts: list[str] = []
    tool_calls = 0
    async with AgentRunner() as runner:
        async for ev in runner.ask(question):
            if ev.kind == "text" and ev.text:
                answer_parts.append(ev.text)
            elif ev.kind == "tool_use":
                tool_calls += 1
            elif ev.kind == "done":
                break

    answer = "".join(answer_parts).strip()
    cited_urls = _extract_citations(answer)
    latency_ms = int((time.perf_counter() - t0) * 1000)

    # ── Metrics on raw retrieval (the harder, less forgiving signal)
    p5 = precision_at_k(retrieved_urls, expected, k=top_k)
    r5 = recall_at_k(retrieved_urls, expected, k=top_k)
    mrr = mean_reciprocal_rank(retrieved_urls, expected)

    # ── LLM-as-judge on the agent's actual answer
    score = await judge(
        question=question,
        ground_truth=gt,
        expected_urls=expected,
        answer=answer,
    )

    return ItemResult(
        id=qid,
        question=question,
        expected_urls=expected,
        retrieved_urls=retrieved_urls,
        cited_urls=cited_urls,
        precision_at_5=p5,
        recall_at_5=r5,
        mrr=mrr,
        answer=answer,
        judge=score,
        latency_ms=latency_ms,
        tool_calls=tool_calls,
    )


def _render_report(
    dataset_name: str,
    results: list[ItemResult],
    agent_model: str,
    judge_model: str,
) -> str:
    aggr = {
        "precision_at_5": mean(r.precision_at_5 for r in results),
        "recall_at_5": mean(r.recall_at_5 for r in results),
        "mrr": mean(r.mrr for r in results),
        "faithfulness": mean(r.judge.faithfulness for r in results),
        "completeness": mean(r.judge.completeness for r in results),
        "citation_correctness": mean(r.judge.citation_correctness for r in results),
        "hallucination_rate": sum(1 for r in results if r.judge.hallucination) / len(results),
        "avg_latency_ms": mean(r.latency_ms for r in results),
        "avg_tool_calls": mean(r.tool_calls for r in results),
    }

    lines: list[str] = []
    lines.append(f"# Eval report — {dataset_name}")
    lines.append("")
    lines.append(f"- Generated: `{datetime.utcnow().isoformat(timespec='seconds')}Z`")
    lines.append(f"- Agent model: `{agent_model}`")
    lines.append(f"- Judge model: `{judge_model}`")
    lines.append(f"- Questions: **{len(results)}**")
    lines.append("")

    lines.append("## Aggregate scores")
    lines.append("")
    lines.append("| Metric | Score |")
    lines.append("|---|---|")
    lines.append(f"| Precision@5 (retrieval) | **{aggr['precision_at_5']:.3f}** |")
    lines.append(f"| Recall@5 (retrieval) | **{aggr['recall_at_5']:.3f}** |")
    lines.append(f"| MRR (retrieval) | **{aggr['mrr']:.3f}** |")
    lines.append(f"| Faithfulness (judge) | **{aggr['faithfulness']:.3f}** |")
    lines.append(f"| Completeness (judge) | **{aggr['completeness']:.3f}** |")
    lines.append(f"| Citation correctness (judge) | **{aggr['citation_correctness']:.3f}** |")
    lines.append(f"| Hallucination rate | **{aggr['hallucination_rate']:.3f}** |")
    lines.append(f"| Avg latency (ms) | {aggr['avg_latency_ms']:.0f} |")
    lines.append(f"| Avg tool calls/turn | {aggr['avg_tool_calls']:.2f} |")
    lines.append("")

    # Failure shortlist — sort by composite failure score so the
    # interesting cases land at the top.
    def fail_score(r: ItemResult) -> float:
        j = r.judge
        return (
            (1 - j.faithfulness)
            + (1 - j.completeness)
            + (1 - j.citation_correctness)
            + (0.5 if j.hallucination else 0)
        )

    sorted_results = sorted(results, key=fail_score, reverse=True)

    lines.append("## Failure analysis (worst → best)")
    lines.append("")
    for r in sorted_results:
        j = r.judge
        flag = "🚨" if j.hallucination else ("⚠️" if fail_score(r) > 0.5 else "✅")
        lines.append(f"### {flag} {r.id} — {r.question}")
        lines.append("")
        lines.append(
            f"- **Retrieval**: precision@5={r.precision_at_5:.2f} · "
            f"recall@5={r.recall_at_5:.2f} · MRR={r.mrr:.2f} · "
            f"tool_calls={r.tool_calls} · {r.latency_ms} ms"
        )
        lines.append(
            f"- **Judge**: faith={j.faithfulness:.2f} · comp={j.completeness:.2f} · "
            f"cite={j.citation_correctness:.2f} · "
            f"hallucination={'YES' if j.hallucination else 'no'}"
        )
        lines.append(f"- **Rationale**: {j.rationale}")
        lines.append("")
        lines.append("<details><summary>Expected vs cited URLs</summary>")
        lines.append("")
        lines.append("**Expected:**")
        for u in r.expected_urls:
            lines.append(f"- `{u}`")
        lines.append("")
        lines.append("**Retrieved (top 5):**")
        for u in r.retrieved_urls[:5]:
            lines.append(f"- `{u}`")
        lines.append("")
        lines.append("**Cited in answer:**")
        for u in r.cited_urls:
            lines.append(f"- `{u}`")
        lines.append("")
        lines.append("</details>")
        lines.append("")
        lines.append("<details><summary>Full answer</summary>")
        lines.append("")
        lines.append("```markdown")
        lines.append(r.answer or "(empty)")
        lines.append("```")
        lines.append("")
        lines.append("</details>")
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines), aggr


async def _persist(
    *,
    dataset_name: str,
    agent_model: str,
    judge_model: str,
    aggr: dict,
    results: list[ItemResult],
) -> str | None:
    client = get_client()
    run = (
        client.table("eval_runs")
        .insert(
            {
                "agent_model": agent_model,
                "judge_model": judge_model,
                "dataset_name": dataset_name,
                "num_questions": len(results),
                "precision_at_5": round(aggr["precision_at_5"], 3),
                "recall_at_5": round(aggr["recall_at_5"], 3),
                "mrr": round(aggr["mrr"], 3),
                "avg_faithfulness": round(aggr["faithfulness"], 3),
                "avg_completeness": round(aggr["completeness"], 3),
                "avg_citation_ok": round(aggr["citation_correctness"], 3),
                "hallucination_rate": round(aggr["hallucination_rate"], 3),
            }
        )
        .execute()
    )
    run_id = run.data[0]["id"] if run.data else None
    if not run_id:
        return None

    rows = [
        {
            "run_id": run_id,
            "question": r.question,
            "expected_urls": r.expected_urls,
            "retrieved_urls": r.retrieved_urls,
            "precision_at_k": round(r.precision_at_5, 3),
            "recall_at_k": round(r.recall_at_5, 3),
            "answer": r.answer,
            "judge_scores": r.judge.to_dict(),
            "judge_notes": r.judge.rationale,
            "latency_ms": r.latency_ms,
        }
        for r in results
    ]
    if rows:
        client.table("eval_results").insert(rows).execute()
    return run_id


async def _main(dataset_path: Path, persist: bool, top_k: int) -> None:
    settings = get_settings()
    data = json.loads(dataset_path.read_text())
    items = data["items"]
    dataset_name = data["name"]

    console.print(f"[bold]Running eval[/bold] · {dataset_name} · {len(items)} items")
    console.print(f"  agent: [cyan]{settings.anthropic_agent_model}[/cyan]")
    console.print(f"  judge: [cyan]{settings.anthropic_judge_model}[/cyan]\n")

    results: list[ItemResult] = []
    for i, item in enumerate(items, start=1):
        console.print(f"  [{i}/{len(items)}] {item['id']} · {item['question'][:60]}…")
        try:
            r = await _run_one(item, top_k=top_k)
            results.append(r)
            console.print(
                f"      faith={r.judge.faithfulness:.2f} "
                f"comp={r.judge.completeness:.2f} "
                f"cite={r.judge.citation_correctness:.2f} "
                f"{'🚨' if r.judge.hallucination else '✓'} · "
                f"{r.latency_ms} ms · {r.tool_calls} tool calls"
            )
        except Exception as e:
            console.print(f"      [red]ERROR:[/red] {e}")
            continue

    if not results:
        console.print("[red]No results produced.[/red]")
        return

    # ── Report
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    out_dir = Path("eval/runs") / timestamp
    out_dir.mkdir(parents=True, exist_ok=True)

    report_md, aggr = _render_report(
        dataset_name=dataset_name,
        results=results,
        agent_model=settings.anthropic_agent_model,
        judge_model=settings.anthropic_judge_model,
    )
    (out_dir / "report.md").write_text(report_md)
    (out_dir / "raw.json").write_text(
        json.dumps(
            [{**asdict(r), "judge": r.judge.to_dict()} for r in results],
            indent=2,
        )
    )

    # ── Console summary
    table = Table(title="Aggregate")
    table.add_column("Metric")
    table.add_column("Score", justify="right")
    table.add_row("Precision@5", f"{aggr['precision_at_5']:.3f}")
    table.add_row("Recall@5", f"{aggr['recall_at_5']:.3f}")
    table.add_row("MRR", f"{aggr['mrr']:.3f}")
    table.add_row("Faithfulness", f"{aggr['faithfulness']:.3f}")
    table.add_row("Completeness", f"{aggr['completeness']:.3f}")
    table.add_row("Citation OK", f"{aggr['citation_correctness']:.3f}")
    table.add_row("Hallucination rate", f"{aggr['hallucination_rate']:.3f}")
    console.print(table)
    console.print(f"\n[green]Report:[/green] {out_dir / 'report.md'}")

    # ── Persist
    if persist:
        try:
            run_id = await _persist(
                dataset_name=dataset_name,
                agent_model=settings.anthropic_agent_model,
                judge_model=settings.anthropic_judge_model,
                aggr=aggr,
                results=results,
            )
            if run_id:
                console.print(f"[green]Persisted to eval_runs:[/green] {run_id}")
        except Exception as e:
            console.print(f"[yellow]Persistence skipped (DB error): {e}[/yellow]")


@app.command()
def main(
    dataset: Path = typer.Option(Path("eval/dataset.json"), "--dataset"),
    no_persist: bool = typer.Option(False, "--no-persist"),
    top_k: int = typer.Option(5, "--top-k"),
) -> None:
    """Run the eval suite end-to-end."""
    asyncio.run(_main(dataset, persist=not no_persist, top_k=top_k))


if __name__ == "__main__":
    app()
