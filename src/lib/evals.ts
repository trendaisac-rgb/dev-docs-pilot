// Eval dashboard data layer.
//
// Reads the `eval_runs` / `eval_results` tables — written by the Python
// eval harness in `api/` — directly via Supabase's PostgREST endpoint,
// using the public anon key. An anon-only SELECT RLS policy gates this;
// the harness writes with the service role, which bypasses RLS.
//
// No `@supabase/supabase-js` dependency needed — PostgREST is just REST.

import { SUPABASE_URL, SUPABASE_HEADERS } from "@/lib/config";

const REST_BASE = `${SUPABASE_URL}/rest/v1`;

export type EvalRun = {
  id: string;
  agent_model: string;
  judge_model: string;
  dataset_name: string;
  num_questions: number;
  precision_at_5: number | null;
  recall_at_5: number | null;
  mrr: number | null;
  avg_faithfulness: number | null;
  avg_completeness: number | null;
  avg_citation_ok: number | null;
  hallucination_rate: number | null;
  notes: string | null;
  created_at: string;
};

export type JudgeScores = {
  rationale?: string;
  completeness?: number;
  faithfulness?: number;
  hallucination?: boolean;
  citation_correctness?: number;
};

export type EvalResult = {
  id: string;
  run_id: string;
  question: string;
  expected_urls: string[];
  retrieved_urls: string[];
  precision_at_k: number | null;
  recall_at_k: number | null;
  answer: string | null;
  judge_scores: JudgeScores | null;
  judge_notes: string | null;
  latency_ms: number | null;
  created_at: string;
};

// PostgREST returns `numeric` columns as strings — coerce defensively.
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${REST_BASE}/${path}`, {
    headers: { ...SUPABASE_HEADERS, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Supabase REST ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export type EvalReport = { run: EvalRun; results: EvalResult[] };

/**
 * Fetch the most recent eval run and all of its per-question results.
 * Returns null when no eval has been recorded yet.
 */
export async function fetchLatestEvalReport(): Promise<EvalReport | null> {
  const runs = await getJson<Record<string, unknown>[]>(
    "eval_runs?select=*&order=created_at.desc&limit=1",
  );
  if (runs.length === 0) return null;
  const raw = runs[0];
  const run: EvalRun = {
    id: String(raw.id),
    agent_model: String(raw.agent_model ?? ""),
    judge_model: String(raw.judge_model ?? ""),
    dataset_name: String(raw.dataset_name ?? ""),
    num_questions: num(raw.num_questions) ?? 0,
    precision_at_5: num(raw.precision_at_5),
    recall_at_5: num(raw.recall_at_5),
    mrr: num(raw.mrr),
    avg_faithfulness: num(raw.avg_faithfulness),
    avg_completeness: num(raw.avg_completeness),
    avg_citation_ok: num(raw.avg_citation_ok),
    hallucination_rate: num(raw.hallucination_rate),
    notes: raw.notes ? String(raw.notes) : null,
    created_at: String(raw.created_at),
  };

  const rawResults = await getJson<Record<string, unknown>[]>(
    `eval_results?select=*&run_id=eq.${run.id}&order=created_at.asc`,
  );
  const results: EvalResult[] = rawResults.map((r) => ({
    id: String(r.id),
    run_id: String(r.run_id),
    question: String(r.question ?? ""),
    expected_urls: Array.isArray(r.expected_urls)
      ? (r.expected_urls as string[])
      : [],
    retrieved_urls: Array.isArray(r.retrieved_urls)
      ? (r.retrieved_urls as string[])
      : [],
    precision_at_k: num(r.precision_at_k),
    recall_at_k: num(r.recall_at_k),
    answer: r.answer ? String(r.answer) : null,
    judge_scores: (r.judge_scores as JudgeScores) ?? null,
    judge_notes: r.judge_notes ? String(r.judge_notes) : null,
    latency_ms: num(r.latency_ms),
    created_at: String(r.created_at),
  }));

  return { run, results };
}
