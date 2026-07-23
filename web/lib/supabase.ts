import { createClient } from "@supabase/supabase-js";

// Public, read-only client (anon key). RLS grants SELECT on v_master / v_new_high and the
// base tables; there are no write policies for anon. Triage writes (Phase 4) go through a
// server API route with the service role — never from here.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, anon, {
  auth: { persistSession: false },
});
