// Supabase connection config for the docs-agent chat Edge Function.
//
// The anon key is a *public* key by design — it's safe to ship in the
// browser bundle. It only grants access governed by RLS policies, and
// the chat Edge Function runs with verify_jwt=false so the anon key is
// just the Supabase API gateway pass. The service-role key NEVER leaves
// the Edge Function runtime.
//
// Project: "Interview" (qonbpdqlkfsiosdkzjtf)

export const SUPABASE_URL = "https://qonbpdqlkfsiosdkzjtf.supabase.co";

export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvbmJwZHFsa2ZzaW9zZGt6anRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1OTYzMDEsImV4cCI6MjA5NDE3MjMwMX0.S_hD1Bh5rG8ocuWDqY_HCLMGSTuI-tawgsPXrpmUU1E";

// Base for Edge Functions — the chat function lives at `${FUNCTIONS_BASE}/chat`.
export const FUNCTIONS_BASE = `${SUPABASE_URL}/functions/v1`;

// Headers every Edge Function request needs. Even with verify_jwt=false,
// the Supabase gateway requires the apikey header to route the request.
export const SUPABASE_HEADERS: Record<string, string> = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};
