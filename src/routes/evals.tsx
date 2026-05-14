import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts";
import { fetchLatestEvalReport, type EvalResult } from "@/lib/evals";

export const Route = createFileRoute("/evals")({
  component: EvalsPage,
  head: () => ({
    meta: [
      { title: "docs-agent — evaluation dashboard" },
      {
        name: "description",
        content:
          "Retrieval and answer-quality metrics for the docs-agent RAG pipeline.",
      },
    ],
  }),
});

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v * 100)}%`;
}

function EvalsPage() {
  // The dashboard mirrors the chat app's dark theme.
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  const { data, isLoading, error } = useQuery({
    queryKey: ["eval-report"],
    queryFn: fetchLatestEvalReport,
    staleTime: 60_000,
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/80 px-5 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="font-mono">docs-agent</span>
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-sm font-medium">Evaluation</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1100px] px-6 py-8">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading the latest eval run…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              Couldn't load eval data.
              <div className="mt-1 font-mono text-xs opacity-80">
                {(error as Error).message}
              </div>
            </div>
          </div>
        )}

        {!isLoading && !error && !data && (
          <div className="rounded-lg border border-dashed border-border px-6 py-16 text-center text-sm text-muted-foreground">
            No eval runs recorded yet. Run the harness in <code>api/</code> to
            populate this dashboard.
          </div>
        )}

        {data && <Report report={data} />}
      </main>
    </div>
  );
}

function Report({ report }: { report: NonNullable<Awaited<ReturnType<typeof fetchLatestEvalReport>>> }) {
  const { run, results } = report;
  const date = new Date(run.created_at).toLocaleString();

  return (
    <div className="space-y-8">
      {/* Run header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Evaluation dashboard
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Latest run over the{" "}
          <span className="font-mono text-foreground">{run.dataset_name}</span>{" "}
          dataset · {run.num_questions} questions · {date}
        </p>
        <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="rounded border border-border bg-muted/40 px-2 py-0.5">
            agent: {run.agent_model}
          </span>
          <span className="rounded border border-border bg-muted/40 px-2 py-0.5">
            judge: {run.judge_model}
          </span>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi
          label="Precision@5"
          value={pct(run.precision_at_5)}
          hint="retrieved chunks that were relevant"
        />
        <Kpi
          label="Recall@5"
          value={pct(run.recall_at_5)}
          hint="expected docs that were found"
        />
        <Kpi
          label="MRR"
          value={run.mrr !== null ? run.mrr.toFixed(2) : "—"}
          hint="mean reciprocal rank of first hit"
        />
        <Kpi
          label="Faithfulness"
          value={pct(run.avg_faithfulness)}
          hint="answer grounded in retrieved docs"
        />
        <Kpi
          label="Completeness"
          value={pct(run.avg_completeness)}
          hint="answer covers the question"
        />
        <Kpi
          label="Citation OK"
          value={pct(run.avg_citation_ok)}
          hint="citations point to the right docs"
        />
      </div>

      {/* Per-question chart */}
      <section>
        <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Retrieval quality per question
        </h2>
        <div className="rounded-lg border border-border bg-card p-4">
          <PerQuestionChart results={results} />
        </div>
      </section>

      {/* Per-question table */}
      <section>
        <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Per-question detail
        </h2>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Question</th>
                <th className="px-3 py-2 text-right font-medium">P@k</th>
                <th className="px-3 py-2 text-right font-medium">R@k</th>
                <th className="px-3 py-2 text-right font-medium">Faith.</th>
                <th className="px-3 py-2 text-right font-medium">Cite</th>
                <th className="px-3 py-2 text-center font-medium">Halluc.</th>
                <th className="px-3 py-2 text-right font-medium">Latency</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <ResultRow key={r.id} result={r} index={i + 1} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] leading-snug text-muted-foreground/70">
        {hint}
      </div>
    </div>
  );
}

function PerQuestionChart({ results }: { results: EvalResult[] }) {
  const chartData = results.map((r, i) => ({
    name: `Q${i + 1}`,
    precision: r.precision_at_k ?? 0,
    recall: r.recall_at_k ?? 0,
    faithfulness: r.judge_scores?.faithfulness ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          stroke="var(--border)"
        />
        <YAxis
          domain={[0, 1]}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          stroke="var(--border)"
        />
        <Tooltip
          contentStyle={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: "var(--foreground)" }}
          formatter={(v: number) => v.toFixed(2)}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="precision" name="Precision@k" fill="var(--primary)" radius={[2, 2, 0, 0]} />
        <Bar dataKey="recall" name="Recall@k" fill="var(--muted-foreground)" radius={[2, 2, 0, 0]} />
        <Bar dataKey="faithfulness" name="Faithfulness" radius={[2, 2, 0, 0]}>
          {chartData.map((d, i) => (
            <Cell
              key={i}
              fill={
                d.faithfulness >= 0.8
                  ? "oklch(0.7 0.16 150)"
                  : d.faithfulness >= 0.6
                    ? "oklch(0.78 0.15 80)"
                    : "var(--destructive)"
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function Score({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined)
    return <span className="text-muted-foreground/50">—</span>;
  const tone =
    v >= 0.8
      ? "text-[oklch(0.7_0.16_150)]"
      : v >= 0.5
        ? "text-foreground"
        : "text-destructive";
  return <span className={`tabular-nums ${tone}`}>{v.toFixed(2)}</span>;
}

function ResultRow({ result: r, index }: { result: EvalResult; index: number }) {
  const [open, setOpen] = useState(false);
  const halluc = r.judge_scores?.hallucination === true;

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/30"
        onClick={() => setOpen((v) => !v)}
      >
        <td className="px-3 py-2 font-mono text-xs text-muted-foreground tabular-nums">
          {index}
        </td>
        <td className="max-w-[320px] px-3 py-2">
          <span className="line-clamp-1">{r.question}</span>
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs">
          <Score v={r.precision_at_k} />
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs">
          <Score v={r.recall_at_k} />
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs">
          <Score v={r.judge_scores?.faithfulness} />
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs">
          <Score v={r.judge_scores?.citation_correctness} />
        </td>
        <td className="px-3 py-2 text-center">
          {halluc ? (
            <XCircle className="inline h-3.5 w-3.5 text-destructive" />
          ) : (
            <CheckCircle2 className="inline h-3.5 w-3.5 text-[oklch(0.7_0.16_150)]" />
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground tabular-nums">
          {r.latency_ms !== null ? `${(r.latency_ms / 1000).toFixed(1)}s` : "—"}
        </td>
        <td className="px-3 py-2 text-muted-foreground">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-muted/20 last:border-0">
          <td colSpan={9} className="px-3 py-3">
            <div className="space-y-3 text-xs">
              {r.judge_scores?.rationale && (
                <div>
                  <div className="mb-1 font-mono uppercase tracking-wider text-muted-foreground">
                    Judge rationale
                  </div>
                  <p className="leading-relaxed text-foreground/90">
                    {r.judge_scores.rationale}
                  </p>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <UrlList label="Expected docs" urls={r.expected_urls} />
                <UrlList label="Retrieved docs" urls={r.retrieved_urls} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function UrlList({ label, urls }: { label: string; urls: string[] }) {
  return (
    <div>
      <div className="mb-1 font-mono uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {urls.length === 0 ? (
        <div className="text-muted-foreground/50">none</div>
      ) : (
        <ul className="space-y-0.5">
          {urls.map((u, i) => (
            <li key={`${u}-${i}`}>
              <a
                href={u}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-muted-foreground transition-colors hover:text-primary"
              >
                {u.replace("https://platform.claude.com/docs/en/", "…/")}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
